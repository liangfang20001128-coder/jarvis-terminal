# 贾维斯全息智能终端

一个本地优先的全息终端：毛玻璃 + 全息投影 UI、实时地球、可拖动模块、Apple 风格原位放大、智能环境调色、Codex 智能体对话，以及接入真实数据的七大模块（对话 / 热点 / AI 模型 / 行为洞察 / 影音 / 空间 / 时运）。

## 本地运行

1. 启动智能体/数据桥接服务：
   ```sh
   node agent-server.mjs
   ```
   服务监听 `http://127.0.0.1:8787`，提供：Codex 对话（`/api/chat`）、实时热点（`/api/hot`）、AI 前沿（`/api/ai`）、真实文件（`/api/workspace`）、应用启动（`/api/launch`）。
2. 打开终端页面：
   ```sh
   open web/index.html
   ```
   或任意静态服务器：`python3 -m http.server -d web 8000` 后访问 `http://localhost:8000`。

## 本地永久运行（macOS 开机自启）

```sh
chmod +x deploy/install-agent-service.sh
./deploy/install-agent-service.sh
```

智能体服务会随登录自动常驻，日志在 `~/.jarvis/agent.log`。卸载：

```sh
launchctl unload ~/Library/LaunchAgents/com.jarvis.agent.plist
```

## 接入 GitHub 并永久托管（GitHub Pages）

1. 在 GitHub 创建一个仓库（建议 private），然后：
   ```sh
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 推送后，仓库里的 `.github/workflows/pages.yml` 会自动把 `web/` 部署到 GitHub Pages，终端永久可访问：`https://<你的用户名>.github.io/<仓库名>/`。
3. 注意：线上页面默认连接本地桥接服务（`http://127.0.0.1:8787`）。要让线上页面也用上真实数据和 Codex，把 `agent-server.mjs` 部署到任意 Node 云主机（Render / Railway / Fly.io 等），然后修改 `web/config.js`：
   ```js
   window.JARVIS_AGENT_URL = 'https://你的线上API地址';
   ```
   未配置线上 API 时，页面会自动以演示数据运行，不白屏。

## 配置项（环境变量，agent-server.mjs）

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `JARVIS_PORT` | 服务端口 | `8787` |
| `JARVIS_AGENT` | `auto` / `codex` / `fallback` | `auto` |
| `CODEX_BIN` | Codex CLI 路径 | 默认 ChatGPT.app 内置 |
| `OPENAI_API_KEY` | 云端对话用 API Key（可选） | `sk-...` |
| `JARVIS_OPENAI_MODEL` | 云端对话模型 | `gpt-4.1-mini` |
| `JARVIS_LAUNCH` | 应用启动白名单 | `{"微信":"WeChat"}` |
| `JARVIS_GAME_URL` | 游戏登录地址 | `https://example.com/login` |

## 云端部署（真实数据 + 大模型对话，永久在线）

把 `agent-server.mjs` 部署到免费 Node 云主机后，线上页面也能用真实数据 + 大模型对话：

1. **Render**：新建 Blueprint 指向本仓库（`render.yaml` 已就绪），或 New Web Service → Docker。
2. **Fly.io**：`fly.toml` 已就绪，`fly launch` 后 `fly deploy`。
3. 在云平台环境变量中设置：
   - `JARVIS_AGENT=auto`
   - `OPENAI_API_KEY=sk-...`（不填则对话为演示路由，数据接口仍真实）
   - `JARVIS_OPENAI_MODEL=gpt-4.1-mini`（可按需更换）
4. 部署完成后修改 `web/config.js`：
   ```js
   window.JARVIS_AGENT_URL = 'https://你的服务.onrender.com';
   ```
5. 推送仓库，GitHub Actions 自动把线上终端发布到 GitHub Pages。

> 说明：`JARVIS_LAUNCH`（启动本地应用）仅在本机 launchd 服务生效；云端无桌面环境，该配置无效。`Dockerfile` 适用于 Render / Railway / Fly.io 等。

## 目录

- `web/index.html`：可部署的终端页面（GitHub Pages 直接托管 `web/`）
- `agent-server.mjs`：本地桥接服务（Codex + 实时数据聚合）
- `deploy/`：macOS 常驻服务与安装脚本
- `docs/superpowers/specs/`：设计文档
