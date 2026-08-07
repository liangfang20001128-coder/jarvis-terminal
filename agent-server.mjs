// 贾维斯终端 · 本地智能体桥接服务
// 用法：node agent-server.mjs
// 环境变量：
//   JARVIS_PORT  （默认 8787）
//   JARVIS_AGENT （auto | codex | fallback，默认 auto：CLI 可用即用 Codex）
//   CODEX_BIN    （Codex CLI 路径，默认 ChatGPT.app 内置）
//   OPENAI_API_KEY / JARVIS_OPENAI_BASE_URL / JARVIS_OPENAI_MODEL
//                 （云端对话：兼容 OpenAI / DeepSeek 等 OpenAI 协议服务；
//                  设置 JARVIS_OPENAI_BASE_URL=https://api.deepseek.com/v1
//                  与 JARVIS_OPENAI_MODEL=deepseek-chat 即切换 DeepSeek）
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.JARVIS_PORT || 8787);
const AGENT_MODE = process.env.JARVIS_AGENT || "auto";
const CODEX_BIN =
  process.env.CODEX_BIN ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const MODULES = ["chat", "hot", "ai", "habit", "media", "space", "fate"];

const SYSTEM_PROMPT = `你是「贾维斯」，钢铁侠的智能管家，运行在用户的全息终端里。
语言：中文。风格：简洁、机敏、带一点从容的幽默。称呼用户为「先生」。
你只负责对话与决策，不调用任何工具、不执行任何命令、不访问文件系统。
你可以操控终端模块。当用户要求打开/切换某个模块时，在你的回复末尾单独输出一行：
[[module:模式ID]]
模式ID 只能是：chat（对话）、hot（全球热点）、ai（AI 模型）、habit（行为洞察）、media（影音）、space（空间）、fate（时运）。
例如用户说“打开音乐”，你回复一句台词后输出 [[module:media]]。
如果没有模块操作需求，不要输出该标记。
`;

function codexAvailable() {
  return existsSync(CODEX_BIN);
}

function htmlDecode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
    const link = (b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || "";
    const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    if (title) items.push({ title: htmlDecode(title).trim(), link, pub });
  }
  return items;
}

function parseAtom(xml) {
  const items = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const link = (b.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
    const pub = (b.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || "";
    const summary = (b.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
    if (title) {
      items.push({
        title: htmlDecode(title).replace(/\s+/g, " ").trim(),
        link,
        pub,
        summary: htmlDecode(summary).replace(/\s+/g, " ").trim().slice(0, 200),
      });
    }
  }
  return items;
}

async function fetchWithTimeout(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, {
      signal: c.signal,
      headers: { "User-Agent": "JarvisTerminal/1.0" },
    });
  } finally {
    clearTimeout(t);
  }
}

const hotCache = { at: 0, data: null };
async function getHot() {
  if (hotCache.data && Date.now() - hotCache.at < 60000) return hotCache.data;
  const out = [];
  const sources = [
    { url: "https://36kr.com/feed", cat: "科技", name: "36氪" },
    { url: "https://sspai.com/feed", cat: "数码", name: "少数派" },
    { url: "https://www.thepaper.cn/rss", cat: "时政", name: "澎湃" },
  ];
  for (const s of sources) {
    try {
      const r = await fetchWithTimeout(s.url);
      const xml = await r.text();
      let items = parseRSS(xml);
      if (!items.length) items = parseAtom(xml);
      for (const it of items) {
        const dash = it.title.lastIndexOf(" - ");
        const source = s.name;
        const title = dash > 0 ? it.title.slice(0, dash) : it.title;
        if (title) out.push({ title, source, link: it.link, pub: it.pub, cat: s.cat });
      }
    } catch (e) {
      /* 单源失败不影响整体 */
    }
  }
  try {
    const r = await fetchWithTimeout(
      "https://hn.algolia.com/api/v1/search?query=AI%20OR%20LLM%20OR%20GPT&tags=story&hitsPerPage=12",
      10000
    );
    const j = await r.json();
    for (const hit of j.hits || []) {
      if (!hit.title) continue;
      out.push({
        title: hit.title,
        source: "Hacker News",
        link: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        pub: hit.created_at || "",
        cat: "国际AI",
      });
    }
  } catch (e) {
    /* 国际源失败可接受 */
  }
  const seen = new Set();
  const res = [];
  for (const it of out) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    res.push(it);
  }
  hotCache.data = res.slice(0, 15);
  hotCache.at = Date.now();
  return hotCache.data;
}

const aiCache = { at: 0, data: null };
async function getAi() {
  if (aiCache.data && Date.now() - aiCache.at < 600000) return aiCache.data;
  const out = [];
  try {
    const url =
      "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=8";
    const r = await fetchWithTimeout(url, 12000);
    const xml = await r.text();
    out.push({ kind: "paper", items: parseAtom(xml) });
  } catch (e) {
    out.push({ kind: "paper", items: [], error: String(e.message || e) });
  }
  try {
    const r = await fetchWithTimeout("https://huggingface.co/api/trending", 10000);
    const j = await r.json();
    const seen = new Set();
    const items = [];
    for (const key of ["trendingScore", "recentlyCreated", "mostDownloads"]) {
      const arr = j[key] || [];
      for (const it of arr) {
        const id = it && it.repoData && it.repoData.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({
          id,
          downloads: it.repoData.downloads || 0,
          likes: it.repoData.likes || 0,
          tags: (it.repoData.tags || []).slice(0, 3),
        });
      }
    }
    out.push({ kind: "model", items: items.slice(0, 10) });
  } catch (e) {
    out.push({ kind: "model", items: [], error: String(e.message || e) });
  }
  aiCache.data = out;
  aiCache.at = Date.now();
  return out;
}

async function getWorkspace() {
  const fs = await import("node:fs/promises");
  const root = process.cwd();
  const skip = new Set([".git", ".superpowers", "node_modules", ".DS_Store"]);
  const list = [];
  async function walk(dir, depth) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (skip.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (ent.isDirectory() && depth < 1) {
        list.push({ name: ent.name, path: rel, isDir: true, size: 0 });
        await walk(full, depth + 1);
      } else if (!ent.isDirectory()) {
        try {
          const st = await fs.stat(full);
          list.push({ name: ent.name, path: rel, isDir: false, size: st.size });
        } catch (e) {}
      }
    }
  }
  await walk(root, 0);
  return list.slice(0, 50);
}

let launchAllowlist = {};
try {
  launchAllowlist = JSON.parse(process.env.JARVIS_LAUNCH || "{}");
} catch (e) {}

function launchApp(key) {
  const app = launchAllowlist[key];
  if (!app) {
    return Promise.resolve({
      ok: false,
      error: `未授权应用：${key}（请在 JARVIS_LAUNCH 中配置，如 {"微信":"WeChat"}）`,
    });
  }
  return new Promise((resolve) => {
    execFile("open", ["-a", app], (err) => {
      resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true, app });
    });
  });
}

function fallbackReply(text) {
  const t = text.trim();
  const rules = [
    { re: /运势|卦|玄学|农历|老黄历/, mod: "fate", reply: "时运模块已开启：农历、今日卦象与运势都已就绪，先生。" },
    { re: /报时|时间|几点了/, mod: "fate", reply: "现在是系统时间，先生。具体时刻请在时运模块查看。" },
    { re: /热点|新闻|资讯|头条/, mod: "hot", reply: "全球热点已打开，先生。今日有 7 件值得关注的事。" },
    { re: /音乐|影音|视频|播放|投屏/, mod: "media", reply: "影音模块已就绪，先生。队列里有 3 条内容。" },
    { re: /游戏/, mod: "space", reply: "空间模块已打开，游戏登录入口就在里面，先生。" },
    { re: /工作|任务|文档|文件/, mod: "space", reply: "工作空间已就绪，先生。有 3 项任务正在进行。" },
    { re: /AI|模型|token|多模态/, mod: "ai", reply: "AI 模型模块已打开，先生。今日 Token 用量与架构图已更新。" },
    { re: /洞察|专注|行为|习惯/, mod: "habit", reply: "行为洞察已开启，先生。您今日专注 6.4 小时，比昨日提升 18%。" },
    { re: /你好|您好|hi|hello|嗨|在吗/, mod: "chat", reply: "先生，我在。随时听候差遣。" },
  ];
  for (const r of rules) {
    if (r.re.test(t)) return { reply: r.reply, mod: r.mod };
  }
  return {
    reply:
      "先生，这条指令我已收到。当前处于演示模式，启用 Codex 核心后我可以深度对话并直接操控全部模块。",
    mod: null,
  };
}

function runCodex(message) {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `jarvis-codex-${randomUUID()}.txt`);
    const child = execFile(
      CODEX_BIN,
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "read-only",
        "-C",
        process.cwd(),
        "-o",
        out,
      ],
      { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(`${SYSTEM_PROMPT}\n\n用户：${message}`);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `codex exited ${code}`));
      try {
        resolve(readFileSync(out, "utf8"));
      } catch (err) {
        reject(err);
      }
    });
    child.on("error", reject);
  });
}

function apiBase() {
  return (process.env.JARVIS_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function apiModel() {
  return process.env.JARVIS_OPENAI_MODEL || "gpt-4.1-mini";
}

function apiProvider() {
  return /deepseek/i.test(apiBase()) ? "deepseek" : "openai";
}

async function runChatAPI(message) {
  const key = process.env.OPENAI_API_KEY;
  const model = apiModel();
  const r = await fetch(`${apiBase()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      max_tokens: 900,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`大模型 API ${r.status}: ${String(body).slice(0, 240)}`);
  }
  const j = await r.json();
  const text = (((j.choices || [])[0] || {}).message || {}).content;
  const out = String(text || "").trim();
  if (!out) throw new Error("大模型返回为空");
  return out;
}

function chatMode() {
  if (AGENT_MODE === "codex" || (AGENT_MODE === "auto" && codexAvailable())) return "codex";
  if (process.env.OPENAI_API_KEY && (AGENT_MODE === "openai" || AGENT_MODE === "auto")) {
    return apiProvider();
  }
  return "fallback";
}

function parseModule(reply) {
  const m = /\[\[module:(\w+)\]\]/.exec(reply || "");
  return m && MODULES.includes(m[1]) ? m[1] : null;
}

function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/api/status") {
    return json(res, 200, {
      ok: true,
      agent: chatMode(),
      provider: apiProvider(),
      model: apiModel(),
      codexAvailable: codexAvailable(),
      modules: MODULES,
      gameUrl: process.env.JARVIS_GAME_URL || null,
      launchKeys: Object.keys(launchAllowlist),
    });
  }
  if (url.pathname === "/api/hot") {
    try {
      return json(res, 200, { ok: true, items: await getHot() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), items: [] });
    }
  }
  if (url.pathname === "/api/ai") {
    try {
      return json(res, 200, { ok: true, groups: await getAi() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), groups: [] });
    }
  }
  if (url.pathname === "/api/workspace") {
    try {
      return json(res, 200, { ok: true, files: await getWorkspace() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), files: [] });
    }
  }
  if (url.pathname === "/api/launch" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { key } = JSON.parse(body || "{}");
        return json(res, 200, await launchApp(String(key || "")));
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }
  if (url.pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { message, forceFallback } = JSON.parse(body || "{}");
        if (!message || !String(message).trim()) {
          return json(res, 400, { ok: false, error: "message 为空" });
        }
        const useCodex =
          !forceFallback &&
          (AGENT_MODE === "codex" || (AGENT_MODE === "auto" && codexAvailable()));
        const useAPI =
          !forceFallback &&
          !useCodex &&
          process.env.OPENAI_API_KEY &&
          (AGENT_MODE === "openai" || AGENT_MODE === "auto");
        if (useCodex) {
          try {
            const reply = await runCodex(String(message));
            return json(res, 200, {
              ok: true,
              agent: "codex",
              reply,
              mod: parseModule(reply),
            });
          } catch (err) {
            const f = fallbackReply(String(message));
            return json(res, 200, {
              ok: true,
              agent: "fallback",
              degraded: String(err.message || err),
              reply: `${f.reply}\n（Codex 调用失败，已降级为演示路由）`,
              mod: f.mod,
            });
          }
        }
        if (useAPI) {
          try {
            const reply = await runChatAPI(String(message));
            return json(res, 200, {
              ok: true,
              agent: apiProvider(),
              reply,
              mod: parseModule(reply),
            });
          } catch (err) {
            const f = fallbackReply(String(message));
            return json(res, 200, {
              ok: true,
              agent: "fallback",
              degraded: String(err.message || err),
              reply: `${f.reply}\n（云端大模型调用失败，已降级为演示路由）`,
              mod: f.mod,
            });
          }
        }
        const f = fallbackReply(String(message));
        return json(res, 200, {
          ok: true,
          agent: "fallback",
          reply: f.reply,
          mod: f.mod,
        });
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err.message || err) });
      }
    });
    return;
  }
  return json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, process.env.JARVIS_HOST || "0.0.0.0", () => {
  console.log(
    `JARVIS agent bridge ready at http://127.0.0.1:${PORT}  (agent=${chatMode()})`
  );
});
