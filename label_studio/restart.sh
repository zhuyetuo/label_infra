#!/bin/bash
# 重启 Python 后台服务（不重建 Docker 容器）
# 用法：bash label_studio/restart.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/label_infra/.env"

# 自动加载 .env
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

LS_PORT="${LS_PORT:-8181}"
MEDIA_PORT="${MEDIA_PORT:-8182}"
SERVER_IP="${SERVER_IP:-$(hostname -I | awk '{print $1}')}"
LS_DATA_DIR=~/label_infra/data/label_studio
TRANSCODED_DIR=~/label_infra/data/media/transcoded
LOG_FILE=~/label_infra/logs/transcode.log
UPLOAD_LOG=~/label_infra/logs/upload.log

if [ -z "$LS_API_KEY" ]; then
    echo "❌ 未找到 LS_API_KEY，请先运行："
    echo "   bash label_studio/set_token.sh <你的API Key>"
    echo ""
    echo "Token 获取：Label Studio → 右上角头像 → Account & Settings → Access Token"
    exit 1
fi

# 停止旧进程
pkill -f "auto_transcode.py" 2>/dev/null || true
pkill -f "upload_server.py"  2>/dev/null || true
sleep 1

# 清空日志
> "$LOG_FILE"
> "$UPLOAD_LOG"

export LS_URL="http://${SERVER_IP}:${LS_PORT}"
export NGINX_BASE_URL="http://${SERVER_IP}:${MEDIA_PORT}/transcoded"
export NGINX_MEDIA_URL="http://${SERVER_IP}:${MEDIA_PORT}"
export OUTPUT_DIR="${TRANSCODED_DIR}"
export UPLOAD_DIR="${LS_DATA_DIR}/media/upload"
export UPLOAD_PORT=8183

nohup python3 "${SCRIPT_DIR}/auto_transcode.py" >> "$LOG_FILE" 2>&1 &
echo "✅ auto_transcode 已启动 PID=$!，日志: tail -f ${LOG_FILE}"

nohup python3 "${SCRIPT_DIR}/upload_server.py" >> "$UPLOAD_LOG" 2>&1 &
echo "✅ upload_server  已启动 PID=$!，日志: tail -f ${UPLOAD_LOG}"
echo "   地址: http://${SERVER_IP}:8183"
