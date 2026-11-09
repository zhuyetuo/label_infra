"""重新拉取放后台：立刻返回、同一时间只跑一趟、状态能查到（刷新页面也能接着看）"""
import asyncio
from datetime import date

from app.services import skin_link_job as J


class _Sess:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *a):
        return False


def test_后台跑_立刻返回_重复点不会再开一趟_算完能查到():
    gate = asyncio.Event()
    calls = []

    async def fake(db, f, t, pid, **kw):
        calls.append((f, t))
        await gate.wait()
        return {"rows": [1, 2, 3], "warnings": ["w"]}

    async def go():
        J._factory, J._runner = _Sess, fake
        J.STATE.clear(); J.STATE["status"] = "idle"
        s = await J.start(date(2026, 11, 1), date(2026, 11, 9), None, False, 0.0, by="甲")
        assert s["status"] == "running" and s["by"] == "甲" and s["estimate_sec"] > 0
        await asyncio.sleep(0)
        s2 = await J.start(date(2026, 10, 1), date(2026, 10, 2), None, False, 0.0, by="乙")
        assert s2["by"] == "甲"            # 正在算：不另开
        gate.set()
        for _ in range(50):
            await asyncio.sleep(0.01)
            if J.status()["status"] != "running":
                break
        st = J.status()
        assert st["status"] == "done" and st["rows"] == 3 and st["finished_at"]
        assert len(calls) == 1

    try:
        asyncio.run(go())
    finally:
        J._factory = J._runner = None


def test_出错记下原因():
    async def boom(*a, **k):
        raise RuntimeError("AI 服务连不上")

    async def go():
        J._factory, J._runner = _Sess, boom
        J.STATE.clear(); J.STATE["status"] = "idle"
        await J.start(date(2026, 11, 1), date(2026, 11, 2), None, False, 0.0, by="甲")
        for _ in range(50):
            await asyncio.sleep(0.01)
            if J.status()["status"] != "running":
                break
        assert J.status()["status"] == "error" and "连不上" in J.status()["error"]

    try:
        asyncio.run(go())
    finally:
        J._factory = J._runner = None
