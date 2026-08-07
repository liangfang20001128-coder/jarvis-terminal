// 贾维斯终端 · 备用推送脚本（IPv6 异常时通过 GitHub API 上传工作区内容）
// 用法：JGT=<令牌> node --dns-result-order=ipv4first scripts/push-api.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.JGT;
const REPO = process.env.JGT_REPO || "liangfang20001128-coder/jarvis-terminal";
const ROOT = process.cwd();
const IGNORE = new Set([".git", ".superpowers", ".playwright-cli", "node_modules", ".DS_Store"]);

function collect(dir, base = "") {
  const out = [];
  for (const ent of readdirSync(dir)) {
    if (IGNORE.has(ent)) continue;
    const full = join(dir, ent);
    const rel = base ? base + "/" + ent : ent;
    if (statSync(full).isDirectory()) out.push(...collect(full, rel));
    else out.push(rel);
  }
  return out;
}

async function api(path, body, method = "POST") {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "jarvis-terminal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

if (!TOKEN) {
  console.error("缺少 JGT 令牌环境变量");
  process.exit(1);
}

async function apiGet(path) {
  const r = await fetch("https://api.github.com" + path, {
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "jarvis-terminal" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

const branches = await apiGet(`/repos/${REPO}/branches`);
if (!branches.length) {
  const readme = readFileSync(join(ROOT, "README.md")).toString("base64");
  await api(`/repos/${REPO}/contents/README.md`, { message: "init", content: readme }, "PUT");
  console.log("bootstrap via README");
}

const relFiles = collect(ROOT);
if (process.env.JGT_MODE === "contents") {
  const skipSet = new Set(["README.md", ".env.example"]);
  for (const rel of relFiles) {
    if (skipSet.has(rel)) continue; // 已上传
    if (rel.startsWith(".github/")) continue; // 需要 Workflows 权限，稍后手动添加
    const content = readFileSync(join(ROOT, rel)).toString("base64");
    await api(
      `/repos/${REPO}/contents/${rel}`,
      { message: `add ${rel}`, content, branch: "main" },
      "PUT"
    );
    console.log("uploaded:", rel);
  }
  console.log("CONTENTS UPLOAD DONE");
  process.exit(0);
}
const tree = [];
for (const rel of relFiles) {
  const content = readFileSync(join(ROOT, rel)).toString("base64");
  const blob = await api(`/repos/${REPO}/git/blobs`, { content, encoding: "base64" });
  tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  console.log("blob:", rel);
}
const t = await api(`/repos/${REPO}/git/trees`, { tree });
const head = await apiGet(`/repos/${REPO}/git/ref/heads/main`);
const c = await api(`/repos/${REPO}/git/commits`, {
  message: "feat: 贾维斯全息智能终端（GitHub Pages + Render 云端）",
  tree: t.sha,
  parents: [head.object.sha],
});
try {
  await api(`/repos/${REPO}/git/refs`, { ref: "refs/heads/main", sha: c.sha });
} catch (e) {
  await api(`/repos/${REPO}/git/refs/heads/main`, { sha: c.sha, force: true }, "PATCH");
}
console.log("PUSHED commit", c.sha, "files:", tree.length);
