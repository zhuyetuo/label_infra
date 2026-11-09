"""「项目联动 → 重新拉取」放到后台跑。

原来是浏览器发一个请求、一直等到算完（几十秒到几分钟）：
  · 刷新页面 / 切走再回来，进度条就没了，也不知道还在不在算，于是又点一次；
  · 等的这段时间里，页面上其他请求（同一个后端在忙）容易超时报错。
现在点一下只是「开始」，立刻返回；算的状态记在服务器上，页面每两秒问一次，
刷新、换电脑打开都能接着看到进度。同一时间只跑一趟，别人再点就看到「正在算」。

进度是按天数和上一次的实测速度估的（这一趟是一次原子计算，没法边算边报，见
skin_link_service._stats_with_full_baseline），但开始时间、谁点的、算完没有是真的。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import date

log = logging.getLogger("skin_link_job")

STATE: dict = {"status": "idle"}
_pace = {"sec_per_day": 1.5}   # 上一次的实测速度，估下一次要多久
_factory = None                 # 测试里换成别的 session 工厂
_runner = None                  # 测试里换掉真正的计算


def _session():
    from app.db.session import SessionLocal

    return (_factory or SessionLocal)()


def status() -> dict:
    s = dict(STATE)
    if s.get("status") == "running":
        s["elapsed_sec"] = round(time.time() - s["started_at"], 1)
    return s


async def start(date_from: date, date_to: date, project_id: int | None, include_drafts: bool, ai_min_conf: float,
                by: str) -> dict:
    if STATE.get("status") == "running":
        return status()
    days = (date_to - date_from).days + 1
    STATE.clear()
    STATE.update(status="running", date_from=date_from.isoformat(), date_to=date_to.isoformat(),
                 project_id=project_id, include_drafts=include_drafts, by=by, started_at=time.time(),
                 estimate_sec=round(days * _pace["sec_per_day"], 1), finished_at=None, rows=None,
                 warnings=[], error=None)
    asyncio.create_task(_run(date_from, date_to, project_id, include_drafts, ai_min_conf, days))
    return status()


async def _run(date_from, date_to, project_id, include_drafts, ai_min_conf, days) -> None:
    from app.services.skin_link_service import collect_link_stats

    run = _runner or collect_link_stats
    t0 = time.time()
    try:
        async with _session() as db:
            r = await run(db, date_from, date_to, project_id, ai_min_conf=ai_min_conf, include_drafts=include_drafts)
        STATE.update(status="done", rows=len(r.get("rows") or []), warnings=(r.get("warnings") or [])[:20])
        pace = (time.time() - t0) / max(1, days)
        _pace["sec_per_day"] = _pace["sec_per_day"] * 0.6 + pace * 0.4
    except Exception as e:  # noqa: BLE001
        log.exception("项目联动重新拉取失败 %s~%s", date_from, date_to)
        STATE.update(status="error", error=f"{type(e).__name__}: {e}"[:500])
    finally:
        STATE["finished_at"] = time.time()
