# 贾维斯终端 · 模块实用性升级与贾维斯音色设计文档

日期：2026-08-07
状态：已获用户确认（方案 A 音色 + 模块实用性最终版）

## 1. 目标

1. 七个模块从「展示型」升级为「实用型」，每个模块接入真实、可用的数据源与能力，优先使用 GitHub 高星开源项目与免密钥公开接口。
2. 语音输出尽量贴近《钢铁侠》贾维斯音色：免费方案（方案 A），用系统英式男声调校，英文指令句讲英语、中文回复讲中文，整体低沉、从容。

## 2. 语音系统（方案 A）

### 2.1 音色策略

- 英文台词：优先选择 en-GB 男声（macOS：Daniel；浏览器 Web Speech：Google UK English Male / Daniel），rate ≈ 0.92–0.98，pitch ≈ 0.72–0.82，音量 1.0。
- 中文回复：优先选择中文男声（macOS：Reed / Grandpa；浏览器回退到任意 zh-CN 男声，找不到则用系统默认），同样做低沉调校（pitch ≈ 0.8）。
- 每条台词发音前先 `speechSynthesis.cancel()`，避免叠音。

### 2.2 贾维斯英文台词（预置，可在设置里切换中英）

- 开机/唤醒：`Systems online, sir.`
- 模块启动：`At your service, sir.`
- 任务完成：`Task complete, sir.`
- 未识别指令：`I'm afraid I didn't catch that, sir.`
- 语音待命/结束：`Listening, sir.` / `Standing by.`

### 2.3 设置面板

- 语音开关（沿用 TTS 开关）、音色试听按钮、音调与语速滑块、英文台词开关。
- 所有设置写入 localStorage，刷新后保留。

### 2.4 实现位置

- `web/index.html`：重构 `window.jarvis.speak`，新增 `window.jarvis.sayEN`、语音选择与调校逻辑。

## 3. 七个模块升级

### 3.1 对话（chat）

- 保留现有真实对话（本地 Codex 免费 / 云端 DeepSeek）。
- 新增快捷指令 chips：打开热点、播放音乐、今日运势、整理文件、语音模式。
- 新增英文贾维斯台词播报（见 2.2）。

### 3.2 热点（hot）

- 数据源（服务端代理聚合，多源自动切换）：
  - 微博热搜：`https://weibo.com/ajax/side/hotSearch`（带 UA/Referer；备用：公开聚合 API）。
  - 知乎热榜：`https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total`。
  - 百度热搜：`https://top.baidu.com/board?tab=realtime`（解析内嵌 JSON）。
  - 抖音热点：优先公开聚合接口，失败自动隐藏并提示「抖音源暂不可用」。
  - 保留原 36氪 / 少数派 / 澎湃 / Hacker News 资讯源。
- UI：平台 tab 切换（微博 / 知乎 / 百度 / 抖音 / 综合）、热度数值显示、点击直达原文、关键词搜索过滤、60 秒自动刷新、来源徽标（真实数据 / 备用源）。

### 3.3 AI 前沿（ai）

- 保留 arXiv 论文 + Hugging Face 热门模型。
- 新增 OpenRouter 模型目录（`https://openrouter.ai/api/v1/models` 服务端代理）：显示模型名、上下文窗口、输入/输出单价。
- 新增 Token 用量统计：前端记录对话消息数、估算 Token（汉字/英文加权），按日/周展示用量与估算成本（DeepSeek 单价常量可配置）。

### 3.4 行为洞察（habit）→ 网页内行为数据分析

- 记录维度（localStorage `jarvis-ana`）：
  - 模块打开次数与停留时长（沿用并扩展 `window.__track`）。
  - 点击行为：chips、快捷指令、模块内按钮。
  - 语音指令次数、聊天消息数、TTS 开关变化。
  - 页面滚动深度（每次滚动记录最大百分比）。
  - 活跃时段（小时分布）。
- 展示：今日/近 7 日活跃概览、最常用模块排行、功能点击榜、活跃时段柱状图、滚动深度、使用建议（如「上午 10 点最专注」）。
- 数据仅存本地，不上传。

### 3.5 影音（media）

- 「个人账号直通」区：一键新窗口打开 抖音网页版（douyin.com）、哔哩哔哩（bilibili.com）、QQ音乐网页版（y.qq.com）——登录态跟随用户浏览器。
- 「本机应用启动」区：若本机安装 抖音 / 哔哩哔哩 / QQ音乐极速版 等（经 JARVIS_LAUNCH 白名单），可一键启动桌面版。
- 「B站热榜」：服务端代理 `https://api.bilibili.com/x/web-interface/ranking/v2`，列表点击后用官方内嵌播放器（`player.bilibili.com/player.html?bvid=...`）直接播放。
- 「电台 / 曲库」：SomaFM 公开直播流 + Internet Archive 公开音频搜索（服务端代理）。

### 3.6 空间（space）

- 本机（localhost）：
  - 应用列表：读取 `/Applications` + `~/Applications`，一键 `open -a` 启动。
  - 文件：工作空间文件浏览（已有）+ 名称搜索 + 按类型筛选 + 一键打开（`open`）与在访达中显示（`open -R`），仅限工作空间目录白名单。
- 线上（GitHub Pages + Render）：
  - 通过 GitHub API 读取公开仓库文件树（jarvis-terminal），显示仓库结构；启动器/本地文件功能自动隐藏并提示「本机功能」。

### 3.7 时运（fate）

- 农历与玄学基础数据：内置 `lunar-javascript`（GitHub 高星、MIT），前端离线计算：农历日期、节气、干支、宜忌、值神、冲煞、生肖、星座、六十四卦（日期种子算法）。
- 每日玄学信息：按日期自动生成（农历 + 卦象 + 宜忌 + 运势），缓存 24 小时。
- 「玄学顾问」子智能体：
  - 后端新增 `POST /api/divine`，使用独立系统人格（周易/命理/玄学专家，风格文言雅致、辩证理性）。
  - 本地走 Codex CLI（自定义 system prompt），云端走 DeepSeek（自定义 system message），失败降级为内置卦辞回复。
  - 前端时运模块内嵌对话输入框，一问一答。

## 4. 后端新增接口（agent-server.mjs）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/hot?src=weibo|zhihu|baidu|douyin|all` | GET | 中国社交平台热点聚合（缓存 120s，多源回退） |
| `/api/bili/hot` | GET | B站综合热榜（缓存 300s） |
| `/api/models` | GET | OpenRouter 模型目录（缓存 6h）+ 本地 Token 用量 |
| `/api/github/activity` | GET | 用户 GitHub 公开活跃/仓库（缓存 15min） |
| `/api/apps` | GET | 本机应用列表（仅本地，云端返回空 + 标记） |
| `/api/open` | POST | 打开应用/文件/访达定位（仅本地 + 白名单） |
| `/api/divine` | POST | 玄学顾问子智能体（自定义人格） |
| `/api/fortune/daily` | GET | 当日玄学信息（农历/卦象/宜忌，缓存 24h） |

### 4.1 可靠性设计

- 每个数据接口有「主源 → 备用源 → 内置样例」三级回退；回退时返回 `fallback: true` 标记，前端显示「备用数据」徽标。
- 缓存 TTL 见上表；缓存失败不影响请求。
- 本地专属接口（/api/apps、/api/open）在云端（无本机文件系统语义）返回空并标记 `localOnly: true`，前端据此切换展示。

## 5. 前端改造

- `web/index.html`：
  - 热点模块 tab 化 + 搜索；AI 模块模型目录与 Token 用量；行为模块分析面板；影音模块三区布局；空间模块本地/线上双态；时运模块玄学顾问聊天 + 每日信息。
  - 行为追踪器 `window.__track` 扩展为全页面事件采集。
  - 语音系统重构（2 节）。
- `web/vendor/lunar.js`：内置 lunar-javascript（离线可用）。
- `web/config.js`：保持不变（地址桥接）。

## 6. 验证方式

1. 本地启动桥接服务，逐一 `curl` 新接口，确认返回真实数据（微博/知乎/B站热榜等）。
2. 本地浏览器打开终端：逐模块人工核验（真实数据出现、播放器可播、玄学顾问可回答、语音发声）。
3. 行为分析：打开/点击/滚动后查看数据是否增长。
4. 推送到 GitHub → GitHub Pages 与 Render 自动部署。
5. 线上核验：网页数据源可访问、B站热榜可播、云端玄学顾问走 DeepSeek。

## 7. 安全与边界

- 本地文件操作仅限工作空间目录与 JARVIS_LAUNCH 白名单，不开放任意路径。
- 密钥不写入代码/仓库；新接口均为公开数据，无需密钥。
- 行为数据仅存本机 localStorage。
- 抖音热点若接口不可用，明确展示降级说明，不伪造数据。

## 8. 实施顺序

1. 后端：新增数据接口 + 玄学顾问 + 缓存回退。
2. 前端：行为追踪器 → 热点 → AI → 影音 → 空间 → 时运 → 对话快捷指令 → 语音系统。
3. 本地验证（接口 + 浏览器）。
4. 推送部署，线上验证。
