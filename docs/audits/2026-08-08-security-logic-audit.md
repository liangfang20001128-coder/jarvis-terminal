# 贾维斯 2.0 审计报告：安全 + 代码逻辑

审计日期：2026-08-08
审计范围：agent-server.mjs（1038 行，全文）、web/index.html（3064 行，重点逻辑与注入面）、web/config.js、Dockerfile、render.yaml、package.json、.github/workflows/pages.yml、git 历史密钥扫描
审计维度：安全（密钥/注入/路径/网络/本地权限/部署）、代码逻辑（状态机/竞态/资源泄漏/一致性）
严重度：P0=必须立即修，P1=高优先，P2=改进项，P3=打磨项

## 一、执行摘要

项目整体架构清晰、数据源真实、无明显被提交的密钥。主要风险集中在「本机服务暴露面过大 + 高危接口无鉴权」这一组合：服务监听 0.0.0.0、CORS `*`、无认证，而同一进程内存在「启动任意应用」「读取工作区文件」「消耗对话配额」的接口，构成 P0。逻辑侧的主要问题是前端一次性缓存导致数据会话内过期、聊天无超时无加载态、以及新旧两套弹层系统并存。安全与逻辑共记 P0×1、P1×4、P2×12、P3×6。

## 二、安全发现

### P0-1 本机服务监听 0.0.0.0 + CORS `*` + 无鉴权，任意网页/局域网设备可调用高危接口
位置：agent-server.mjs:1034（`server.listen(PORT, process.env.JARVIS_HOST || "0.0.0.0")`）、:805（`Access-Control-Allow-Origin: *`）
问题：任意网页（浏览器可跨域请求本地端口，CORS `*` 允许读响应）或局域网内任何设备都能：
- POST /api/open（openTarget 的 app 分支允许启动**任意已装应用**，:592-617）；
- GET /api/workspace、/api/workspace/search（读取/搜索工作区文件列表）；
- POST /api/chat、/api/divine（消耗本地 Codex CLI 与云端 DeepSeek 配额）。
修复：本机默认绑定 127.0.0.1；CORS 改为白名单 Origin（本机仅允许 localhost 页面）；写接口校验本地令牌（如 `X-Jarvis-Token`，由 config.js 注入）；对 /api/chat、/api/divine、/api/open 加限流。

### P1-1 openTarget 路径校验可被前缀匹配与符号链接绕过
位置：agent-server.mjs:610-617
问题：`resolved = join(ROOT, value.replace(/^\/+/, ""))` 后仅做 `resolved.startsWith(ROOT)` 字符串前缀判断。前缀无路径边界，`../贾维斯-evil/x` 这类兄弟目录路径也会通过；工作区内符号链接指向项目外时同样绕过，随后交给 `open` 执行。且 type 未枚举校验，任意值走文件打开分支。
修复：`path.resolve` + `fs.realpathSync` 后做「真实路径 + 分隔符边界」双重校验；type 白名单枚举（app/file/reveal）；非本机请求一律拒绝。

### P1-2 应用启动双通道，openTarget 绕过白名单
位置：agent-server.mjs:598（`new Set([...getApps().map(a=>a.name), ...Object.keys(launchAllowlist)])`）与 :645-660（launchApp 白名单）
问题：/api/launch 受 JARVIS_LAUNCH 白名单约束，而 /api/open 的 app 分支把「系统全部已装应用」都算作可启动，安全口径不一致；在 P0-1 无鉴权背景下等于远程可启动任意应用。
修复：统一走 JARVIS_LAUNCH 白名单；openTarget 的 app 分支复用 launchApp；白名单预置常用应用（抖音/哔哩哔哩/QQ音乐等）。

### P1-3 前端 inline onclick 属性注入面（转义不闭合）
位置：web/index.html:2080（esc 不转义引号）、:2585-2586/:2601-2605/:2635-2637（应用名/文件路径拼入 onclick 单引号字符串，仅 `.replace(/'/g,"&#39;")`）
问题：HTML 属性解析会把 `&#39;` 解码回单引号再执行 JS，因此该转义在属性上下文中不成立；若本地文件名/应用名含 `');…` 可构造属性级注入。数据当前来自本地文件系统（实际触发面低），但属可修复的注入模式。
修复：改用 `data-type/data-value` 属性 + 事件委托（addEventListener），彻底移除 inline onclick；esc 补充 `'`/`"` 转义。

### P2-1 POST 请求体无大小限制
位置：agent-server.mjs:921/:934/:950/:963
问题：`req.on("data", d => body += d)` 无限累积，恶意大请求可耗尽内存。
修复：统一加 body 解析中间件，限制 1MB 并处理超限；同时给整个请求加超时。

### P2-2 runCodex 临时输出文件不清理；runChatAPI 无超时
位置：agent-server.mjs:684-708、:729-750
问题：每次 Codex 调用在 /tmp 写 `jarvis-codex-<uuid>.txt` 且从不删除（文件内含模型输出，属隐私残留）；云端 API 请求无 AbortController，慢服务可无限挂起。
修复：finally 中 unlink 临时文件并以 0600 创建；runChatAPI 加 60s 超时；超时/失败信息不进日志明文。

### P2-3 无速率限制，对话/占卜/启动接口可被刷
位置：agent-server.mjs:921-1018
问题：/api/chat、/api/divine、/api/open、/api/launch 均无频率限制，无鉴权时会被用于消耗配额与 CPU。
修复：简单内存令牌桶（每 IP 每分钟 N 次），本机环回可放宽。

### P2-4 respCache 无淘汰、cachedFetch 无响应体大小上限
位置：agent-server.mjs:99-105
问题：按 URL 无限缓存 Map，长期运行内存持续增长；远端返回超大 JSON 时 `r.json()` 直接全量解析。
修复：LRU（上限 100 条）；对响应体做长度截断/上限（如 4MB）；缓存键加入 source 前缀避免跨源串扰。

### P2-5 无 Host 校验（DNS rebinding 面）+ XFF 完全信任
位置：agent-server.mjs:createServer（约 808 行）、:890-893（/api/weather/ip）
问题：0.0.0.0 绑定下任意域名可直连服务；/api/weather/ip 直接取 `x-forwarded-for` 首项（本机场景可伪造，仅影响 ipwho.is 查询，低危）。
修复：校验 Host 为 127.0.0.1/localhost 白名单；本机忽略 XFF，云端仅信任代理设置且校验来源。

### P3-1 安全响应头缺失
位置：agent-server.mjs:802-807（json 头）
问题：API 响应无 X-Content-Type-Options、Referrer-Policy；页面无 CSP（当前内联脚本架构下难以直接加）。
修复：API 补安全头；2.0 将内联脚本外置后为页面加 CSP。

### P3-2 密钥管理结论（已验证）
仓库工作树与 git 全历史扫描：未发现 sk-* / github_pat_* / ghp_* 等明文密钥；render.yaml 使用 `sync: false` 从后台注入，方向正确。提醒：此前对话中出现过 DeepSeek 密钥与 GitHub PAT，建议轮换；本地钥匙串 PAT 9 月 6 日到期需续期。

## 三、代码逻辑发现

### P1-1 前端一次性缓存：热点/B站/模型目录会话内永不过期
位置：web/index.html:2127-2138（loadChinaHot）、:2146-2157（loadBili）、:2165-2174（loadModels）
问题：`if (LIVE.x.length) return …` 首次成功即永久缓存，后端 TTL（120-300s）形同虚设，2783 行定时器空转。
修复：缓存对象记录 fetchedAt，展开模块时超 TTL（热点 3 分钟、B站 5 分钟、模型 6 小时）静默刷新；删除空转 interval。

### P1-2 影音模块本机/云端提示反转且启动必失败
位置：web/index.html:2641-2643
问题：`LIVE.localOnly=true` 表示「云端、无本机」，代码却显示「本机可一键启动…」；本机反而显示「需白名单」，且白名单默认 `{}`，点击启动必然失败。
修复：条件反转；服务端预置常用应用白名单并随 /api/status 返回可启动列表。

### P2-1 新旧两套弹层系统并存 + 面板内三套操作控件
位置：web/index.html:1317-1360（旧 drawer 死代码）、:1510/:1551 与 :1626/:1679/:1717/:1718（openLayer/closeLayer 重复定义互相覆盖）、:1520-1521/:1652-1653/:1404-1430（exp-more + exp-close + win-bar 三入口）
问题：同一动作多个入口且语义不一致；重复定义使首个实现被静默覆盖，正是「按钮挤在最上角」的根源。
修复：2.0 统一为 macOS 交通灯一套控件，删除旧系统与重复定义。

### P2-2 聊天无超时、无加载态
位置：web/index.html:1896-1944（send 裸 fetch，无 AbortController）
问题：Codex 最长 120s、云端 API 慢时界面无「思考中」提示，用户可能以为卡死。
修复：加「思考中」气泡 + 30s 超时提示 + 失败重试一次。

### P2-3 文件搜索无防抖无取消
位置：web/index.html:2198-2208（loadSearch）
问题：每次击键发请求；无 AbortController，旧响应可覆盖新结果（竞态）。
修复：300ms 防抖 + 请求序号/AbortController 取消旧请求。

### P2-4 滚动统计无节流，高频写 localStorage
位置：web/index.html:2787-2788（scroll 监听）→ :2250-2270（__anal 每次 JSON.parse + setItem）
问题：每次滚动都全量解析写盘，低端机卡顿。
修复：rAF 或 500ms 节流。

### P2-5 定时器不感知页面可见性
位置：web/index.html:2781-2786、:2989、:3060
问题：后台标签页持续轮询渲染（热点 60s/B站 300s/天气 600s/行为 30s/地球 30s/时钟 1s）。
修复：document.hidden 时暂停非关键轮询，可见后立即补一次。

### P2-6 首屏 13 个并发请求
位置：web/index.html:2780 附近
问题：慢网下排队拖慢首屏。
修复：改为模块展开时才懒加载；首页只加载状态与徽标。

### P2-7 系统提示词模块白名单漏 weather
位置：agent-server.mjs:26-40（SYSTEM_PROMPT）vs :24（MODULES）
问题：模型被明确禁止输出 [[module:weather]]，语音/对话切天气模块必然失败。
修复：SYSTEM_PROMPT 白名单与 MODULES 同步（补 weather）。

### P2-8 行为统计四套存储 + 双通道启动，口径碎片化
位置：web/index.html（jarvis-usage / jarvis-ana / jarvis-focus / jarvis-tokens）、agent-server.mjs:598/:645
问题：同一点击被多处计数（recordUse + __anal），无法导出统一画像；启动双通道安全口径不一。
修复：合并为单一按日聚合 store（含导出）；启动统一白名单通道。

### P3-1 refreshOpen 全量 innerHTML 重建
位置：web/index.html:2118-2123
问题：数据刷新时展开面板整块重建，输入框失焦、滚动位置重置。
修复：按数据区局部更新。

### P3-2 其余打磨项
- loadHot 启动三连（立即 + 900ms + 60s interval）；
- Token 用量按字符/1.5 估算（web/index.html:2275-2288），DeepSeek 响应含真实 usage 可回传；
- 每日运势 localStorage 键（jarvis-fate-YYYY-M-D）只增不清理；
- 天气 WMO 代码表前后端各一份（agent-server.mjs:348-363 与 web/index.html:2295-2306）；
- 后端多源抓取串行（getHot :110-164、getBiliHot :249-288、getAi arXiv 12s + HF 10s），应 Promise.allSettled 并行、首条胜出；
- 天气降级链不完整：仅 current 与 daily 同时缺失才切 wttr（:461-468），半失败态不降级。

## 四、2.0 安全收口落地清单

1. 本机默认绑定 127.0.0.1；CORS Origin 白名单；写接口本地令牌；POST body 1MB 上限；对话/占卜限流。
2. openTarget 改 realpath + 边界校验 + type 枚举；应用启动统一走 JARVIS_LAUNCH 白名单并预置常用应用。
3. 前端移除 inline onclick（data 属性 + 事件委托），esc 补引号转义。
4. runCodex 临时文件用后即删（0600）；runChatAPI 加 60s 超时；respCache 加 LRU。
5. 修复 P1 缓存过期与影音提示反转；删除旧弹层死代码；SYSTEM_PROMPT 补 weather；聊天加超时/加载态；搜索防抖；滚动节流；可见性暂停轮询。

## 五、总体结论

安全基线为「密钥管理合规、无已提交秘密」，主要矛盾是本机服务暴露面与高危接口的组合，需在 2.0 第一优先级收口（绑定环回 + 鉴权 + 白名单）。代码逻辑健康度中等偏上，问题集中在缓存策略、交互反馈与死代码清理；修复后模块数据新鲜度、启动成功率与交互可信度将显著提升。建议按 P0→P1 顺序实施，并在完成后做一次本地+云端回归验证。
