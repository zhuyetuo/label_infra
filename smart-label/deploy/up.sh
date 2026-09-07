#!/bin/bash
# 启动/重建 smart-label 服务，完成后打印访问地址
#
# 用法：
#   bash up.sh              重建并启动全部服务（等价于 docker compose up -d --build）
#   bash up.sh -p           先 git pull 拉最新代码再重建（等于 git pull && bash up.sh）
#   bash up.sh api frontend 只重建指定服务，其余参数原样透传给 docker compose
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ "${1:-}" == "-p" || "${1:-}" == "--pull" ]]; then
  shift
  echo "▶ 拉取最新代码..."
  git -C "$(git rev-parse --show-toplevel)" pull --ff-only
  echo ""
fi

docker compose up -d --build "$@"

# 数据库迁移是一次性容器，跑挂了后面的服务会连不上表结构对不上的库，
# 这里直接把它的退出码亮出来，别等到用的时候才发现
if ! docker compose ps -a --status exited --format '{{.Service}} {{.ExitCode}}' 2>/dev/null | grep -q '^migrate 0$'; then
  echo ""
  echo "⚠ 数据库迁移容器不是正常退出，用 docker compose logs migrate 看原因"
fi

[ -f .env ] && set -a && source .env && set +a

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-<服务器IP>}"

echo ""
echo "=== smart-label 已启动 ==="
echo "前端页面: http://${HOST_IP}:${FRONTEND_PORT:-8284}"
echo "API 文档: http://${HOST_IP}:${BACKEND_PORT:-8283}/docs"
echo "日志文件: $(cd ../.. && pwd)/logs/smart-label/  (api.log / access.log / scheduler.log，按天切留 14 天)"
