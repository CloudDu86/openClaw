#!/bin/bash
set -e

echo "============================================"
echo "  Automaton Scanner - Container Starting"
echo "============================================"

# ── 1. 将关键环境变量写入 /etc/environment ──
# cron 不继承容器环境变量，必须通过文件传递
echo "[INIT] Writing environment to /etc/environment ..."
env | grep -E '^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ANTHROPIC_API_KEY|NODE_PATH|PATH)=' > /etc/environment

# ── 2. 启动 cron 守护进程 ──
echo "[INIT] Starting cron daemon ..."
cron

# ── 3. 启动 OpenClaw daemon (后台，非阻塞) ──
if command -v openclaw &>/dev/null; then
  echo "[INIT] Starting OpenClaw daemon ..."
  nohup openclaw daemon >> /var/log/openclaw.log 2>&1 &
  echo "[INIT] OpenClaw daemon PID: $!"
else
  echo "[WARN] OpenClaw not found, skipping daemon"
fi

# ── 4. 立即执行一次扫描 ──
echo "[INIT] Running initial market scan ..."
node /app/market_scanner.mjs >> /var/log/scanner.log 2>&1 || true
echo "[INIT] Initial scan complete."

# ── 5. 保持容器存活，输出日志 ──
echo "[INIT] Entering cron loop. Scanner runs every 10 minutes."
echo "============================================"
tail -f /var/log/scanner.log
