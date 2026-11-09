#!/bin/bash
# 更新 / 启动 smart-label，完成后打印访问地址
#
# 用法：
#   bash up.sh              滚动更新：别人照常用，不断线（见下面「滚动更新」）
#   bash up.sh -p           先 git pull 拉最新代码再滚动更新
#   bash up.sh -y           后台有 AI 预标注 / 删项目在跑也不等那 10 秒，直接更新
#   bash up.sh --mysql      连 MySQL 一起重启（改了 MySQL 配置才需要；会断十几秒，挑没人用的时候）
#   bash up.sh api frontend 老办法：只重建指定服务（直接 docker compose up -d --build，会断一下）
#
# ── 滚动更新：为什么别人感觉不到 ──────────────────────────────────────────
#   1. 先把新版本全部打包好（这时候旧的照常服务；打包失败就到此为止，什么都没动）
#   2. 数据库迁移（加列 / 加表，旧代码照样能跑）
#   3. 前端：新文件拷进 nginx 的目录、平滑重载。nginx 容器不重建、连接不断；
#      老版本的 js 留 7 天，开着旧页面的人点到别的页也不会白屏
#   4. 后端有两个实例：api（主）和 api_b（备用）。先把 api_b 换成新版、等它健康，
#      再重启 api——api 重启那几秒 nginx 自动转给 api_b
#   5. MySQL 不动（除非 --mysql）
#   会被打断的只有后端里正在后台跑的东西（AI 预标注、后台删项目）：更新前会先提示
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

PULL=0
YES=0
WITH_MYSQL=0
ARGS=()
for a in "$@"; do
  case "$a" in
    -p|--pull) PULL=1 ;;
    -y|--yes) YES=1 ;;
    --mysql) WITH_MYSQL=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

if [ "$PULL" = 1 ]; then
  echo "▶ 拉取最新代码..."
  git -C "$(git rev-parse --show-toplevel)" pull --ff-only
  echo ""
fi

[ -f .env ] && set -a && source .env && set +a
API_PORT="${BACKEND_PORT:-8283}"
WEB_PORT="${FRONTEND_PORT:-8284}"

show_migrate_logs() {
  # 迁移是最常见的失败：多头、down_revision 指错、SQL 写错，
  # 表现全都是 migrate 退出码非 0，而 compose 只说 exit 255
  echo ""
  echo "=== ⚠ 数据库迁移没过 ==="
  echo "--- migrate 最后 30 行 ---"
  docker compose logs --tail 30 migrate 2>&1 | sed 's/^/    /'
  echo ""
  echo "看完整日志：docker compose logs migrate"
}

if [ "${#ARGS[@]}" -gt 0 ]; then
  # ── 老办法：只重建点名的服务 ──
  # **不能让 set -e 在这里直接掐掉脚本**：compose 失败时只会留下一句
  # "exit 255"，而真正的原因在 migrate 容器的日志里
  if ! docker compose up -d --build "${ARGS[@]}"; then
    echo "=== ⚠ 起不来 ==="
    if docker compose ps -a --format '{{.Service}}' 2>/dev/null | grep -q '^migrate$'; then
      show_migrate_logs
    fi
    exit 1
  fi
else
  # ── 滚动更新 ──
  # 0) 后端里有东西在跑：重启会把它们打断，先说一声
  BUSY="$(curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/health/busy" 2>/dev/null || true)"
  if [ -n "$BUSY" ] && ! echo "$BUSY" | grep -q '"prelabel_projects":0,"deleting_projects":0'; then
    echo "⚠ 后台正在跑：$BUSY"
    echo "  （prelabel_projects = 在跑 AI 预标注的项目数，deleting_projects = 在后台删的项目数）"
    echo "  更新会打断它们：预标注之后在项目页重新点一次就行（已写进去的不丢）；删到一半的项目再点一次删除"
    if [ "$YES" != 1 ]; then
      echo "  10 秒后继续，不想现在更新就按 Ctrl+C（加 -y 不等）"
      sleep 10
    fi
  fi

  # 1) 打包：旧的照常服务；失败就停，什么都没动
  echo "▶ 打包后端 / 前端（这期间平台照常能用）..."
  if ! docker compose build migrate || ! docker compose --profile build build web_build; then
    echo "=== ⚠ 打包失败，线上还是旧版本，没动 ==="
    exit 1
  fi

  # 2) MySQL：平时只保证它在跑、不重建；--mysql 才按新配置重启
  if [ "$WITH_MYSQL" = 1 ]; then
    echo "▶ 按新配置重启 MySQL（会断十几秒）..."
    docker compose up -d --wait mysql
  else
    docker compose up -d --no-recreate --wait mysql
  fi

  # 3) 数据库迁移
  echo "▶ 数据库迁移..."
  if ! docker compose up --no-deps --force-recreate --exit-code-from migrate migrate >/dev/null 2>&1; then
    show_migrate_logs
    echo "（线上还是旧版本在跑，没动）"
    exit 1
  fi

  # 4) 前端文件：先拷带哈希的 js / css（新旧都在），最后原子地换 index.html；7 天前的旧文件清掉
  echo "▶ 更新前端文件..."
  docker run --rm -v smart-label-web-dist:/dst smart-label-web:latest sh -c '
    set -e
    mkdir -p /dst/assets
    cp -r /usr/share/nginx/html/assets/. /dst/assets/
    for f in /usr/share/nginx/html/*; do
      n=$(basename "$f"); [ "$n" = assets ] || [ "$n" = index.html ] || cp -r "$f" /dst/
    done
    cp /usr/share/nginx/html/index.html /dst/index.html.new && mv -f /dst/index.html.new /dst/index.html
    find /dst/assets -type f -mtime +7 -delete'

  # 5) 后端：先备用、再主
  echo "▶ 换备用后端 api_b..."
  if ! docker compose up -d --no-deps --wait --wait-timeout 180 api_b; then
    echo "=== ⚠ 新版本的备用后端起不来，主后端没动（还是旧版本在跑）==="
    echo "    docker compose logs --tail 50 api_b   看原因"
    exit 1
  fi
  echo "▶ 换主后端 api（这几秒请求自动走 api_b）..."
  docker compose up -d --no-deps --wait --wait-timeout 180 api || true
  docker compose up -d --no-deps scheduler

  # 6) nginx：容器不重建（第一次从老部署方式切过来时会重建一次），平滑重载配置
  docker compose up -d --no-deps frontend
  docker compose exec -T frontend nginx -s reload >/dev/null 2>&1 || true
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-<服务器IP>}"

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
# 走 nginx 到后端那一路也要通（主、备至少一个在）
wait_for "前端→后端" "http://127.0.0.1:${WEB_PORT}/api/v1/health" 30 || READY=1

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
