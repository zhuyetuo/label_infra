#!/bin/bash
# 一条命令把三个服务全部更新到最新：平台（smart-label）、label_service（IMU 推理）、
# vision_service（SAM / 狗检测 / 找片段 / 向量索引）。
#
#   bash ~/label_infra/smart-label/deploy/deploy_all.sh
#
# 它做的事，按顺序：
#   1. label_infra  git pull → bash up.sh（docker 重建，含数据库迁移）
#   2. imu_train    git pull → label_service：依赖变了才重建镜像，否则只重建容器+重启（秒级）
#                            → vision_service：down 再 -d（缺的 python 包它自己装）
#   3. 逐个探健康检查，最后一张表告诉你哪个通了哪个没通
#
# 为什么要有它：三个服务三套命令，漏一个的表现是"功能是灰的 / 下拉里少一项"，
# 不报错，事后很难想到是哪一步没跑。
#
# 可调的（一般不用）：
#   IMU_TRAIN_DIR=/path        imu_train 在哪（默认 ~/imu_train；不存在就跳过第 2 步）
#   DEPLOY_GPU=1               label_service 用 GPU 起（等于 up.sh -g）
#   SKIP_PLATFORM=1 / SKIP_LABEL=1 / SKIP_VISION=1   跳过某一步
#   DRY_RUN=1                  只打印要跑的命令，不执行
#
# 采集电脑（witmotion_imu，狗场 1/2、影棚）不在这里：那是 Windows 上各自 git pull。
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
IMU_TRAIN="${IMU_TRAIN_DIR:-$HOME/imu_train}"
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

# 有没有需要重建镜像的改动：这两个文件动了才需要，别的都是挂载进去的代码
changed_between() {   # $1 repo $2 old-rev $3 new-rev $4.. paths → 0 有改动
    local repo=$1 old=$2 new=$3; shift 3
    [ "$old" = "$new" ] && return 1
    [ -n "$(git -C "$repo" diff --name-only "$old" "$new" -- "$@" 2>/dev/null)" ]
}

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
if [ "${SKIP_PLATFORM:-0}" != "1" ]; then
    step "1/3 平台 smart-label（$LABEL_INFRA）"
    if run git -C "$LABEL_INFRA" pull --ff-only; then
        # 不用 exec：up.sh 自己会等 API/前端真的通了才说好
        ( cd "$HERE" && run bash up.sh ) || fail "平台 up.sh 没成（往上翻 migrate 日志）"
    else
        fail "平台 git pull 失败（本地有改动？先 git stash）"
    fi
fi

# ── 2. imu_train：label_service + vision_service ───────────────────────
if [ -d "$IMU_TRAIN/.git" ]; then
    step "2/3 imu_train（$IMU_TRAIN）"
    OLD_REV="$(git -C "$IMU_TRAIN" rev-parse HEAD 2>/dev/null || echo none)"
    if ! run git -C "$IMU_TRAIN" pull --ff-only; then
        fail "imu_train git pull 失败（本地有改动？先 git stash）"
    fi
    # 子模块要跟着钉的版本走，不然采集端代码是旧的
    run git -C "$IMU_TRAIN" submodule update --init --recursive >/dev/null 2>&1 || true
    NEW_REV="$(git -C "$IMU_TRAIN" rev-parse HEAD 2>/dev/null || echo none)"

    if [ "${SKIP_LABEL:-0}" != "1" ]; then
        echo
        echo "▸ label_service（IMU 推理，docker）"
        GPU_FLAG=""
        [ "${DEPLOY_GPU:-0}" = "1" ] && GPU_FLAG="-g"
        if changed_between "$IMU_TRAIN" "$OLD_REV" "$NEW_REV" label_service/Dockerfile label_service/requirements-docker.txt; then
            echo "  依赖变了 → 重建镜像（冷缓存十几分钟，喝口水）"
            ( cd "$IMU_TRAIN" && run bash label_service/up.sh $GPU_FLAG ) || fail "label_service 重建没成"
        else
            # -u：镜像不动，配置/环境变量变了就重建容器；然后 -d 重启让挂载的新代码生效
            ( cd "$IMU_TRAIN" && run bash label_service/up.sh $GPU_FLAG -u && run bash label_service/up.sh $GPU_FLAG -d ) \
                || fail "label_service 重启没成"
        fi
    fi

    if [ "${SKIP_VISION:-0}" != "1" ]; then
        echo
        echo "▸ vision_service（SAM / 狗检测 / 找片段 / 向量索引，宿主机 python）"
        ( cd "$IMU_TRAIN" && run bash vision_service/run.sh down; run bash vision_service/run.sh -d ) \
            || fail "vision_service 起不来（看 $IMU_TRAIN/vision_service/.run.log）"
    fi
else
    step "2/3 imu_train：$IMU_TRAIN 不存在，跳过（另一台机器的话在那台上跑 IMU_TRAIN_DIR=... 这个脚本，或 SKIP_PLATFORM=1）"
fi

# ── 3. 健康检查 ────────────────────────────────────────────────────────
step "3/3 都通了吗"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
API_PORT="${BACKEND_PORT:-8283}"
WEB_PORT="${FRONTEND_PORT:-8284}"
LABEL_URL="${ALGO_SERVICE_URL:-http://127.0.0.1:8383}"
VISION_URL="${VISION_SERVICE_URL:-http://127.0.0.1:8385}"
# 平台 .env 里写的是别的机器的地址而服务就在本机时，本机探不到是正常的：两个都试
probe_any() {   # $1 名字 $2.. 若干 url；通了的那个 url 走 stdout，给人看的走 stderr
    local name=$1; shift
    local u
    for u in "$@"; do
        if [ "$DRY" = "1" ] || curl -fsS -o /dev/null --max-time 2 "$u" 2>/dev/null; then
            echo "  ✓ $name  $u" >&2
            echo "$u"
            return 0
        fi
    done
    echo "  ✗ $name 没通：$*" >&2
    return 1
}

[ "${SKIP_PLATFORM:-0}" != "1" ] && { probe "平台 API   " "http://127.0.0.1:${API_PORT}/health" 30 || fail "平台 API 不通"; }
[ "${SKIP_PLATFORM:-0}" != "1" ] && { probe "平台前端  " "http://127.0.0.1:${WEB_PORT}/" 10 || fail "平台前端不通"; }

if [ "${SKIP_LABEL:-0}" != "1" ]; then
    probe_any "label_service" "http://127.0.0.1:8383/health" "${LABEL_URL%/}/health" >/dev/null || fail "label_service 不通"
fi
if [ "${SKIP_VISION:-0}" != "1" ]; then
    VU="$(probe_any "vision_service" "http://127.0.0.1:8385/health" "${VISION_URL%/}/health")" || fail "vision_service 不通"
    if [ -n "${VU:-}" ] && [ "$DRY" != "1" ]; then
        base="${VU%/health}"
        echo "    狗检测   available=$(json_field "$base/api/v1/dog/status" available)"
        echo "    找片段   available=$(json_field "$base/api/v1/seek/status" available)   （false = 环境变量没 key；用「大模型 API」页配的 key 不看这个）"
        echo "    向量索引 available=$(json_field "$base/api/v1/embed/status" available)   indexed=$(json_field "$base/api/v1/embed/status" indexed_videos)"
        echo "    SAM      available=$(json_field "$base/api/v1/sam/status" available)"
    fi
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
    echo "=== 全部部署完成 ==="
    exit 0
fi
echo "=== 有 ${#FAILED[@]} 项没成 ==="
for f in "${FAILED[@]}"; do echo "  - $f"; done
exit 1
