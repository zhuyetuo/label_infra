"""本地模型调用量：定时从视觉服务拉计数快照、按小时记差值；按天汇总给「调用统计」页。

为什么不让视觉服务自己落库：它在算法机上，不碰平台的库；平台拉快照是最省事的解耦。
快照差值的坑只有一个——视觉服务重启后计数归零，差值会是负数。计数变小就当它重启过，
这一轮的差值取当前值（重启到这次采集之间的量）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.local_model_stat import LocalModelSnapshot, LocalModelStat
from app.services import vision_sam_client as vc

_logger = logging.getLogger("smart-label.local-model-stats")

FIELDS = ("calls", "frames", "errors", "total_ms")
NAMES = {"dog": "狗检测（YOLO）", "sam": "SAM 分割", "embed": "画面向量（SigLIP）", "seg": "抠狗分割（YOLO-seg）", "pose": "姿态关键点（RTMPose）", "vllm": "本地大模型（vLLM）"}

# 打开统计页时即时采一次，但同一进程 20 秒内不重复（几个人同时开着页面时别把视觉服务问烦）
COLLECT_MIN_INTERVAL_S = 20.0
_last_collect_at = 0.0


def delta(prev: dict | None, cur: dict) -> dict:
    """两次快照之间多了多少。计数变小 = 视觉服务重启过，取当前值。"""
    out = {}
    for f in FIELDS:
        c = float(cur.get(f) or 0)
        p = float(prev.get(f) or 0) if prev else 0.0
        out[f] = c if c < p else c - p
    return out


async def collect(db: AsyncSession, now: datetime | None = None) -> dict:
    """拉一次快照，跟库里上一次比出差值加到当前小时。返回 {collected, skipped}。

    快照存库（local_model_snapshots），API 进程和调度器进程都可以采：谁先采谁记差值，
    另一个再采时差值就是 0。行加锁，两边几乎同时采也不会把同一段量算两遍。
    某个模型第一次出现（库里没它的快照）只记快照不记差值：视觉服务里累计的历史量
    不知道是哪天的，不能算进这一小时。
    """
    ov = await vc.models_overview()
    if not ov.get("available"):
        return {"collected": 0, "skipped": ov.get("error") or "视觉服务不可用"}
    now = now or datetime.now()
    hour = now.replace(minute=0, second=0, microsecond=0)
    snaps = {r.model_key: r for r in (await db.execute(select(LocalModelSnapshot).with_for_update())).scalars().all()}
    n = 0
    for m in ov.get("models") or []:
        key = m.get("key")
        meter = m.get("meter") or {}
        if not key:
            continue
        cur = {f: meter.get(f) or 0 for f in FIELDS}
        # 视觉服务报的"最近一次调用"（epoch 秒）。它重启会归零，所以只往后更新
        last = meter.get("last_at")
        last_dt = datetime.fromtimestamp(float(last)) if last else None
        snap = snaps.get(key)
        if snap is None:
            db.add(LocalModelSnapshot(model_key=key, taken_at=now, last_call_at=last_dt, **{f: cur[f] for f in FIELDS}))
            continue
        if last_dt is not None and (snap.last_call_at is None or last_dt > snap.last_call_at):
            snap.last_call_at = last_dt
        d = delta({f: getattr(snap, f) for f in FIELDS}, cur)
        for f in FIELDS:
            setattr(snap, f, cur[f])
        snap.taken_at = now
        if not any(d[f] for f in FIELDS):
            continue
        row = (await db.execute(select(LocalModelStat).where(LocalModelStat.model_key == key, LocalModelStat.hour == hour))).scalar_one_or_none()
        if row is None:
            row = LocalModelStat(model_key=key, hour=hour, calls=0, frames=0, errors=0, total_ms=0.0)
            db.add(row)
        row.calls += int(d["calls"])
        row.frames += int(d["frames"])
        row.errors += int(d["errors"])
        row.total_ms += float(d["total_ms"])
        n += 1
    await db.commit()
    return {"collected": n, "skipped": None}


async def collect_throttled(db: AsyncSession) -> None:
    """给统计接口用：最多 20 秒采一次，采不成也不影响读数。"""
    global _last_collect_at
    import time

    if time.time() - _last_collect_at < COLLECT_MIN_INTERVAL_S:
        return
    _last_collect_at = time.time()
    try:
        await collect(db)
    except Exception:  # noqa: BLE001 采集出错不能让统计页打不开
        _logger.exception("本地模型计数即时采集失败")
        await db.rollback()


async def stats(db: AsyncSession, days: int = 30) -> dict:
    """最近 days 天，每个模型：总量 + 按天一行（画柱图）。"""
    since = (datetime.now() - timedelta(days=max(1, days))).replace(minute=0, second=0, microsecond=0)
    rows = (await db.execute(select(LocalModelStat).where(LocalModelStat.hour >= since).order_by(LocalModelStat.hour))).scalars().all()
    # 最近一次调用：快照行上记着（不受所选时间范围影响——问的是"上次什么时候用的"）
    last_at = {r.model_key: r.last_call_at for r in (await db.execute(select(LocalModelSnapshot))).scalars().all()}
    per: dict[str, dict] = {}
    for r in rows:
        m = per.setdefault(r.model_key, {"key": r.model_key, "name": NAMES.get(r.model_key, r.model_key), "calls": 0, "frames": 0, "errors": 0, "total_ms": 0.0, "by_day": {}})
        d = m["by_day"].setdefault(r.hour.strftime("%Y-%m-%d"), {"day": r.hour.strftime("%Y-%m-%d"), "calls": 0, "frames": 0, "errors": 0, "total_ms": 0.0})
        for f in FIELDS:
            v = getattr(r, f)
            m[f] += v
            d[f] += v
    for key, t in last_at.items():
        if key not in per and t is not None:
            per[key] = {"key": key, "name": NAMES.get(key, key), "calls": 0, "frames": 0, "errors": 0, "total_ms": 0.0, "by_day": {}}
    out = []
    for m in per.values():
        t = last_at.get(m["key"])
        m["last_call_at"] = t.isoformat(timespec="seconds") if t else None
        m["avg_ms"] = round(m["total_ms"] / m["calls"]) if m["calls"] else 0
        m["avg_ms_per_frame"] = round(m["total_ms"] / m["frames"], 1) if m["frames"] else 0
        m["total_ms"] = round(m["total_ms"])
        m["by_day"] = [{**d, "total_ms": round(d["total_ms"])} for d in sorted(m["by_day"].values(), key=lambda x: x["day"])]
        out.append(m)
    order = list(NAMES)
    out.sort(key=lambda m: order.index(m["key"]) if m["key"] in order else 99)
    return {"days": days, "since": since.strftime("%Y-%m-%d"), "models": out}


# ── IMU 预测模型（AI 预标注）的使用量 ───────────────────────────────────────
# 每次预标注在 sample_inference_runs 里一行（同一份样本同模型同模式重跑是更新同一行），
# 按 created_at 的天汇总：跑了几份样本、切了多少窗口、出了多少段 / 候选。

async def _edge_tags() -> set[str]:
    """端侧服务现在挂着哪些模型。问服务不写死：新增一个端侧模型不用改这里。

    端侧服务是可选的，没起就返回空集，下面按命名兜底（algo_tinyml 那边的标签
    都是 edge_ 开头）。宁可兜底分错一个，也不要因为它没起就打不开统计页。
    """
    try:
        from app.services import edge_client

        return {str(m.get("tag")) for m in await edge_client.available() if m.get("tag")}
    except Exception:  # noqa: BLE001
        _logger.warning("问端侧服务要模型列表失败，按命名兜底分类", exc_info=True)
        return set()


def kind_of(model_tag: str, mode: str, edge_tags: set[str]) -> str:
    """这一行是服务端模型还是端侧模型。

    服务端 = imu_train/label_service，服务器上的 sklearn；
    端侧   = algo_tinyml/edge_service，跑的是烧进项圈的那份 C。
    mode=board 一定是端侧（板上那份后处理，服务端没有这个）。
    """
    if mode == "board" or model_tag in edge_tags:
        return "edge"
    return "edge" if model_tag.startswith("edge_") else "server"


async def imu_stats(db: AsyncSession, days: int = 30) -> dict:
    from app.models.inference_run import SampleInferenceRun

    edge_tags = await _edge_tags()
    since = datetime.now() - timedelta(days=max(1, days))
    rows = (await db.execute(
        select(SampleInferenceRun).where(SampleInferenceRun.created_at >= since).order_by(SampleInferenceRun.created_at)
    )).scalars().all()
    per: dict[tuple[str, str], dict] = {}
    for r in rows:
        k = (r.model_tag, r.mode)
        m = per.setdefault(k, {"model_tag": r.model_tag, "mode": r.mode,
                               "kind": kind_of(r.model_tag, r.mode, edge_tags),
                               "samples": 0, "windows": 0, "segments": 0, "candidates": 0,
                               "last_at": None, "by_day": {}})
        if r.created_at and (m["last_at"] is None or r.created_at > m["last_at"]):
            m["last_at"] = r.created_at
        day = (r.created_at or datetime.now()).strftime("%Y-%m-%d")
        d = m["by_day"].setdefault(day, {"day": day, "samples": 0, "windows": 0, "segments": 0, "candidates": 0})
        for f, v in (("samples", 1), ("windows", r.n_windows or 0), ("segments", r.n_segments or 0), ("candidates", r.n_candidates or 0)):
            m[f] += v
            d[f] += v
    out = []
    for m in per.values():
        m["last_at"] = m["last_at"].isoformat(timespec="seconds") if m["last_at"] else None
        m["by_day"] = sorted(m["by_day"].values(), key=lambda x: x["day"])
        out.append(m)
    # 服务端在前、端侧在后，组内按跑过的样本数排
    out.sort(key=lambda m: (m["kind"] != "server", -m["samples"]))
    return {"days": days, "since": since.strftime("%Y-%m-%d"), "models": out}
