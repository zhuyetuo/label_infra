#!/bin/bash
# Label Studio + nginx + 自动转码服务 一键部署脚本
# 依赖：docker, python3, pip, ffmpeg（GPU 转码需要 NVIDIA 驱动）

set -e

# ── 配置项（按需修改）──────────────────────────────────────────
LS_PORT=8181           # Label Studio Web 端口
MEDIA_PORT=8182        # nginx 静态媒体端口
SESSION_COOKIE_AGE=1209600   # 14 天
MAX_UPLOAD_FILES=10000

# 自动转码服务配置
# LS_REFRESH_TOKEN：登录 Label Studio → 右上角头像 → Account & Settings → Personal Access Token
LS_REFRESH_TOKEN="${LS_REFRESH_TOKEN:-}"
SERVER_IP="${SERVER_IP:-$(hostname -I | awk '{print $1}')}"
# ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 数据和日志都放在 ~/label_infra/ 下
LS_DATA_DIR=~/label_infra/data/label_studio
MEDIA_DIR=~/label_infra/data/media
TRANSCODED_DIR=~/label_infra/data/media/transcoded
LOG_FILE=~/label_infra/logs/transcode.log

echo "=== Label Studio 部署 ==="

# 1. 创建目录
mkdir -p "$MEDIA_DIR" "$TRANSCODED_DIR" "$LS_DATA_DIR" ~/label_infra/logs
sudo chmod -R 777 "$MEDIA_DIR" "$LS_DATA_DIR" 2>/dev/null || true

# 2. 写 nginx 配置（支持 CORS，供 Label Studio 加载本地媒体文件）
cat > "$HOME/label_infra/data/nginx.conf" << 'NGINX_EOF'
server {
    listen 80;
    root /usr/share/nginx/html;

    location / {
        add_header 'Access-Control-Allow-Origin' '*';
        add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS';
        add_header 'Access-Control-Allow-Headers' '*';
    }
}
NGINX_EOF

# 3. 停止并移除旧容器（如果存在）
docker rm -f label_studio label_studio_nginx 2>/dev/null || true

# 4. 启动 nginx（托管媒体文件）
docker run -d \
  --name label_studio_nginx \
  -p "${MEDIA_PORT}:80" \
  -v "${MEDIA_DIR}:/usr/share/nginx/html" \
  -v "~/label_infra/data/nginx.conf:/etc/nginx/conf.d/default.conf" \
  --restart unless-stopped \
  nginx:alpine

# 5. 启动 Label Studio
docker run -d \
  --name label_studio \
  -p "${LS_PORT}:8080" \
  --user root \
  -v "${LS_DATA_DIR}:/label-studio/data" \
  -e SESSION_COOKIE_AGE="${SESSION_COOKIE_AGE}" \
  -e DATA_UPLOAD_MAX_NUMBER_FILES="${MAX_UPLOAD_FILES}" \
  --restart unless-stopped \
  heartexlabs/label-studio:latest

echo ""
echo "=== 部署完成 ==="
echo "  Label Studio : http://${SERVER_IP}:${LS_PORT}"
echo "  媒体文件服务  : http://${SERVER_IP}:${MEDIA_PORT}"
echo ""
echo "首次访问请注册账号（第一个账号自动成为管理员）"
echo "媒体文件放到: ${MEDIA_DIR}/"
echo "转码输出目录: ${TRANSCODED_DIR}/"

# 6. 等待 Label Studio 就绪
echo ""
echo "=== 等待 Label Studio 启动 ==="
MAX_WAIT=120
ELAPSED=0
until curl -s "http://${SERVER_IP}:${LS_PORT}/health" | grep -q "UP" 2>/dev/null; do
    if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
        echo "⚠️  等待超时（${MAX_WAIT}s），Label Studio 可能还未就绪，转码服务将自动重试连接"
        break
    fi
    printf "."
    sleep 3
    ELAPSED=$((ELAPSED + 3))
done
echo ""
echo "Label Studio 已就绪"

# 7. 启动自动转码服务
# 安装 Python 依赖
echo ""
echo "=== 安装转码服务依赖 ==="
pip install requests --break-system-packages -q

# 停止旧的转码进程
OLD_PID=$(pgrep -f "auto_transcode.py" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo "停止旧的转码进程 (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
fi

# 检查 token 是否已配置
if [ -z "$LS_REFRESH_TOKEN" ]; then
    echo ""
    echo "⚠️  LS_REFRESH_TOKEN 未设置，跳过自动转码服务启动。"
    echo "   部署完成后，请手动启动："
    echo ""
    echo "   export LS_REFRESH_TOKEN=\"你的JWT refresh token\""
    echo "   export LS_URL=\"http://${SERVER_IP}:${LS_PORT}\""
    echo "   export NGINX_BASE_URL=\"http://${SERVER_IP}:${MEDIA_PORT}/transcoded\""
    echo "   nohup python3 ${SCRIPT_DIR}/auto_transcode.py >> ${LOG_FILE} 2>&1 &"
    echo ""
else
    export LS_URL="http://${SERVER_IP}:${LS_PORT}"
    export NGINX_BASE_URL="http://${SERVER_IP}:${MEDIA_PORT}/transcoded"
    export OUTPUT_DIR="${TRANSCODED_DIR}"
    export UPLOAD_DIR="${LS_DATA_DIR}/media/upload"

    nohup python3 "${SCRIPT_DIR}/auto_transcode.py" >> "$LOG_FILE" 2>&1 &
    TRANSCODE_PID=$!
    echo ""
    echo "=== 自动转码服务已启动 ==="
    echo "  PID     : ${TRANSCODE_PID}"
    echo "  日志    : ${LOG_FILE}"
    echo "  查看日志: tail -f ${LOG_FILE}"
fi
