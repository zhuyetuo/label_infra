#!/bin/bash
# Label Studio + nginx 一键部署脚本
# 依赖：docker, docker compose

set -e

# ── 配置项（按需修改）──────────────────────────────────────────
LS_PORT=8181           # Label Studio Web 端口
MEDIA_PORT=8182        # nginx 静态媒体端口
LS_DATA_DIR="$HOME/ls-data"
SESSION_COOKIE_AGE=1209600   # 14 天
MAX_UPLOAD_FILES=10000
# ───────────────────────────────────────────────────────────────

MEDIA_DIR="$LS_DATA_DIR/media"
TRANSCODED_DIR="$MEDIA_DIR/transcoded"

echo "=== Label Studio 部署 ==="

# 1. 创建目录
mkdir -p "$MEDIA_DIR" "$TRANSCODED_DIR"
sudo chmod -R 777 "$LS_DATA_DIR" 2>/dev/null || true

# 2. 写 nginx 配置（支持 CORS，供 Label Studio 加载本地媒体文件）
cat > "$LS_DATA_DIR/nginx.conf" << 'NGINX_EOF'
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
docker rm -f label-studio ls-media 2>/dev/null || true

# 4. 启动 nginx（托管媒体文件）
docker run -d \
  --name ls-media \
  -p "${MEDIA_PORT}:80" \
  -v "${MEDIA_DIR}:/usr/share/nginx/html" \
  -v "${LS_DATA_DIR}/nginx.conf:/etc/nginx/conf.d/default.conf" \
  --restart unless-stopped \
  nginx:alpine

# 5. 启动 Label Studio
docker run -d \
  --name label-studio \
  -p "${LS_PORT}:8080" \
  --user root \
  -v "${LS_DATA_DIR}:/label-studio/data" \
  -e SESSION_COOKIE_AGE="${SESSION_COOKIE_AGE}" \
  -e DATA_UPLOAD_MAX_NUMBER_FILES="${MAX_UPLOAD_FILES}" \
  --restart unless-stopped \
  heartexlabs/label-studio:latest

echo ""
echo "=== 部署完成 ==="
echo "  Label Studio : http://$(hostname -I | awk '{print $1}'):${LS_PORT}"
echo "  媒体文件服务  : http://$(hostname -I | awk '{print $1}'):${MEDIA_PORT}"
echo ""
echo "首次访问请注册账号（第一个账号自动成为管理员）"
echo "媒体文件放到: ${MEDIA_DIR}/"
echo "转码输出目录: ${TRANSCODED_DIR}/"
