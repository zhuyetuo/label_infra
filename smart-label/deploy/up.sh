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

# **不能让 set -e 在这里直接掐掉脚本**：compose 失败时只会留下一句
# "exit 255"，而真正的原因在 migrate 容器的日志里。掐掉的话下面那些
# 诊断一句都不会打，人只能对着一个退出码猜。
if ! docker compose up -d --build "$@"; then
  echo ""
  echo "=== ⚠ 起不来 ==="
  # 迁移是最常见的那个：多头、down_revision 指错、SQL 写错，
  # 表现全都是 migrate 退出码非 0，而 compose 只说 exit 255
  if docker compose ps -a --format '{{.Service}}' 2>/dev/null | grep -q '^migrate$'; then
    echo "--- migrate 最后 30 行 ---"
    docker compose logs --tail 30 migrate 2>&1 | sed 's/^/    /'
  fi
  echo ""
  echo "看完整日志：docker compose logs migrate"
  exit 1
fi

# 迁移是一次性容器，跑挂了后面的服务会连上一个表结构对不上的库，
# 这里直接把它的退出码亮出来，别等到用的时候才发现
if ! docker compose ps -a --status exited --format '{{.Service}} {{.ExitCode}}' 2>/dev/null | grep -q '^migrate 0$'; then
  echo ""
  echo "⚠ 数据库迁移容器不是正常退出，用 docker compose logs migrate 看原因"
fi

[ -f .env ] && set -a && source .env && set +a

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-<服务器IP>}"
API_PORT="${BACKEND_PORT:-8283}"
WEB_PORT="${FRONTEND_PORT:-8284}"

# ── 等到真的能用再说"已启动" ──────────────────────────────────────────────
#
# 容器 Started ≠ 服务能用。api 那个容器起来之后还要 import 一堆东西、连 MySQL、
# 建连接池，前端 nginx 起得快但要等 api 通了才有数据。
#
# 以前这里直接打"=== 已启动 ===" 加地址，而那时候点进去是白屏或者 502——
# **脚本承诺了它没验证过的事**。看到成功横幅的人会以为坏的是别的地方，
# 然后去查一个根本不存在的问题。
wait_for() {
    local what=$1 url=$2 tries=${3:-60} i
    for ((i = 1; i <= tries; i++)); do
        if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
            echo "  ✓ $what（等了 ${i}s）"
            return 0
        fi
        sleep 1
    done
    echo "  ✗ $what 等了 ${tries}s 还没通：$url"
    return 1
}

echo ""
echo "▶ 等服务真的起来（容器 Started 不等于能用）"
READY=0
wait_for "API   " "http://127.0.0.1:${API_PORT}/health" 90 || READY=1
wait_for "前端  " "http://127.0.0.1:${WEB_PORT}/" 30 || READY=1

echo ""
if [ "$READY" = 0 ]; then
    echo "=== smart-label 可以用了 ==="
else
    # 没起来就**别打成功横幅**。这里最容易的就是照旧打一遍地址，
    # 然后让人对着一个白屏猜是不是自己电脑的问题
    echo "=== ⚠ 有服务没起来，下面的地址现在多半打不开 ==="
    echo "    docker compose ps          看谁没起"
    echo "    docker compose logs -f api 看 api 为什么不通"
fi
echo "前端页面: http://${HOST_IP}:${WEB_PORT}"
echo "API 文档: http://${HOST_IP}:${API_PORT}/docs"
echo "日志文件: $(cd ../.. && pwd)/logs/smart-label/  (api.log / access.log / scheduler.log，按天切留 14 天)"
[ "$READY" = 0 ] || exit 1
