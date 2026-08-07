# 贾维斯 2.0 审计报告：功能重复性 + 数据健壮性 + 效率

审计日期：2026-08-08
审计范围：web/index.html（3064 行）、agent-server.mjs（1038 行）、部署与接口实测
审计维度：功能重复性、数据/API 健壮性、代码效率；含与安全维度的联动发现
严重度：P0=必须立即修，P1=高优先，P2=改进项，P3=打磨项

## 一、执行摘要

八个模块已全部接入真实数据源，整体实用性良好；主要问题集中在三类：

1. **前端一次性缓存导致数据会话内永不过期**（P1）：中国热点/B站热榜/模型目录首次加载后不再刷新，定时器空转，用户看到的是陈旧数据。
2. **多源抓取全部串行**（P2）：综合热点实测本机 2.98s，云端海外访问中国源更慢，前端 15s 超时易失败。
3. **新旧两套弹层系统并存 + 应用启动双通道 + 行为统计四套存储**（P2）：死代码与重复逻辑并存，维护和口径容易漂移。

另有 1 项跨维度安全联动发现（本机服务 0.0.0.0 + CORS * + 无鉴权）建议与安全审计合并处理。

## 二、模块实用性评分（1-10）

| 模块 | 评分 | 依据 |
|---|---|---|
| 对话 | 9 | 本地 Codex 免费真实对话，云端 DeepSeek；英文台词与音色调校；无加载态与超时是短板 |
| 热点 | 9 | 综合 + 微博/知乎/百度/抖音多平台真实数据；但会话内不刷新（P1） |
| 天气 | 8.5 | Open-Meteo + wttr 双源，IP 定位，7 天预报；双源都失败时无空态提示 |
| AI 前沿 | 8 | 论文/模型/目录真实；Token 用量与成本为本地估算，非服务端真实 usage |
| 时运 | 8 | 农历/干支/宜忌真实离线计算；玄学顾问走真实智能体；运势分为伪随机，需明确娱乐属性 |
| 行为洞察 | 7.5 | 真实网页行为（点击/停留/滚动/语音/对话）；四个存储键碎片化，无建议生成 |
| 空间 | 7.5（本地）/ 5（云端） | 本地应用/文件/访达真实可用；云端仅仓库浏览器；启动白名单默认全空导致媒体模块启动按钮必失败 |
| 影音 | 7 | B站热榜内嵌播放真实；电台真实；抖音/QQ音乐受平台限制只能跳转；本机/云端提示反转（P2） |

最实：对话、热点、天气。最虚：影音（受平台政策约束，功能边界需向用户明示）、空间（云端弱）。

## 三、功能重复性发现

1. **P2 新旧两套弹层系统并存**：旧版 drawer/deep 抽屉系统（web/index.html:1347-1360 openDrawer/closeDrawer/onPanelClick）与新版原位展开系统（1551-1583、1717-1791 openLayer/closeLayer 两次定义覆盖）并存。旧系统为死代码，逻辑重复且易漂移。
2. **P2 展开面板内三套操作控件并存**：win-bar 交通灯（1404-1430）+ exp-close ✕（1521/1653）+ exp-more（1520/1652）。同一动作多个入口，win-bar 常驻模块左上角叠加在内容上（CSS 207），正是「按钮都挤到最上角」问题的根源。
3. **P2 天气代码映射表前后端各一份**：WMO/wmoInfo 在 agent-server.mjs:348-363 与 web/index.html:2295-2306 重复定义，改一处忘一处即不同步。
4. **P2 后端死接口**：/api/github/activity（agent-server.mjs:308-335）已被前端行为分析替代，前端无任何调用。/api/workspace（本地文件）与 /api/repo/tree（GitHub 仓库文件）功能重叠，空间模块同时展示两份文件列表。
5. **P2 应用启动双通道且安全模型不一致**：/api/launch（agent-server.mjs:645-660，受 JARVIS_LAUNCH 白名单约束）与 /api/open type=app（592-617，任意已装应用名即可启动，无白名单）。媒体模块用 launch、空间模块用 open，UI 与安全口径不统一。
6. **P2 行为统计四套 localStorage 键碎片化**：jarvis-usage（recordUse 次数）、jarvis-ana（__anal 点击/语音/对话/滚动）、jarvis-focus（__track 停留时长）、jarvis-tokens。同一交互被多处计数（如点击快捷指令同时 recordUse + __anal），口径混乱，无法导出统一画像。
7. **P3 模块白名单不一致**：SYSTEM_PROMPT（agent-server.mjs:26-40）模块白名单漏了 weather，与 MODULES（24 行）不一致；前端 FALLBACK 含 weather。模型可能拒绝天气模块指令。

## 四、数据/API 健壮性发现

1. **P1 前端一次性缓存，会话内数据永不过期**：loadChinaHot（web/index.html:2127-2138）、loadBili（2146-2157）、loadModels（2165-2174）均为 `if (LIVE.x.length) return ...`。首次加载后微博/知乎/百度/抖音/B站热榜/模型目录在整个会话内不再刷新；后端 TTL 120-300s 形同虚设，setInterval(loadBili,300000)（2783）为空转。
2. **P2 后端多源串行抓取**：getHot（agent-server.mjs:110-164）三个 RSS + HN 顺序 await（实测本机 2.98s）；getBiliHot（249-288）三个备用源顺序尝试；getAi（arxiv 12s + HF 10s 顺序）。云端海外访问中国源时叠加 DNS/超时，前端 15-25s 超时易失败。应 Promise.allSettled 并行 + 首条胜出。
3. **P2 首屏并发 13 个请求**（web/index.html:2780 附近 loadHot/loadAi/loadSpace/4×loadChinaHot/loadBili/loadModels/loadApps/loadRepoTree/loadWeatherIP）：慢网下排队拖慢首屏；应模块展开时才懒加载。
4. **P2 搜索无防抖无取消**：loadSearch（2198-2208）每次击键发请求，无 AbortController，旧响应可覆盖新结果（竞态）。
5. **P2 滚动统计无节流**：__anal('scroll')（2255-2270）每次滚动事件 JSON.parse + localStorage.setItem，频繁写盘。
6. **P2 聊天无超时无加载态**：send()（约 1902）直接 fetch 无 abort；Codex 最长 120s、云端 API 慢时 UI 无「思考中」提示，可能长时间无响应。
7. **P2 DEEP.media 本机/云端提示反转**（web/index.html:2633 附近）：`LIVE.localOnly=true` 表示云端，但代码在云端显示「本机可一键启动桌面版」、本机显示「启动桌面版（需白名单）」，条件写反；且本地启动需 JARVIS_LAUNCH 白名单（实测 /api/status launchKeys=[]），当前配置下点击必失败。
8. **P2 天气降级链不完整**：wttr 备用仅当 current 与 daily 同时缺失才触发（agent-server.mjs:461-468 附近），半失败态（current 缺、daily 有）不降级；双源都失败时前端无明确空态文案。
9. **P3 Token 用量为估算**：按字符数/1.5 折算（web/index.html:2275-2288），中英文差异大；成本固定按 DeepSeek 价，本地 Codex 免费通道也显示成本。服务端 DeepSeek 响应含 usage 字段，可回传真实用量。
10. **P3 每日运势 localStorage 键不清理**：jarvis-fate-YYYY-M-D（2217-2235）每天新增一个键。
11. **P3 runCodex 临时文件不清理**（agent-server.mjs:684-708 每次写 /tmp/jarvis-codex-*.txt）；runChatAPI（729-750）无请求超时。
12. **P3 respCache 无淘汰**（agent-server.mjs:99-105）：按 URL 无限缓存，长期运行内存增长。

## 五、效率发现

1. **P2 定时器不感知页面可见性**：loadHot 60s / loadAi 600s / loadBili 300s / loadWeatherIP 600s / renderHabit 30s / refreshMiniAll 30s / 地球 30s / 时钟 1s（web/index.html:2781-2786 等）在后台标签页持续轮询与渲染；应 document.hidden 暂停。
2. **P3 loadHot 启动三连**：立即调用 + setTimeout 900ms + setInterval 60s 重复触发。
3. **P3 refreshOpen 每次全量重建内层 HTML**（2119-2122）：数据刷新时展开面板整块 innerHTML 重建，输入框失焦、滚动位置重置。

## 六、跨维度联动发现（交安全审计合并）

1. **P0 本机服务 0.0.0.0 + CORS * + 无鉴权**（agent-server.mjs:1034 监听、json() 写 Access-Control-Allow-Origin:*）：任意网页或局域网设备可 POST /api/open（打开任意已装应用）、/api/launch、/api/chat（消耗本地 Codex / 云端配额）、GET /api/workspace。建议本机绑定 127.0.0.1 + Origin 白名单 + 简单本地 token。
2. **P1 openTarget 路径未做符号链接检查**（agent-server.mjs:592-617）：join 前缀校验可被符号链接绕过读取项目外文件。
3. **P1 前端 esc() 不转义双引号**：App 名/链接拼入 onclick 双引号属性（web/index.html 空间模块 2600 附近），含引号数据存在属性注入面。

## 七、2.0 优化建议

1. **前端缓存改为 TTL 感知**：LIVE.cnHot/bili/models 记录 fetchedAt，展开模块时超过 TTL（热点 3 分钟、B站 5 分钟、模型 6 小时）静默刷新；删除空转 interval。
2. **后端多源并行化**：getHot/getBiliHot/getAi 改 Promise.allSettled，首条成功即返回；runChatAPI 加 AbortController 超时并从响应 usage 回传真实 token 用量与成本。
3. **统一模块职责与存储**：删除 drawer/deep 旧系统与 /api/github/activity 死代码；应用启动统一走 JARVIS_LAUNCH 白名单（openTarget app 复用）；行为统计合并为单一按日聚合 store，支持导出。
4. **修复交互短板**：搜索防抖 300ms + AbortController；滚动统计节流 500ms；聊天加「思考中」状态与 30s 超时提示；修复 DEEP.media 本机/云端提示反转与白名单预置；数据加载改模块展开懒加载 + document.hidden 暂停轮询。
5. **数据健康度可视化**：新增 /api/health 汇总各数据源最近成功时间/fallback 状态，前端状态栏显示数据健康度徽标。
6. **安全收口**：本机绑定 127.0.0.1、Origin 白名单、本地 token；workspace 读取限定白名单目录并校验真实路径（realpath）；respCache 加 LRU 淘汰；runCodex 临时文件用后即删。
