// 贾维斯终端 · 智能体/数据桥接服务地址
// 本地打开（localhost）→ 连本机常驻服务（Codex + 真实数据）
// 线上打开（GitHub Pages）→ 连 Render 云端服务（真实数据；对话走 OpenAI/DeepSeek API）
(function () {
  var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  window.JARVIS_AGENT_URL =
    window.JARVIS_AGENT_URL ||
    (isLocal ? 'http://127.0.0.1:8787' : 'https://jarvis-agent-oqcy.onrender.com');
})();
