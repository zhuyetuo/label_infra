#!/bin/bash
# 启动/重建 smart-label 服务，完成后打印访问地址
# 用法：bash up.sh   （等价于原来的 docker compose up -d --build，参数原样透传）
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

docker compose up -d --build "$@"

[ -f .env ] && set -a && source .env && set +a

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-<服务器IP>}"

echo ""
echo "=== smart-label 已启动 ==="
echo "前端页面: http://${HOST_IP}:${FRONTEND_PORT:-8284}"
echo "API 文档: http://${HOST_IP}:${BACKEND_PORT:-8283}/docs"
