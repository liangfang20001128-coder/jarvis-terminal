#!/bin/sh
# 安装贾维斯智能体服务为 macOS 登录自启（launchd），实现本地永久运行
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.jarvis"
cp "$SCRIPT_DIR/com.jarvis.agent.plist" "$HOME/Library/LaunchAgents/com.jarvis.agent.plist"
launchctl unload "$HOME/Library/LaunchAgents/com.jarvis.agent.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.jarvis.agent.plist"
echo "JARVIS 智能体服务已安装并常驻（开机自启）。日志：~/.jarvis/agent.log"
