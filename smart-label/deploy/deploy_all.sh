#!/bin/bash
# 一条命令把 web 平台（smart-label）更新到最新，然后探一遍它依赖的算法服务通不通。
#
#   bash ~/label_infra/smart-label/deploy/deploy_all.sh
#
# 只管这个仓库：git pull → bash up.sh（docker 重建，含数据库迁移）→ 探健康检查。
# **算法服务不在这里**——label_service / vision_service（IMU 推理、SAM、狗检测、找片段、
# 向量索引、本地大模型）属于 imu_train 仓库，在那台机器上用它自己的一条命令：
#
#   cd ~/imu_train && ./up.sh deploy
#
# 两边各管各的：web 和算法各自发版、各自回滚，互不牵扯。这里最后只是**探一下**平台
# .env 里配的算法服务地址通不通，通不通都不去动它。
#
# 可调的（一般不用）：
#   DRY_RUN=1                  只打印要跑的命令，不执行
#
# 采集电脑（witmotion_imu，狗场 1/2、影棚）也不在这里：Windows 上各自 git pull。
set -u

# 第 1 步会 git pull 这个仓库——而 bash 是边读边执行脚本的，文件在脚本跑到一半时
# 被换掉会执行到错位的行。所以先把自己拷到临时文件再跑那一份
if [ -z "${DEPLOY_ALL_REEXEC:-}" ]; then
    _SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    _TMP="$(mktemp /tmp/deploy_all.XXXXXX.sh)"
    cp "$_SELF" "$_TMP"
    DEPLOY_ALL_REEXEC=1 DEPLOY_ALL_HOME="$(dirname "$_SELF")" exec bash "$_TMP" "$@"
fi

HERE="${DEPLOY_ALL_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LABEL_INFRA="$(cd "$HERE/../.." && pwd)"
DRY="${DRY_RUN:-0}"

FAILED=()
step() { echo; echo "━━━ $* ━━━"; }
run() {
    # 打印再执行；DRY_RUN 只打印。失败不退出，记下来最后一起报——后面的服务
    # 不该因为前一个挂了就不更新
    echo "  \$ $*"
    if [ "$DRY" = "1" ]; then return 0; fi
    "$@"
}
fail() { FAILED+=("$1"); echo "  ✗ $1"; }

probe() {   # $1 名字 $2 url $3 秒数
    local name=$1 url=$2 tries=${3:-30} i
    [ "$DRY" = "1" ] && { echo "  （DRY_RUN）$name $url"; return 0; }
    for ((i = 1; i <= tries; i++)); do
        if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
            echo "  ✓ $name"
            return 0
        fi
        sleep 1
    done
    echo "  ✗ $name 等了 ${tries}s 还没通：$url"
    return 1
}

json_field() {   # 从 url 的 JSON 里取一个顶层字段，取不到打 ?
    [ "$DRY" = "1" ] && { echo "?"; return; }
    curl -fsS --max-time 3 "$1" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2'))" 2>/dev/null || echo "?"
}

# ── 1. 平台 ────────────────────────────────────────────────────────────
step "1/2 平台 smart-label（$LABEL_INFRA）"
if run git -C "$LABEL_INFRA" pull --ff-only; then
    # 不用 exec：up.sh 自己会等 API/前端真的通了才说好
    ( cd "$HERE" && run bash up.sh ) || fail "平台 up.sh 没成（往上翻 migrate 日志）"
else
    fail "平台 git pull 失败（本地有改动？先 git stash）"
fi

# ── 2. 健康检查 ────────────────────────────────────────────────────────
step "2/2 都通了吗"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
API_PORT="${BACKEND_PORT:-8283}"
WEB_PORT="${FRONTEND_PORT:-8284}"
LABEL_URL="${ALGO_SERVICE_URL:-http://192.168.2.140:8383}"
VISION_URL="${VISION_SERVICE_URL:-http://192.168.2.140:8385}"

probe "平台 API   " "http://127.0.0.1:${API_PORT}/health" 30 || fail "平台 API 不通"
probe "平台前端  " "http://127.0.0.1:${WEB_PORT}/" 10 || fail "平台前端不通"

# 算法服务只探不动：不通的话去 imu_train 那台跑 ./up.sh deploy
echo "  算法服务（平台 .env 里配的地址，这里只探不动）："
if probe "  label_service " "${LABEL_URL%/}/health" 5; then :; else
    echo "    → 去跑 imu_train 的：cd ~/imu_train && ./up.sh deploy"
    fail "label_service 不通：${LABEL_URL}"
fi
if probe "  vision_service" "${VISION_URL%/}/health" 5; then
    if [ "$DRY" != "1" ]; then
        b="${VISION_URL%/}"
        echo "      狗检测=$(json_field "$b/api/v1/dog/status" available)  向量索引=$(json_field "$b/api/v1/embed/status" available)  SAM=$(json_field "$b/api/v1/sam/status" available)  找片段(环境变量key)=$(json_field "$b/api/v1/seek/status" available)"
    fi
else
    echo "    → 去跑 imu_train 的：cd ~/imu_train && ./up.sh deploy"
    fail "vision_service 不通：${VISION_URL}"
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
    echo "=== 平台部署完成 ==="
    exit 0
fi
echo "=== 有 ${#FAILED[@]} 项没成 ==="
for f in "${FAILED[@]}"; do echo "  - $f"; done
exit 1
