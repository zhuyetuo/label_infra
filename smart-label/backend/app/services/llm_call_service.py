"""大模型调用统计：落每一次调用，按家 / 模型汇总次数、token、花费、耗时。"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.llm_call import LlmCall


def record_calls(db: AsyncSession, provider: str, model: str, calls: list[dict], *, purpose: str = "seek",
                 project_id: int | None = None, task_id: int | None = None) -> int:
    """视觉服务带回来的 calls（每问一段一条）→ 一行一条。不 commit，跟外面的事务一起提。"""
    n = 0
    for c in calls or []:
        db.add(LlmCall(
            provider=provider, model=model, purpose=purpose, project_id=project_id, task_id=task_id,
            input_tokens=int(c.get("input") or 0), output_tokens=int(c.get("output") or 0),
            est_usd=float(c.get("est_usd") or 0.0), latency_ms=int(c.get("latency_ms") or 0),
            ok=bool(c.get("ok", True)), error=(str(c["error"])[:300] if c.get("error") else None),
        ))
        n += 1
    return n


def _pct(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    i = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


async def stats(db: AsyncSession, days: int = 30, recent: int = 50) -> dict:
    """最近 days 天：总览、按家/模型一行、按天一行（画图用）、最近几次。"""
    since = datetime.now() - timedelta(days=max(1, days))
    rows = (await db.execute(
        select(LlmCall).where(LlmCall.created_at >= since).order_by(LlmCall.id)
    )).scalars().all()

    def summarize(items: list[LlmCall]) -> dict:
        n = len(items)
        inp = sum(r.input_tokens for r in items)
        out = sum(r.output_tokens for r in items)
        lat = sorted(r.latency_ms for r in items)
        ok = sum(1 for r in items if r.ok)
        return {
            "calls": n, "ok": ok, "errors": n - ok,
            "input_tokens": inp, "output_tokens": out, "total_tokens": inp + out,
            "avg_tokens_per_call": round((inp + out) / n) if n else 0,
            "avg_input_per_call": round(inp / n) if n else 0,
            "avg_output_per_call": round(out / n) if n else 0,
            "est_usd": round(sum(r.est_usd for r in items), 4),
            "avg_latency_ms": round(sum(lat) / n) if n else 0,
            "p50_latency_ms": _pct(lat, 0.5), "p90_latency_ms": _pct(lat, 0.9),
            "max_latency_ms": lat[-1] if lat else 0,
            "total_latency_s": round(sum(lat) / 1000, 1),
        }

    by_model: dict[tuple[str, str], list[LlmCall]] = {}
    by_day: dict[str, list[LlmCall]] = {}
    for r in rows:
        by_model.setdefault((r.provider, r.model), []).append(r)
        by_day.setdefault((r.created_at or datetime.now()).strftime("%Y-%m-%d"), []).append(r)
    models = [{"provider": p, "model": m, **summarize(items)} for (p, m), items in by_model.items()]
    models.sort(key=lambda x: -x["calls"])
    days_out = [{"day": d, **summarize(items)} for d, items in sorted(by_day.items())]
    latest = [{
        "id": r.id, "provider": r.provider, "model": r.model, "purpose": r.purpose,
        "project_id": r.project_id, "task_id": r.task_id,
        "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "est_usd": r.est_usd,
        "latency_ms": r.latency_ms, "ok": r.ok, "error": r.error,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows[-recent:][::-1]]
    all_time = (await db.execute(select(func.count(LlmCall.id), func.coalesce(func.sum(LlmCall.input_tokens + LlmCall.output_tokens), 0),
                                        func.coalesce(func.sum(LlmCall.est_usd), 0.0)))).one()
    return {
        "days": days, "since": since.isoformat(),
        "total": summarize(rows),
        "all_time": {"calls": int(all_time[0] or 0), "total_tokens": int(all_time[1] or 0), "est_usd": round(float(all_time[2] or 0.0), 4)},
        "by_model": models, "by_day": days_out, "recent": latest,
    }
