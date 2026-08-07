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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.JARVIS_PORT || 8787);
const AGENT_MODE = process.env.JARVIS_AGENT || "auto";
const CODEX_BIN =
  process.env.CODEX_BIN ||
  "/Applications/ChatGPT.app/Contents/Resources/codex";

const MODULES = ["chat", "hot", "ai", "habit", "media", "space", "fate", "weather"];

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

async function fetchWithTimeout(url, ms = 8000, headers = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, {
      signal: c.signal,
      headers: { "User-Agent": "JarvisTerminal/1.0", ...headers },
    });
  } finally {
    clearTimeout(t);
  }
}

const respCache = new Map();
async function cachedFetch(url, { ms = 12000, ttl = 120000, headers = {} } = {}) {
  const hit = respCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const r = await fetchWithTimeout(url, ms, headers);
  const data = await r.json().catch(() => ({}));
  respCache.set(url, { at: Date.now(), data });
  return data;
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

const CN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
async function getChinaHot(src) {
  const pick = (list, fallback, n) =>
    list && list.length ? { items: list.slice(0, n), fallback: false } : { items: fallback, fallback: true };
  const demo = (s) => [{ title: `${s}热点暂不可用（备用数据）`, heat: "", link: "", source: s }];
  try {
    if (src === "weibo") {
      try {
        const j = await cachedFetch("https://weibo.com/ajax/side/hotSearch", {
          headers: { "User-Agent": CN_UA, Referer: "https://weibo.com/" }, ttl: 120000,
        });
        const list = ((j.data && j.data.realtime) || [])
          .filter((x) => x.word)
          .map((x) => ({ title: x.word, heat: String(x.num || ""), link: `https://s.weibo.com/weibo?q=${encodeURIComponent(x.word)}`, source: "微博" }));
        return pick(list, demo("微博"), 20);
      } catch (e) {
        const j = await cachedFetch("https://api.vvhan.com/api/hotlist/wbHot", { ttl: 120000 });
        const list = ((j && j.data) || []).map((x) => ({ title: x.title, heat: x.hot || "", link: x.url || "", source: "微博" }));
        return pick(list, demo("微博"), 20);
      }
    }
    if (src === "zhihu") {
      try {
        const j = await cachedFetch("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50", {
          headers: { "User-Agent": CN_UA, Referer: "https://www.zhihu.com/hot" }, ttl: 180000,
        });
        const list = ((j && j.data) || [])
          .map((x) => ({
            title: (x.target && x.target.title) || "",
            heat: x.detail_text || "",
            link: x.target && x.target.id ? `https://www.zhihu.com/question/${x.target.id}` : "",
            source: "知乎",
          }))
          .filter((x) => x.title);
        return pick(list, demo("知乎"), 20);
      } catch (e) {
        const t = await cachedFetch("https://tenapi.cn/v2/zhihuhot", { ttl: 180000 }).catch(() => ({}));
        const list = ((t && t.data) || []).map((x) => ({ title: x.title || "", heat: x.hot || "", link: x.url || "", source: "知乎" }));
        return pick(list, demo("知乎"), 20);
      }
    }
    if (src === "baidu") {
      const j = await cachedFetch("https://top.baidu.com/api/board?platform=wise&tab=realtime", {
        headers: { "User-Agent": CN_UA }, ttl: 180000,
      });
      const cards = (j && j.data && j.data.cards) || [];
      const list = [];
      for (const c of cards) {
        for (const it of c.content || []) {
          const raw = it.content;
          if (typeof raw === "string") {
            const words = [...raw.matchAll(/'word': '([^']*)'/g)].map((m) => m[1]);
            const urls = [...raw.matchAll(/'url': '([^']*)'/g)].map((m) => m[1]);
            for (let i = 0; i < words.length; i++) {
              if (words[i]) list.push({ title: words[i], heat: `#${i + 1}`, link: urls[i] || "", source: "百度" });
            }
          } else if (Array.isArray(raw)) {
            for (const x of raw) {
              if (x && x.word) list.push({ title: x.word, heat: x.hotScore != null ? String(x.hotScore) : `#${list.length + 1}`, link: x.url || "", source: "百度" });
            }
          }
        }
      }
      return pick(list, demo("百度"), 20);
    }
    if (src === "douyin") {
      try {
        const j = await cachedFetch("https://api.vvhan.com/api/hotlist/douyinHot", { ttl: 180000 });
        const list = ((j && j.data) || [])
          .map((x) => ({ title: x.title, heat: x.hot || "", link: x.url || "", source: "抖音" }))
          .filter((x) => x.title);
        return pick(list, demo("抖音"), 20);
      } catch (e) {
        const t = await cachedFetch("https://tenapi.cn/v2/douyinhot", { ttl: 180000 }).catch(() => ({}));
        const list = ((t && t.data) || []).map((x) => ({ title: x.title || "", heat: x.hot || "", link: x.url || "", source: "抖音" }));
        return pick(list, demo("抖音"), 20);
      }
    }
    return pick([], demo("微博"), 20);
  } catch (e) {
    return { items: demo(src === "douyin" ? "抖音" : "微博"), fallback: true };
  }
}

async function getBiliHot() {
  try {
    const attempts = [
      () => cachedFetch("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all", {
        headers: { "User-Agent": CN_UA, Referer: "https://www.bilibili.com/" }, ttl: 300000,
      }).then((j) => (j.data && j.data.list) || []),
      () => cachedFetch("https://api.obfs.dev/api/bili/ranking?rid=0&type=all", { ttl: 300000 })
        .then((j) => (j.data && j.data.list) || []),
      () => cachedFetch("https://api.vvhan.com/api/hotlist/biliHot", { ttl: 300000 })
        .then((j) => (j.data || []).map((x) => ({ bvid: x.bvid || "", title: x.title, pic: x.pic || "", author: x.author || "", play: x.hot || "", danmaku: "" }))),
    ];
    let raw = [];
    for (const fn of attempts) {
      try {
        const arr = await fn();
        if (Array.isArray(arr) && arr.length) { raw = arr; break; }
      } catch (e) { /* 尝试下一个源 */ }
    }
    if (!raw.length) return { items: [{ bvid: "", title: "B站热榜暂不可用（备用数据）", pic: "", author: "", play: "", danmaku: "" }], fallback: true };
    const list = raw.map((x) => ({
      bvid: x.bvid || "",
      title: x.title || "",
      pic: x.pic || "",
      author: (x.owner && x.owner.name) || x.author || "",
      play: (x.stat && x.stat.view) || x.play || "",
      danmaku: (x.stat && x.stat.danmaku) || x.danmaku || "",
    }));
    return { items: list.slice(0, 30), fallback: false };
  } catch (e) {
    return { items: [{ bvid: "", title: "B站热榜暂不可用（备用数据）", pic: "", author: "", play: "", danmaku: "" }], fallback: true };
  }
}

const MODEL_DEMO = [
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", context: 65536, priceIn: "0.27", priceOut: "1.10" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context: 128000, priceIn: "0.15", priceOut: "0.60" },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", context: 200000, priceIn: "3.00", priceOut: "15.00" },
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", context: 1048576, priceIn: "0.10", priceOut: "0.40" },
  { id: "qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B", context: 131072, priceIn: "0.90", priceOut: "0.90" },
];
async function getModelCatalog() {
  try {
    const j = await cachedFetch("https://openrouter.ai/api/v1/models", { ttl: 21600000 });
    const list = (j.data || [])
      .filter((x) => x.id)
      .map((x) => ({
        id: x.id,
        name: x.name || x.id,
        context: x.context_length || 0,
        priceIn: x.pricing && x.pricing.prompt != null ? (Number(x.pricing.prompt) * 1e6).toFixed(3) : "-",
        priceOut: x.pricing && x.pricing.completion != null ? (Number(x.pricing.completion) * 1e6).toFixed(3) : "-",
      }));
    return { models: list.length ? list : MODEL_DEMO, fallback: !list.length };
  } catch (e) {
    return { models: MODEL_DEMO, fallback: true };
  }
}

const GITHUB_USER = process.env.JARVIS_GITHUB_USER || "liangfang20001128-coder";
async function getGitHubActivity() {
  try {
    const [ev, r] = await Promise.all([
      cachedFetch(`https://api.github.com/users/${GITHUB_USER}/events/public?per_page=100`, {
        headers: { "User-Agent": "jarvis-terminal", Accept: "application/vnd.github+json" }, ttl: 900000,
      }).catch(() => []),
      cachedFetch(`https://api.github.com/users/${GITHUB_USER}/repos?sort=pushed&per_page=10`, {
        headers: { "User-Agent": "jarvis-terminal", Accept: "application/vnd.github+json" }, ttl: 900000,
      }).catch(() => []),
    ]);
    const byDay = {};
    for (const e of Array.isArray(ev) ? ev : []) {
      if (e && e.created_at) byDay[e.created_at.slice(0, 10)] = (byDay[e.created_at.slice(0, 10)] || 0) + 1;
    }
    const contributions = Object.keys(byDay).sort().map((date) => ({ date, count: byDay[date] }));
    const repos = (Array.isArray(r) ? r : []).map((x) => ({
      name: x.name, desc: x.description || "", stars: x.stargazers_count || 0,
      lang: x.language || "", url: x.html_url || "",
    }));
    return { user: GITHUB_USER, contributions, repos, fallback: !contributions.length && !repos.length };
  } catch (e) {
    return { user: GITHUB_USER, contributions: [], repos: [], fallback: true };
  }
}

const WMO = {
  0: ["晴", "☀️"], 1: ["大致晴朗", "🌤️"], 2: ["多云", "⛅"], 3: ["阴", "☁️"],
  45: ["雾", "🌫️"], 48: ["雾凇", "🌫️"],
  51: ["小毛毛雨", "🌦️"], 53: ["毛毛雨", "🌧️"], 55: ["大毛毛雨", "🌧️"],
  61: ["小雨", "🌧️"], 63: ["中雨", "🌧️"], 65: ["大雨", "🌧️"],
  71: ["小雪", "🌨️"], 73: ["中雪", "🌨️"], 75: ["大雪", "❄️"], 77: ["雪粒", "🌨️"],
  80: ["阵雨", "🌦️"], 81: ["强阵雨", "🌧️"], 82: ["暴雨", "⛈️"],
  85: ["阵雪", "🌨️"], 86: ["强阵雪", "❄️"],
  95: ["雷暴", "⛈️"], 96: ["雷暴伴冰雹", "⛈️"], 99: ["强雷暴伴冰雹", "⛈️"],
};
function wmoInfo(code) {
  const w = WMO[code] || ["未知", "🌡️"];
  return { code, text: w[0], emoji: w[1] };
}

const weatherCache = { at: 0, key: "", data: null };
async function getWeatherWttr(city, lat, lon) {
  const q = lat && lon ? `${lat},${lon}` : encodeURIComponent(city);
  const j = await cachedFetch(`https://wttr.in/${q}?format=j1`, { ttl: 600000 });
  const cur = (j.current_condition || [])[0] || {};
  const days = (j.weather || []).slice(0, 7).map((d) => {
    const h = (d.hourly || [])[4] || {};
    return {
      date: d.date,
      ...wmoInfo(Number(h.weatherCode) || 0),
      tmax: d.maxtempC != null ? Number(d.maxtempC) : null,
      tmin: d.mintempC != null ? Number(d.mintempC) : null,
      pop: h.chanceofrain != null ? Number(h.chanceofrain) : null,
    };
  });
  return {
    city,
    country: "",
    lat: lat || null,
    lon: lon || null,
    current: {
      temp: cur.temp_C != null ? Number(cur.temp_C) : null,
      feels: cur.FeelsLikeC != null ? Number(cur.FeelsLikeC) : null,
      humidity: cur.humidity != null ? Number(cur.humidity) : null,
      wind: cur.windspeedKmph != null ? Number(cur.windspeedKmph) : null,
      ...wmoInfo(Number(cur.weatherCode) || 0),
    },
    daily: days,
    fallback: false,
    source: "wttr.in",
  };
}

async function getWeather(city, lat, lon) {
  const key = `${city}|${lat || ""}|${lon || ""}`;
  if (weatherCache.data && weatherCache.key === key && Date.now() - weatherCache.at < 600000) {
    return weatherCache.data;
  }
  let coords = { lat, lon };
  let country = "";
  if (!lat || !lon) {
    try {
      const g = await cachedFetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
        { ttl: 86400000 }
      );
      const r = (g.results || [])[0];
      if (r) {
        coords = { lat: r.latitude, lon: r.longitude };
        country = r.country || "";
      } else {
        coords = { lat: 39.9075, lon: 116.39723 };
        country = "中国";
      }
    } catch (e) {
      coords = { lat: 39.9075, lon: 116.39723 };
      country = "中国";
    }
  }
  const f = await cachedFetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=7`,
    { ttl: 600000 }
  );
  const cur = f.current || {};
  const daily = f.daily || {};
  if (!cur.temperature_2m && !daily.time) {
    try {
      const w = await getWeatherWttr(city, coords.lat, coords.lon);
      weatherCache.data = w;
      weatherCache.key = key;
      weatherCache.at = Date.now();
      return w;
    } catch (e) { /* 保留空结果，前端显示数据源受限 */ }
  }
  const days = ((daily.time) || []).map((d, i) => ({
    date: d,
    ...wmoInfo((daily.weather_code || [])[i]),
    tmax: (daily.temperature_2m_max || [])[i],
    tmin: (daily.temperature_2m_min || [])[i],
    pop: (daily.precipitation_probability_max || [])[i],
  }));
  const data = {
    city,
    country,
    lat: coords.lat,
    lon: coords.lon,
    current: {
      temp: cur.temperature_2m,
      feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m,
      wind: cur.wind_speed_10m,
      ...wmoInfo(cur.weather_code),
    },
    daily: days,
    fallback: false,
  };
  weatherCache.data = data;
  weatherCache.key = key;
  weatherCache.at = Date.now();
  return data;
}

async function getWeatherByIP(clientIp) {
  try {
    let ip = String(clientIp || "");
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);
    const isPrivate =
      !ip || ip === "::1" || ip === "127.0.0.1" ||
      ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.16.") || ip.startsWith("172.31.");
    const url = isPrivate ? "https://ipwho.is/" : `https://ipwho.is/${encodeURIComponent(ip)}`;
    const j = await cachedFetch(url, { ttl: 3600000 });
    if (j && j.success && j.city && j.latitude && j.longitude) {
      const w = await getWeather(j.city, j.latitude, j.longitude);
      return w;
    }
  } catch (e) { /* fallthrough */ }
  return getWeather("北京");
}

async function getRepoTree() {
  try {
    const j = await cachedFetch(`https://api.github.com/repos/${GITHUB_USER}/jarvis-terminal/git/trees/main?recursive=1`, {
      headers: { "User-Agent": "jarvis-terminal" }, ttl: 900000,
    });
    const tree = (j.tree || []).filter((x) => x.type === "blob").map((x) => ({ path: x.path, type: "file", size: x.size || 0 }));
    return { tree, fallback: false };
  } catch (e) {
    return { tree: [{ path: "README.md", type: "file", size: 0 }], fallback: true };
  }
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

const APP_DIRS = ["/Applications", join(process.env.HOME || "/", "Applications")];
function getApps() {
  const apps = [];
  for (const dir of APP_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      for (const ent of readdirSync(dir)) {
        if (ent.endsWith(".app")) apps.push({ name: ent.slice(0, -4), path: join(dir, ent) });
      }
    } catch (e) { /* 单目录失败不影响 */ }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function openTarget(type, value) {
  const ROOT = process.cwd();
  if (!existsSync("/Applications")) {
    return Promise.resolve({ ok: false, localOnly: true, error: "本机功能仅在本机可用" });
  }
  if (type === "app") {
    const names = new Set([...getApps().map((a) => a.name), ...Object.keys(launchAllowlist)]);
    if (!names.has(String(value || ""))) {
      return Promise.resolve({ ok: false, error: `应用不在白名单：${value}` });
    }
    return new Promise((resolve) => {
      execFile("open", ["-a", String(value)], (err) =>
        resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true, message: `已启动 ${value}` })
      );
    });
  }
  const resolved = join(ROOT, String(value || "").replace(/^\/+/, ""));
  if (!resolved.startsWith(ROOT) || !existsSync(resolved)) {
    return Promise.resolve({ ok: false, error: "路径不合法或不存在" });
  }
  return new Promise((resolve) => {
    execFile("open", type === "reveal" ? ["-R", resolved] : [resolved], (err) =>
      resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true, message: type === "reveal" ? "已在访达中显示" : "已打开" })
    );
  });
}

function searchWorkspace(q) {
  const out = [];
  const qq = String(q || "").toLowerCase();
  const skip = new Set([".git", "node_modules", ".superpowers", ".playwright-cli", ".DS_Store"]);
  function walk(dir, depth) {
    if (depth > 3 || out.length >= 60) return;
    let ents = [];
    try { ents = readdirSync(dir); } catch (e) { return; }
    for (const ent of ents) {
      if (skip.has(ent)) continue;
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
    { re: /天气|气温|预报|下雨|降温/, mod: "weather", reply: "天气模块已打开，先生。当前天气与未来七天预报已更新。" },
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

function runCodex(message, systemPrompt = SYSTEM_PROMPT) {
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
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(`${systemPrompt}\n\n用户：${message}`);
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

async function runChatAPI(message, systemPrompt = SYSTEM_PROMPT) {
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
        { role: "system", content: systemPrompt },
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

const FATE_PROMPT = `你是「玄学顾问」，精通《周易》、命理、风水、节气民俗的中文顾问。
回答要求：引经据典但理性克制，明确区分「传统说法」与「个人建议」；语言文言与白话结合，称呼对方为「先生」。
不得承诺因果、不得制造焦虑；涉及健康、财务等重大决策时提醒理性参考。
回答末尾可给出一个可操作的小建议。`;

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function runDivine(message) {
  const useCodex = AGENT_MODE === "codex" || (AGENT_MODE === "auto" && codexAvailable());
  if (useCodex) {
    try {
      return { agent: "codex", reply: await runCodex(String(message), FATE_PROMPT) };
    } catch (e) { /* fallthrough */ }
  }
  if (process.env.OPENAI_API_KEY && (AGENT_MODE === "openai" || AGENT_MODE === "auto")) {
    try {
      return { agent: apiProvider(), reply: await runChatAPI(String(message), FATE_PROMPT) };
    } catch (e) { /* fallthrough */ }
  }
  const fallback = [
    "《易》曰：观乎天文，以察时变。先生所问之事，宜静观其变，三思而后行。",
    "天行健，君子以自强不息。此问无吉凶定数，惟在先生一念之间。",
    "亢龙有悔，盈不可久。眼下诸事宜守成，不宜冒进。",
  ];
  return { agent: "fallback", reply: fallback[Math.abs(hashCode(String(message))) % fallback.length] };
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
  if (url.pathname === "/api/hot" && url.searchParams.get("cn")) {
    try {
      const src = url.searchParams.get("src") || "all";
      const r = await getChinaHot(src);
      return json(res, 200, { ok: true, src, items: r.items, fallback: r.fallback });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), items: [] });
    }
  }
  if (url.pathname === "/api/hot") {
    try {
      return json(res, 200, { ok: true, items: await getHot() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), items: [] });
    }
  }
  if (url.pathname === "/api/bili/hot") {
    try {
      const r = await getBiliHot();
      return json(res, 200, { ok: true, items: r.items, fallback: r.fallback });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), items: [] });
    }
  }
  if (url.pathname === "/api/models") {
    try {
      return json(res, 200, { ok: true, ...(await getModelCatalog()) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), models: [] });
    }
  }
  if (url.pathname === "/api/weather") {
    try {
      const city = url.searchParams.get("city") || "北京";
      return json(res, 200, { ok: true, ...(await getWeather(city)) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }
  if (url.pathname === "/api/weather/ip") {
    try {
      const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const clientIp = fwd || (req.socket && req.socket.remoteAddress) || "";
      return json(res, 200, { ok: true, ...(await getWeatherByIP(clientIp)) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e) });
    }
  }
  if (url.pathname === "/api/github/activity") {
    try {
      return json(res, 200, { ok: true, ...(await getGitHubActivity()) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), contributions: [], repos: [] });
    }
  }
  if (url.pathname === "/api/repo/tree") {
    try {
      return json(res, 200, { ok: true, ...(await getRepoTree()) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), tree: [] });
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
  if (url.pathname === "/api/workspace/search") {
    try {
      const q = url.searchParams.get("q") || "";
      return json(res, 200, { ok: true, files: searchWorkspace(q) });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), files: [] });
    }
  }
  if (url.pathname === "/api/apps") {
    try {
      if (!existsSync("/Applications")) return json(res, 200, { ok: true, localOnly: true, apps: [] });
      return json(res, 200, { ok: true, localOnly: false, apps: getApps() });
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e.message || e), apps: [] });
    }
  }
  if (url.pathname === "/api/open" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { type, value } = JSON.parse(body || "{}");
        return json(res, 200, await openTarget(String(type || ""), String(value || "")));
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }
  if (url.pathname === "/api/divine" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      try {
        const { message } = JSON.parse(body || "{}");
        if (!message || !String(message).trim()) {
          return json(res, 400, { ok: false, error: "message 为空" });
        }
        return json(res, 200, { ok: true, ...(await runDivine(String(message))) });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
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
