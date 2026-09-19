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

from app.models.local_model_stat import LocalModelStat
from app.services import vision_sam_client as vc

_logger = logging.getLogger("smart-label.local-model-stats")

# 上一次快照：model_key → {calls, frames, errors, total_ms}。进程内存，平台重启后第一次采集
# 只记快照不记差值（不然会把视觉服务累计的量一次性算进当前小时）
_last: dict[str, dict] = {}
_primed = False

FIELDS = ("calls", "frames", "errors", "total_ms")
NAMES = {"dog": "狗检测（YOLO）", "sam": "SAM 分割", "embed": "画面向量（SigLIP）", "pose": "姿态关键点（RTMPose）", "vllm": "本地大模型（vLLM）"}


def delta(prev: dict | None, cur: dict) -> dict:
    """两次快照之间多了多少。计数变小 = 视觉服务重启过，取当前值。"""
    out = {}
    for f in FIELDS:
        c = float(cur.get(f) or 0)
        p = float(prev.get(f) or 0) if prev else 0.0
        out[f] = c if c < p else c - p
    return out


async def collect(db: AsyncSession, now: datetime | None = None) -> dict:
    """拉一次快照，把差值加到当前小时。返回 {collected: 记了几个模型, skipped: 原因}。"""
    global _primed
    ov = await vc.models_overview()
    if not ov.get("available"):
        return {"collected": 0, "skipped": ov.get("error") or "视觉服务不可用"}
    now = now or datetime.now()
    hour = now.replace(minute=0, second=0, microsecond=0)
    n = 0
    for m in ov.get("models") or []:
        key = m.get("key")
        meter = m.get("meter") or {}
        if not key:
            continue
        cur = {f: meter.get(f) or 0 for f in FIELDS}
        prev = _last.get(key)
        _last[key] = cur
        if not _primed and prev is None:
            # 平台刚起来：只记快照。视觉服务里累计的历史量不知道是哪天的，不能算进这一小时
            continue
        d = delta(prev, cur)
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
    _primed = True
    await db.commit()
    return {"collected": n, "skipped": None}


async def stats(db: AsyncSession, days: int = 30) -> dict:
    """最近 days 天，每个模型：总量 + 按天一行（画柱图）。"""
    since = (datetime.now() - timedelta(days=max(1, days))).replace(minute=0, second=0, microsecond=0)
    rows = (await db.execute(select(LocalModelStat).where(LocalModelStat.hour >= since).order_by(LocalModelStat.hour))).scalars().all()
    per: dict[str, dict] = {}
    for r in rows:
        m = per.setdefault(r.model_key, {"key": r.model_key, "name": NAMES.get(r.model_key, r.model_key), "calls": 0, "frames": 0, "errors": 0, "total_ms": 0.0, "by_day": {}})
        d = m["by_day"].setdefault(r.hour.strftime("%Y-%m-%d"), {"day": r.hour.strftime("%Y-%m-%d"), "calls": 0, "frames": 0, "errors": 0, "total_ms": 0.0})
        for f in FIELDS:
            v = getattr(r, f)
            m[f] += v
            d[f] += v
    out = []
    for m in per.values():
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

async def imu_stats(db: AsyncSession, days: int = 30) -> dict:
    from app.models.inference_run import SampleInferenceRun

    since = datetime.now() - timedelta(days=max(1, days))
    rows = (await db.execute(
        select(SampleInferenceRun).where(SampleInferenceRun.created_at >= since).order_by(SampleInferenceRun.created_at)
    )).scalars().all()
    per: dict[tuple[str, str], dict] = {}
    for r in rows:
        k = (r.model_tag, r.mode)
        m = per.setdefault(k, {"model_tag": r.model_tag, "mode": r.mode, "samples": 0, "windows": 0, "segments": 0, "candidates": 0, "by_day": {}})
        day = (r.created_at or datetime.now()).strftime("%Y-%m-%d")
        d = m["by_day"].setdefault(day, {"day": day, "samples": 0, "windows": 0, "segments": 0, "candidates": 0})
        for f, v in (("samples", 1), ("windows", r.n_windows or 0), ("segments", r.n_segments or 0), ("candidates", r.n_candidates or 0)):
            m[f] += v
            d[f] += v
    out = []
    for m in per.values():
        m["by_day"] = sorted(m["by_day"].values(), key=lambda x: x["day"])
        out.append(m)
    out.sort(key=lambda m: -m["samples"])
    return {"days": days, "since": since.strftime("%Y-%m-%d"), "models": out}
