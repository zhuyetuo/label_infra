#!/bin/bash
# Windows 本地启动脚本（在 Git Bash 中运行）
# 用法：bash win/start.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"

# 加载 .env
[ -f "$ENV_FILE" ] && set -a && source "$ENV_FILE" && set +a

LS_URL="${LS_URL:-http://localhost:8080}"
MEDIA_PORT="${MEDIA_PORT:-8182}"

# Label Studio Windows 默认媒体目录
LOCALAPPDATA="${LOCALAPPDATA:-/c/Users/$USERNAME/AppData/Local}"
MEDIA_DIR="${LOCALAPPDATA}/label-studio/label-studio/media"
UPLOAD_DIR="${MEDIA_DIR}/upload"
TRANSCODED_DIR="${MEDIA_DIR}/transcoded"
mkdir -p "$TRANSCODED_DIR"

if [ -z "$LS_REFRESH_TOKEN" ]; then
    echo "❌ 未找到 LS_REFRESH_TOKEN，请先运行："
    echo "   bash label_studio/set_token.sh \"你的Personal Access Token\""
    exit 1
fi

export LS_URL
export NGINX_BASE_URL="http://localhost:${MEDIA_PORT}/transcoded"
export NGINX_MEDIA_URL="http://localhost:${MEDIA_PORT}"
export OUTPUT_DIR="$TRANSCODED_DIR"
export UPLOAD_DIR="$UPLOAD_DIR"
export UPLOAD_PORT=8183

echo "=== 启动本地媒体服务 (端口 ${MEDIA_PORT}) ==="
python "${SCRIPT_DIR}/media_server.py" --dir "$MEDIA_DIR" --port "$MEDIA_PORT" &
MEDIA_PID=$!
echo "✅ 媒体服务 PID=$MEDIA_PID  http://localhost:${MEDIA_PORT}"

sleep 1

echo ""
echo "=== 启动上传服务 (端口 8183) ==="
python "${ROOT_DIR}/label_studio/upload_server.py" &
UPLOAD_PID=$!
echo "✅ 上传服务 PID=$UPLOAD_PID  http://localhost:8183"

echo ""
echo "=== 启动自动转码服务 ==="
python "${ROOT_DIR}/label_studio/auto_transcode.py" &
TRANSCODE_PID=$!
echo "✅ 转码服务 PID=$TRANSCODE_PID"

echo ""
echo "Ctrl+C 停止所有服务"
wait
