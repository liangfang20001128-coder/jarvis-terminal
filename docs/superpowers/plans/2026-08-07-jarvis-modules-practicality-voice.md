# 贾维斯模块实用性升级 + 贾维斯音色 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将七个模块接入真实数据与能力（中国社交热点、网页行为分析、个人账号平台直通、本机应用/文件操作、玄学子智能体、B站热榜、OpenRouter 模型目录），并把语音输出调校为贴近《钢铁侠》贾维斯的英式男声。

**Architecture:** 后端 `agent-server.mjs` 新增公开数据代理接口（统一缓存 + 多级回退），前端单文件 `web/index.html` 逐模块升级渲染与交互，新增本地行为追踪器与语音调校系统；农历计算由内置 `web/vendor/lunar.js`（lunar-javascript，MIT）离线完成。

**Tech Stack:** Node.js（无新增依赖）、原生 fetch、HTML/CSS/JS 单页、lunar-javascript（vendor 内联）、Web Speech API、macOS `open`/`say` 能力。

## Global Constraints

- 所有数据接口必须有「主源 → 备用源 → 内置样例」回退；回退时响应带 `fallback: true`，前端显示「备用数据」徽标。
- 密钥不写入代码/仓库；本计划全部使用公开接口（无需密钥）。
- 本地文件操作仅限工作空间根目录（`process.cwd()`）与 `JARVIS_LAUNCH` 白名单；云端标记 `localOnly: true`。
- 行为数据只存浏览器 localStorage，不上传。
- 前端改动集中在 `web/index.html`（单文件，遵守现有 `window.DETAIL.<mode>` / `window.DEEP.<mode>` / `window.__track` 约定）。
- 后端沿用现有 `fetchWithTimeout`、`hotCache`、`json()`、`runCodex`、`runChatAPI` 模式，不引入新依赖。
- 每个任务结束必须可独立验证（curl 或浏览器），并提交 git。

---

### Task 1: 后端通用缓存 + 中国社交热点聚合 `/api/hot`

**Files:**
- Modify: `agent-server.mjs`（在 `fetchWithTimeout` 附近新增 `cachedFetch`；在 `getHot` 之后新增 `getChinaHot`；在路由区新增 `/api/hot` 分支）

**Interfaces:**
- Consumes: 现有 `fetchWithTimeout(url, ms)`、`json(res, code, data)`。
- Produces: `getChinaHot(src)` → `[{ title, heat, link, source }]`；路由 `GET /api/hot?src=weibo|zhihu|baidu|douyin|all` → `{ ok, src, items, fallback }`。

- [ ] **Step 1: 新增 `cachedFetch`（在 `fetchWithTimeout` 之后）**

```js
const respCache = new Map();
async function cachedFetch(url, { ms = 12000, ttl = 120000, headers = {} } = {}) {
  const hit = respCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const r = await fetchWithTimeout(url, ms, headers);
  const data = await r.json().catch(() => ({}));
  respCache.set(url, { at: Date.now(), data });
  return data;
}
```

> 说明：现有 `fetchWithTimeout(url, ms)` 签名无 headers 参数，需改为 `fetchWithTimeout(url, ms, headers = {})`，内部 `fetch(url, { signal: c.signal, headers })`。若不想改动，可用独立实现：`fetch(url, { headers, signal: ctrl.signal })`。本计划采用「扩展现有函数」。

- [ ] **Step 2: 新增 `getChinaHot(src)`（放在 `getHot` 函数之后）**

```js
async function getChinaHot(src) {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
  const pick = (list, fallback, n) => {
    if (list && list.length) return { items: list.slice(0, n), fallback: false };
    return { items: fallback, fallback: true };
  };
  const demo = [{ title: "微博热搜暂不可用（备用数据）", heat: "", link: "", source: "微博" }];
  try {
    if (src === "weibo") {
      try {
        const j = await cachedFetch("https://weibo.com/ajax/side/hotSearch", { headers: { "User-Agent": UA, Referer: "https://weibo.com/" }, ttl: 120000 });
        const list = (j.data && j.data.realtime || []).filter(x => x.word).map(x => ({ title: x.word, heat: String(x.num || ""), link: `https://s.weibo.com/weibo?q=${encodeURIComponent(x.word)}`, source: "微博" }));
        return pick(list, demo, 20);
      } catch (e) {
        const j = await cachedFetch("https://api.vvhan.com/api/hotlist/wbHot", { ttl: 120000 });
        const list = (j.data || []).map(x => ({ title: x.title, heat: x.hot || "", link: x.url || "", source: "微博" }));
        return pick(list, demo, 20);
      }
    }
    if (src === "zhihu") {
      const j = await cachedFetch("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50", { headers: { "User-Agent": UA }, ttl: 180000 });
      const list = (j.data || []).map(x => ({ title: (x.target && x.target.title) || "", heat: x.detail_text || "", link: x.target && x.target.id ? `https://www.zhihu.com/question/${x.target.id}` : "", source: "知乎" })).filter(x => x.title);
      return pick(list, [{ title: "知乎热榜暂不可用（备用数据）", heat: "", link: "", source: "知乎" }], 20);
    }
    if (src === "baidu") {
      const j = await cachedFetch("https://top.baidu.com/api/board?platform=wise&tab=realtime", { headers: { "User-Agent": UA }, ttl: 180000 });
      const cards = j.data && j.data.cards || [];
      const list = [];
      for (const c of cards) for (const it of (c.content || [])) if (it.word) list.push({ title: it.word, heat: String(it.hotScore || ""), link: it.url || "", source: "百度" });
      return pick(list, [{ title: "百度热搜暂不可用（备用数据）", heat: "", link: "", source: "百度" }], 20);
    }
    if (src === "douyin") {
      const j = await cachedFetch("https://api.vvhan.com/api/hotlist/douyinHot", { ttl: 180000 });
      const list = (j.data || []).map(x => ({ title: x.title, heat: x.hot || "", link: x.url || "", source: "抖音" })).filter(x => x.title);
      return pick(list, [{ title: "抖音热点暂不可用（备用数据）", heat: "", link: "", source: "抖音" }], 20);
    }
    return pick([], demo, 0);
  } catch (e) {
    return { items: demo, fallback: true };
  }
}
```

- [ ] **Step 3: 注册路由（在 `/api/hot` 现有分支后新增）**

```js
if (url.pathname === "/api/hot" && url.searchParams.get("cn")) {
  try {
    const src = url.searchParams.get("src") || "all";
    const r = await getChinaHot(src);
    return json(res, 200, { ok: true, src, items: r.items, fallback: r.fallback });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
}
```

- [ ] **Step 4: 验证**

Run: `node --check agent-server.mjs` → 期望 SYNTAX_OK；重启本地服务（`launchctl kickstart -k "gui/$(id -u)/com.jarvis.agent"`）后：
`curl -s "http://127.0.0.1:8787/api/hot?cn=1&src=weibo" | head -c 300`
期望：返回 `ok:true` 且 items 非空（真实微博热搜标题或备用标记）。

- [ ] **Step 5: Commit**

```bash
git add agent-server.mjs && git commit -m "feat: 中国社交热点聚合接口（微博/知乎/百度/抖音）"
```

---

### Task 2: B站综合热榜 `/api/bili/hot`

**Files:**
- Modify: `agent-server.mjs`

**Interfaces:**
- Produces: `GET /api/bili/hot` → `{ ok, items: [{ bvid, title, pic, author, play, danmaku }], fallback }`。

- [ ] **Step 1: 新增 `getBiliHot()`（放在 `getChinaHot` 之后）**

```js
async function getBiliHot() {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
  try {
    const j = await cachedFetch("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", { headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" }, ttl: 300000 });
    const list = ((j.data && j.data.list) || []).map(x => ({
      bvid: x.bvid, title: x.title, pic: x.pic,
      author: x.owner && x.owner.name, play: x.stat && x.stat.view, danmaku: x.stat && x.stat.danmaku
    }));
    return { items: list.slice(0, 30), fallback: false };
  } catch (e) {
    return { items: [{ bvid: "", title: "B站热榜暂不可用（备用数据）", pic: "", author: "", play: "", danmaku: "" }], fallback: true };
  }
}
```

- [ ] **Step 2: 注册路由**

```js
if (url.pathname === "/api/bili/hot") {
  try { const r = await getBiliHot(); return json(res, 200, { ok: true, items: r.items, fallback: r.fallback }); }
  catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
}
```

- [ ] **Step 3: 验证**：`node --check agent-server.mjs`；重启后 `curl -s http://127.0.0.1:8787/api/bili/hot | head -c 300` 期望 bvid 真实存在。

- [ ] **Step 4: Commit**：`git add agent-server.mjs && git commit -m "feat: B站综合热榜接口"`

---

### Task 3: OpenRouter 模型目录 `/api/models`

**Files:**
- Modify: `agent-server.mjs`

**Interfaces:**
- Produces: `GET /api/models` → `{ ok, models: [{ id, name, context, priceIn, priceOut }], fallback }`（价格单位：美元/百万 token，转为字符串展示）。

- [ ] **Step 1: 新增 `getModelCatalog()`**

```js
const MODEL_DEMO = [
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", context: 65536, priceIn: "0.27", priceOut: "1.10" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context: 128000, priceIn: "0.15", priceOut: "0.60" },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context: 200000, priceIn: "3.00", priceOut: "15.00" },
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", context: 1048576, priceIn: "0.10", priceOut: "0.40" },
  { id: "qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B", context: 131072, priceIn: "0.90", priceOut: "0.90" }
];
async function getModelCatalog() {
  try {
    const j = await cachedFetch("https://openrouter.ai/api/v1/models", { ttl: 21600000 });
    const list = (j.data || []).filter(x => x.id).map(x => ({
      id: x.id, name: x.name || x.id,
      context: x.context_length || 0,
      priceIn: x.pricing && x.pricing.prompt != null ? (Number(x.pricing.prompt) * 1e6).toFixed(3) : "-",
      priceOut: x.pricing && x.pricing.completion != null ? (Number(x.pricing.completion) * 1e6).toFixed(3) : "-"
    }));
    return { models: list.length ? list : MODEL_DEMO, fallback: !list.length };
  } catch (e) {
    return { models: MODEL_DEMO, fallback: true };
  }
}
```

- [ ] **Step 2: 注册路由**（`/api/models` → `{ ok:true, ...await getModelCatalog() }`，错误 500）。

- [ ] **Step 3: 验证**：`curl -s http://127.0.0.1:8787/api/models | head -c 300`

- [ ] **Step 4: Commit**：`git commit -am "feat: OpenRouter 模型目录接口"`

---

### Task 4: GitHub 活跃与仓库树 `/api/github/activity` + `/api/repo/tree`

**Files:**
- Modify: `agent-server.mjs`

**Interfaces:**
- Produces:
  - `GET /api/github/activity` → `{ ok, user, contributions: [{date,count}], repos: [{name, desc, stars, lang, url}] , fallback }`
  - `GET /api/repo/tree` → `{ ok, tree: [{path, type, size}], fallback }`

- [ ] **Step 1: 新增两个函数**

```js
const GITHUB_USER = process.env.JARVIS_GITHUB_USER || "liangfang20001128-coder";
async function getGitHubActivity() {
  const demo = { contributions: [], repos: [], fallback: true };
  try {
    const [c, r] = await Promise.all([
      cachedFetch(`https://github-contributions-api.deno.dev/${GITHUB_USER}`, { ttl: 900000 }).catch(() => ({ contributions: [] })),
      cachedFetch(`https://api.github.com/users/${GITHUB_USER}/repos?sort=pushed&per_page=10`, { headers: { "User-Agent": "jarvis-terminal", Accept: "application/vnd.github+json" }, ttl: 900000 }).catch(() => [])
    ]);
    const contributions = (c.contributions || []).map(x => ({ date: x.date, count: x.count || 0 }));
    const repos = (Array.isArray(r) ? r : []).map(x => ({
      name: x.name, desc: x.description || "", stars: x.stargazers_count || 0,
      lang: x.language || "", url: x.html_url || ""
    }));
    return { user: GITHUB_USER, contributions, repos, fallback: !contributions.length && !repos.length };
  } catch (e) {
    return { user: GITHUB_USER, ...demo };
  }
}
async function getRepoTree() {
  try {
    const j = await cachedFetch(`https://api.github.com/repos/${GITHUB_USER}/jarvis-terminal/git/trees/main?recursive=1`, { headers: { "User-Agent": "jarvis-terminal" }, ttl: 900000 });
    const tree = (j.tree || []).filter(x => x.type === "blob").map(x => ({ path: x.path, type: "file", size: x.size || 0 }));
    return { ok: true, tree, fallback: false };
  } catch (e) {
    return { ok: true, tree: [{ path: "README.md", type: "file", size: 0 }], fallback: true };
  }
}
```

- [ ] **Step 2: 注册两条路由**（标准 json 包装，错误 500）。

- [ ] **Step 3: 验证**：`curl -s http://127.0.0.1:8787/api/github/activity | head -c 300`；`curl -s http://127.0.0.1:8787/api/repo/tree | head -c 200`

- [ ] **Step 4: Commit**：`git commit -am "feat: GitHub 活跃与仓库文件树接口"`

---

### Task 5: 本机应用列表、文件操作与搜索

**Files:**
- Modify: `agent-server.mjs`（新增 `getApps`、`openTarget`、`searchWorkspace`；`/api/workspace` 分支后新增路由）

**Interfaces:**
- Produces:
  - `GET /api/apps` → `{ ok, localOnly, apps: [{ name, path }] }`
  - `POST /api/open` `{ type:'app'|'file'|'reveal', value }` → `{ ok, message }`
  - `GET /api/workspace/search?q=` → `{ ok, files: [{ path, isDir, size }] }`

- [ ] **Step 1: 新增函数（放在 `getWorkspace` 之后）**

```js
import { readdirSync, statSync } from "node:fs";
const APP_DIRS = ["/Applications", join(process.env.HOME || "/", "Applications")];
function getApps() {
  const apps = [];
  for (const dir of APP_DIRS) {
    if (!existsSync(dir)) continue;
    for (const ent of readdirSync(dir)) {
      if (ent.endsWith(".app")) apps.push({ name: ent.slice(0, -4), path: join(dir, ent) });
    }
  }
  return apps;
}
function openTarget(type, value) {
  const ROOT = process.cwd();
  if (type === "app") {
    const allowed = new Set([...(getApps().map(a => a.name)), ...Object.keys(launchAllowlist || {})]);
    if (!allowed.has(value)) return { ok: false, message: "应用不在白名单" };
    execFile("open", ["-a", value], (err) => err ? null : null);
    return { ok: true, message: `已启动 ${value}` };
  }
  const resolved = join(ROOT, String(value || "").replace(/^\/+/, ""));
  if (!resolved.startsWith(ROOT) || !existsSync(resolved)) return { ok: false, message: "路径不合法或不存在" };
  execFile("open", type === "reveal" ? ["-R", resolved] : [resolved], () => {});
  return { ok: true, message: type === "reveal" ? "已在访达中显示" : "已打开" };
}
function searchWorkspace(q) {
  const out = [];
  const qq = String(q || "").toLowerCase();
  function walk(dir, depth) {
    if (depth > 3 || out.length > 60) return;
    let ents = [];
    try { ents = readdirSync(dir); } catch (e) { return; }
    for (const ent of ents) {
      if (ent === ".git" || ent === "node_modules" || ent === ".superpowers" || ent === ".playwright-cli") continue;
      const full = join(dir, ent);
      let isDir = false, size = 0;
      try { const st = statSync(full); isDir = st.isDirectory(); size = st.size; } catch (e) { continue; }
      if (ent.toLowerCase().includes(qq)) out.push({ path: relative(process.cwd(), full), isDir, size });
      if (isDir) walk(full, depth + 1);
    }
  }
  walk(process.cwd(), 0);
  return out.slice(0, 60);
}
```

> 注意：顶部 import 增加 `readdirSync, statSync`（现有为 `existsSync, readFileSync`）；`launchAllowlist` 若未定义，用 `{}`（Task 需先确认现有变量名，见 `launchApp`）。

- [ ] **Step 2: 注册三条路由**（/api/apps、/api/workspace/search、/api/open POST），云端识别：`if (!existsSync("/Applications")) return { ok:true, localOnly:true, apps:[] }`。

- [ ] **Step 3: 验证**：
`curl -s http://127.0.0.1:8787/api/apps | head -c 200`
`curl -s "http://127.0.0.1:8787/api/workspace/search?q=agent" | head -c 200`
`curl -s -X POST http://127.0.0.1:8787/api/open -H "Content-Type: application/json" -d '{"type":"file","value":"README.md"}'`

- [ ] **Step 4: Commit**：`git commit -am "feat: 本机应用列表、文件打开与搜索接口"`

---

### Task 6: 玄学顾问子智能体 `/api/divine`

**Files:**
- Modify: `agent-server.mjs`（`runCodex`/`runChatAPI` 增加可选 `systemPrompt` 参数；新增 `FATE_PROMPT`；新增路由）

**Interfaces:**
- Consumes: `runCodex(message, systemPrompt)`、`runChatAPI(message, systemPrompt)`。
- Produces: `POST /api/divine` `{ message }` → `{ ok, agent, reply }`。

- [ ] **Step 1: 增加 `FATE_PROMPT` 并改造两个函数签名**

```js
const FATE_PROMPT = `你是「玄学顾问」，精通《周易》、命理、风水、节气民俗的中文顾问。
回答要求：引经据典但理性克制，明确区分「传统说法」与「个人建议」；语言文言与白话结合，称呼对方为「先生」。
不得承诺因果、不得制造焦虑；涉及健康、财务等重大决策时提醒理性参考。
回答末尾可给出一个可操作的小建议。`;
```

- 改造 `runCodex(message, systemPrompt = SYSTEM_PROMPT)` 与 `runChatAPI(message, systemPrompt = SYSTEM_PROMPT)`：内部 `SYSTEM_PROMPT` 引用改为传入参数（仅替换字符串拼接处，其余逻辑不变）。

- [ ] **Step 2: 新增 `runDivine(message)`**

```js
async function runDivine(message) {
  const useCodex = AGENT_MODE === "codex" || (AGENT_MODE === "auto" && codexAvailable());
  if (useCodex) {
    try { return { agent: "codex", reply: await runCodex(String(message), FATE_PROMPT) }; }
    catch (e) { /* fallthrough */ }
  }
  if (process.env.OPENAI_API_KEY && (AGENT_MODE === "openai" || AGENT_MODE === "auto")) {
    try { return { agent: apiProvider(), reply: await runChatAPI(String(message), FATE_PROMPT) }; }
    catch (e) { /* fallthrough */ }
  }
  const fallback = [
    "《易》曰：观乎天文，以察时变。先生所问之事，宜静观其变，三思而后行。",
    "天行健，君子以自强不息。此问无吉凶定数，惟在先生一念之间。",
    "亢龙有悔，盈不可久。眼下诸事宜守成，不宜冒进。"
  ];
  return { agent: "fallback", reply: fallback[Math.abs(hashCode(message)) % fallback.length] };
}
function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
```

- [ ] **Step 3: 注册 `/api/divine` POST 路由**（解析 `{message}`，空则 400；返回 `{ ok, agent, reply }`）。

- [ ] **Step 4: 验证**：重启后 `curl -s -X POST http://127.0.0.1:8787/api/divine -H "Content-Type: application/json" -d '{"message":"今天适合签约吗"}'` 期望返回文言风格回答。

- [ ] **Step 5: Commit**：`git commit -am "feat: 玄学顾问子智能体"`

---

### Task 7: 前端农历库 + 每日玄学（时运模块）

**Files:**
- Create: `web/vendor/lunar.js`（下载 lunar-javascript 压缩包并解出 `lunar.js`，MIT 许可保留头部注释）
- Modify: `web/index.html`（`<head>` 引入 `<script src="vendor/lunar.js"></script>`；替换 `window.DETAIL.fate` 与 `window.DEEP.fate`；新增玄学顾问聊天框与 `window.jarvis.divine()`）

**Interfaces:**
- Consumes: `/api/divine`。
- Produces: `window.jarvis.divine(text)` → Promise<string>；`dailyFortune()` 返回 `{ lunar, ganzhi, yi, ji, hexName, luck }`。

- [ ] **Step 1: 下载并放置 lunar.js**

```bash
mkdir -p web/vendor
curl -4 -sL "https://cdn.jsdelivr.net/npm/lunar-javascript@1.6.12/lunar.js" -o web/vendor/lunar.js
head -c 120 web/vendor/lunar.js
```

- [ ] **Step 2: 引入脚本 + 新增 `dailyFortune()`（放在 `window.DETAIL.fate` 定义前）**

```html
<script src="vendor/lunar.js"></script>
```

```js
function dailyFortune() {
  var key = 'jarvis-fate-' + new Date().toISOString().slice(0, 10);
  try { var c = JSON.parse(localStorage.getItem(key)); if (c) return c; } catch (e) {}
  var L = window.Lunar || {};
  var out = { lunar: '', ganzhi: '', yi: [], ji: [], hexName: '水火既济', luck: 60 };
  try {
    var solar = L.Solar.fromDate(new Date());
    var lunar = solar.getLunar();
    out.lunar = lunar.toString();
    out.ganzhi = lunar.getYearInGanZhi() + '年 ' + lunar.getMonthInGanZhi() + '月 ' + lunar.getDayInGanZhi() + '日';
    var yi = lunar.getDayYi(), ji = lunar.getDayJi();
    out.yi = (yi || '').split(' ').filter(Boolean).slice(0, 4);
    out.ji = (ji || '').split(' ').filter(Boolean).slice(0, 4);
    var seed = Math.abs((new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate()) * 37 % 64);
    out.hexName = (window.HEX && window.HEX[seed]) || '水火既济';
    out.luck = 40 + (seed % 40);
  } catch (e) {}
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
  return out;
}
```

- [ ] **Step 3: 重写 `window.DETAIL.fate` / `window.DEEP.fate`**：显示农历、干支、宜忌、卦象、运势条；第三层加玄学顾问聊天框（输入 + 发送按钮 → `window.jarvis.divine` → 追加回答）。

- [ ] **Step 4: 新增 `window.jarvis.divine`**

```js
window.jarvis.divine = function (text) {
  return postJSON(AGENT_URL + '/api/divine', { message: text }, 60000)
    .then(function (d) { return (d && d.reply) || '……'; })
    .catch(function () { return '卦象未明，稍后再问，先生。'; });
};
```

- [ ] **Step 5: 本地验证**：`python3 -m http.server 8899 -d web` 后打开 `http://localhost:8899`，时运模块显示真实农历与宜忌；玄学顾问可回答。

- [ ] **Step 6: Commit**：`git add web/vendor/lunar.js web/index.html && git commit -m "feat: 时运模块真实农历 + 玄学顾问"`

---

### Task 8: 网页内行为追踪器与洞察面板

**Files:**
- Modify: `web/index.html`（扩展 `window.__track`；新增 `__anal`；重写 `window.DETAIL.habit` / `window.DEEP.habit` / `renderHabit` 相关面板）

**Interfaces:**
- Produces: `window.__anal(type, payload)`；`habitAnalytics()` → `{ clicks, voice, chat, depth, hours, byMode }`。

- [ ] **Step 1: 新增 `__anal` 与 `habitAnalytics()`（在 `window.__track` 附近）**

```js
function analStore() {
  var s = {}; try { s = JSON.parse(localStorage.getItem('jarvis-ana') || '{}'); } catch (e) {}
  var day = new Date().toISOString().slice(0, 10);
  if (s.day !== day) { s = { day: day }; }
  return s;
}
window.__anal = function (type, key) {
  var s = analStore();
  if (type === 'click') { s.clicks = s.clicks || {}; s.clicks[key] = (s.clicks[key] || 0) + 1; }
  if (type === 'voice') s.voice = (s.voice || 0) + 1;
  if (type === 'chat') s.chat = (s.chat || 0) + 1;
  if (type === 'scroll') { var p = Math.round(document.documentElement.scrollTop / Math.max(1, document.documentElement.scrollHeight - innerHeight) * 100); s.depth = Math.max(s.depth || 0, isFinite(p) ? p : 0); }
  try { localStorage.setItem('jarvis-ana', JSON.stringify(s)); } catch (e) {}
};
function habitAnalytics() {
  var s = analStore();
  var focus = {}; try { focus = JSON.parse(localStorage.getItem('jarvis-focus') || '{}'); } catch (e) {}
  return { clicks: s.clicks || {}, voice: s.voice || 0, chat: s.chat || 0, depth: s.depth || 0, byMode: focus.byMode || {}, day: s.day };
}
```

- [ ] **Step 2: 全页埋点**：所有可点击 chip/快捷指令 `onclick` 前追加 `window.__anal('click','<key>')`；语音开始/结束处加 `__anal('voice')`；聊天发送处加 `__anal('chat')`；`window.addEventListener('scroll', ...)` 节流调用 `__anal('scroll')`。

- [ ] **Step 3: 重写行为面板**：`DETAIL.habit` 显示今日概览（活跃模块数、点击 Top3、语音/聊天次数、滚动深度）；`DEEP.habit` 显示模块使用排行 + 活跃时段（24 格 bar，数据来自 `focus.hours`）+ 一句建议（如「上午 X 点最专注」）。

- [ ] **Step 4: 验证**：浏览器打开后点击若干 chip、滚动页面，刷新后数据保留并增长。

- [ ] **Step 5: Commit**：`git commit -am "feat: 网页内行为追踪与洞察面板"`

---

### Task 9: 热点模块多平台 tab + 搜索

**Files:**
- Modify: `web/index.html`（`loadHot`、`window.DETAIL.hot`、`window.DEEP.hot`、主屏 ticker 逻辑）

**Interfaces:**
- Consumes: `/api/hot?cn=1&src=...`、`/api/hot`（原资讯源）。

- [ ] **Step 1: 新增 `loadChinaHot(src)` 与 tab 渲染**：`LIVE.cnHot[src]` 缓存；`DETAIL.hot` 顶部渲染 tab（综合/微博/知乎/百度/抖音），点击切换并显示热度与来源徽标；搜索框过滤当前列表；点击行 `window.open(link)`。

- [ ] **Step 2: 备用标记**：`fallback:true` 时在 tab 旁显示「备用」徽标。

- [ ] **Step 3: 验证**：浏览器打开热点模块，逐 tab 可见真实标题与热度；搜索可过滤。

- [ ] **Step 4: Commit**：`git commit -am "feat: 热点多平台 tab 与搜索"`

---

### Task 10: AI 模块模型目录 + Token 用量

**Files:**
- Modify: `web/index.html`（`loadAi` 后新增 `loadModels`、`tokenStats`；`window.DETAIL.ai` / `window.DEEP.ai`）

**Interfaces:**
- Consumes: `/api/models`。
- Produces: `window.jarvis.trackTokens(kind, chars)`；`tokenStats()` → `{ msgs, inTk, outTk, cost }`。

- [ ] **Step 1: Token 统计**

```js
window.jarvis.trackTokens = function (kind, chars) {
  var s = {}; try { s = JSON.parse(localStorage.getItem('jarvis-tokens') || '{}'); } catch (e) {}
  var day = new Date().toISOString().slice(0, 10);
  if (s.day !== day) s = { day: day, msgs: 0, inTk: 0, outTk: 0 };
  var tk = Math.max(1, Math.round(chars / 1.5));
  s.msgs += 1; if (kind === 'in') s.inTk += tk; else s.outTk += tk;
  try { localStorage.setItem('jarvis-tokens', JSON.stringify(s)); } catch (e) {}
  return s;
};
function tokenStats() {
  var s = {}; try { s = JSON.parse(localStorage.getItem('jarvis-tokens') || '{}'); } catch (e) {}
  var inPrice = 0.27, outPrice = 1.10; // DeepSeek-chat 每百万 token 参考价（元）
  var cost = ((s.inTk || 0) * inPrice + (s.outTk || 0) * outPrice) / 1e6;
  return { msgs: s.msgs || 0, inTk: s.inTk || 0, outTk: s.outTk || 0, cost: cost };
}
```

- [ ] **Step 2: 接入聊天**：`send()` 成功后调用 `window.jarvis.trackTokens('in', text.length)` 与 `trackTokens('out', reply.length)`。

- [ ] **Step 3: 渲染**：`DETAIL.ai` 增加模型目录表（名称/上下文/价格）；`DEEP.ai` 增加 Token 用量卡片（今日消息数、输入/输出 token、估算成本）。`loadModels()` 拉取 `/api/models` 存 `LIVE.models`。

- [ ] **Step 4: 验证**：浏览器 AI 模块出现模型目录与 Token 统计，发消息后数字增长。

- [ ] **Step 5: Commit**：`git commit -am "feat: AI 模型目录与 Token 用量"`

---

### Task 11: 影音模块（账号直通 + B站热榜 + 电台）

**Files:**
- Modify: `web/index.html`（`window.DETAIL.media` / `window.DEEP.media`；新增 `loadBili()`）

**Interfaces:**
- Consumes: `/api/bili/hot`、`/api/launch`。

- [ ] **Step 1: 三区布局**

```js
function mediaAccountLinks() {
  return '<div class="dw-sub">个人账号直通（新窗口，登录态跟随浏览器）</div>' +
    '<div class="dw-row">▶ 抖音 <span class="v" style="cursor:pointer" onclick="window.__anal(\'click\',\'media-douyin\');window.open(\'https://www.douyin.com\')">打开</span></div>' +
    '<div class="dw-row">▶ 哔哩哔哩 <span class="v" style="cursor:pointer" onclick="window.__anal(\'click\',\'media-bili\');window.open(\'https://www.bilibili.com\')">打开</span></div>' +
    '<div class="dw-row">▶ QQ音乐 <span class="v" style="cursor:pointer" onclick="window.__anal(\'click\',\'media-qqmusic\');window.open(\'https://y.qq.com\')">打开</span></div>';
}
```

- [ ] **Step 2: B站热榜**：`loadBili()` 拉取 `/api/bili/hot` 存 `LIVE.bili`；列表项点击后 `DEEP.media` 区域插入 `<iframe src="https://player.bilibili.com/player.html?bvid=...&autoplay=0&high_quality=1">`，并提供「B站打开」按钮。

- [ ] **Step 3: 电台与本地 App**：SomaFM 流 `<audio controls src="https://ice1.somafm.com/groovesalad-128-mp3">`；本机启动 chips 复用 `window.jarvis.launch('抖音')` 等（白名单内可用，云端提示「本机功能」）。

- [ ] **Step 4: 验证**：浏览器中 B站热榜可加载并可内嵌播放；电台可播放。

- [ ] **Step 5: Commit**：`git commit -am "feat: 影音模块账号直通 + B站热榜 + 电台"`

---

### Task 12: 空间模块双态（本机应用/文件 ↔ 云端仓库）

**Files:**
- Modify: `web/index.html`（`loadSpace`、`window.DETAIL.space` / `window.DEEP.space`；新增 `loadApps()`、`loadRepoTree()`、`window.jarvis.openTarget()`）

**Interfaces:**
- Consumes: `/api/apps`、`/api/workspace/search`、`/api/open`、`/api/repo/tree`。

- [ ] **Step 1: 本机应用区**：`loadApps()` 拉取 `/api/apps`；`localOnly:true` 时隐藏应用/文件操作区并显示「云端的仓库浏览器」。
- [ ] **Step 2: 文件搜索与操作**：搜索框（防抖 300ms）调 `/api/workspace/search?q=`；每行提供「打开」与「访达」按钮 → `window.jarvis.openTarget('file'|'reveal', path)`。
- [ ] **Step 3: 云端仓库树**：`loadRepoTree()` 拉取 `/api/repo/tree` 渲染文件列表（含大小），点击文件打开 GitHub 页面。
- [ ] **Step 4: 验证**：本机浏览器看到应用网格与可打开文件；切换 `web/config.js` 的 `JARVIS_AGENT_URL` 指向云端（或直接开线上）验证仓库树。
- [ ] **Step 5: Commit**：`git commit -am "feat: 空间模块本机应用文件 + 云端仓库双态"`

---

### Task 13: 对话快捷指令 + 贾维斯英文台词

**Files:**
- Modify: `web/index.html`（`DETAIL.chat` / `DEEP.chat` 增加 chips 区；`send()` 内嵌台词触发）

**Interfaces:**
- Consumes: `window.jarvis.modules.open`、`window.jarvis.speak`。

- [ ] **Step 1: 快捷指令 chips**：打开热点 / 今日运势 / 播放电台 / 行为分析 / 模型前沿 / 启动应用 —— 点击执行对应模块或动作。
- [ ] **Step 2: 台词触发**：`window.jarvis.sayEN(line)`（见 Task 14）在开机、模块打开、任务完成时调用；`send()` 失败兜底时播报 `I'm afraid I didn't catch that, sir.`
- [ ] **Step 3: Commit**：`git commit -am "feat: 对话快捷指令与贾维斯台词"`

---

### Task 14: 语音系统重构（音色调校 + 设置面板）

**Files:**
- Modify: `web/index.html`（替换 `window.jarvis.speak`；新增 `pickVoice`、`sayEN`、设置面板 DOM 与事件）

**Interfaces:**
- Produces: `window.jarvis.speak(text, opts)`、`window.jarvis.sayEN(line)`、`window.jarvis.voiceSettings`。

- [ ] **Step 1: 语音选择与调校**

```js
var VOICE_CFG = { rate: 0.95, pitch: 0.78, enLines: true };
try { var vc = JSON.parse(localStorage.getItem('jarvis-voice') || '{}'); VOICE_CFG = Object.assign(VOICE_CFG, vc); } catch (e) {}
function pickVoice(lang) {
  var vs = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  var en = ['Google UK English Male', 'Daniel', 'Oliver', 'Arthur'];
  var zh = ['Reed', 'Grandpa', 'Google 普通话（中国大陆）', 'Microsoft Yaoyao', 'Ting-Ting'];
  var prefs = lang === 'zh' ? zh : en;
  for (var i = 0; i < prefs.length; i++) {
    var f = vs.filter(function (v) { return v.name === prefs[i]; })[0];
    if (f) return f;
  }
  var gb = vs.filter(function (v) { return v.lang && v.lang.indexOf(lang === 'zh' ? 'zh' : 'en-GB') === 0; });
  return gb[0] || vs.filter(function (v) { return v.lang && v.lang.indexOf(lang === 'zh' ? 'zh' : 'en') === 0; })[0] || null;
}
window.jarvis.speak = function (text, opts) {
  if (!TTS || !('speechSynthesis' in window)) return;
  opts = opts || {};
  try { window.speechSynthesis.cancel(); } catch (e) {}
  var u = new SpeechSynthesisUtterance(String(text || '').replace(/\[\[module:\w+\]\]/g, '').slice(0, 400));
  var lang = opts.en ? 'en' : 'zh';
  var v = pickVoice(lang);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = VOICE_CFG.rate; u.pitch = opts.en ? VOICE_CFG.pitch : Math.min(1, VOICE_CFG.pitch + 0.08);
  window.speechSynthesis.speak(u);
};
window.jarvis.sayEN = function (line) {
  if (!VOICE_CFG.enLines) return;
  window.jarvis.speak(line, { en: true });
};
```

- [ ] **Step 2: 设置面板**：聊天/语音区新增「音色试听」按钮（播放 `Systems online, sir.`）、音调滑块（0.5–1.2）、语速滑块（0.6–1.4）、英文台词开关；变化时保存 `localStorage['jarvis-voice']` 并即时生效。
- [ ] **Step 3: 保证 `voiceschanged` 监听**（Chrome 首次取不到声音列表时刷新）。
- [ ] **Step 4: 验证**：浏览器试听，确认英文为低沉英式男声、中文为低沉中文男声；刷新后设置保留。
- [ ] **Step 5: Commit**：`git commit -am "feat: 贾维斯音色调校与语音设置"`

---

### Task 15: 本地端到端验证

**Files:** 无（验证任务）

- [ ] **Step 1: 接口清单逐一 curl**：`/api/hot?cn=1&src=weibo|zhihu|baidu|douyin`、`/api/bili/hot`、`/api/models`、`/api/github/activity`、`/api/repo/tree`、`/api/apps`、`/api/workspace/search?q=agent`、`/api/divine`。
- [ ] **Step 2: 浏览器全模块走查**：热点 tab、AI 目录与 Token、行为面板增长、影音三区、空间双态、时运农历与玄学顾问、语音试听。
- [ ] **Step 3: 修复发现的问题并提交**。

---

### Task 16: 推送部署与线上验证

**Files:** 无

- [ ] **Step 1: 推送**：`JGT=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p') node --dns-result-order=ipv4first scripts/push-api.mjs`，期望 `PUSHED commit ... files: N`。
- [ ] **Step 2: 等待 Render 自动部署**：轮询 `curl -4 -s https://jarvis-agent-oqcy.onrender.com/api/status` 直到返回 `"agent":"deepseek"` 且包含 `provider` 字段。
- [ ] **Step 3: 线上验证**：`/api/hot?cn=1&src=weibo`、`/api/bili/hot`、`/api/divine`（云端走 DeepSeek）；GitHub Pages 站点返回 200 且 `index.html` 含「音色试听」。
- [ ] **Step 4: 汇报**。
