"""数据库 / 后端卡住时，系统监控照样能打开，并且能看出卡在哪"""
import logging

from fastapi.testclient import TestClient

from app.core import perf
from app.core.security import create_access_token
from app.db.session import get_db
from app.main import app


class _NoDb:
    def __getattr__(self, name):
        raise RuntimeError("系统状态不该碰业务数据库")


def test_系统状态只看token_不查业务库(monkeypatch):
    async def fake_snapshot(*a, **k):
        return {"ok": False, "error": "数据库 3 秒没回应"}

    monkeypatch.setattr(perf, "db_snapshot", fake_snapshot)
    from app.api.v1 import system
    monkeypatch.setattr(system.settings, "algo_service_url", "")
    monkeypatch.setattr(system.settings, "vision_service_url", "")
    monkeypatch.setattr(system, "_svc_cache", None)
    app.dependency_overrides[get_db] = lambda: _NoDb()
    try:
        c = TestClient(app, raise_server_exceptions=False)
        ok = c.get("/api/v1/system/status", headers={"Authorization": f"Bearer {create_access_token(1, 'admin')}"})
        assert ok.status_code == 200 and ok.json()["data"]["db"]["ok"] is False
        assert "inflight" in ok.json()["data"]["web"]
        no = c.get("/api/v1/system/status", headers={"Authorization": f"Bearer {create_access_token(2, 'annotator')}"})
        assert no.status_code == 403
        assert c.get("/api/v1/system/status").status_code == 401
    finally:
        app.dependency_overrides.clear()
        system._svc_cache = None


def test_正在处理的请求能看到_等得久的在前():
    a = perf.inflight_start("GET", "/api/v1/tasks")
    b = perf.inflight_start("POST", "/api/v1/skin/link/refresh")
    perf.INFLIGHT[a] = (perf.INFLIGHT[a][0] - 40, perf.INFLIGHT[a][1])
    perf.INFLIGHT[b] = (perf.INFLIGHT[b][0] - 5, perf.INFLIGHT[b][1])
    try:
        lst = perf.inflight_list(1.0)
        assert lst[0]["req"] == "GET /api/v1/tasks" and lst[0]["sec"] >= 40
        assert [x["req"] for x in perf.inflight_list(30)] == ["GET /api/v1/tasks"]
    finally:
        perf.inflight_end(a)
        perf.inflight_end(b)
    assert a not in perf.INFLIGHT and b not in perf.INFLIGHT


def test_卡住时写STUCK日志_事后能查(caplog):
    with caplog.at_level(logging.WARNING, logger="perf"):
        perf._watchdog({"ok": True, "mdl_waits": [{"table": "users", "sec": 40, "waiting": "ALTER TABLE users", "blocking_id": 9}]})
        perf._watchdog({"ok": False, "error": "数据库 5 秒没回应"})
    msgs = [r.getMessage() for r in caplog.records]
    assert any("STUCK" in m and "等表锁" in m for m in msgs)
    assert any("STUCK" in m and "没回应" in m for m in msgs)
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="perf"):
        perf._watchdog({"ok": True})
    assert not caplog.records


def test_被堵时在处理的请求_算嫌疑():
    import time
    perf.LAG_EVENTS.append((time.time(), 1400.0, ["GET /api/v1/skin/daily-tracking", "GET /api/v1/tasks/12"]))
    perf.LAG_EVENTS.append((time.time(), 300.0, ["GET /api/v1/skin/daily-tracking"]))
    try:
        s = perf._lag_suspects(300)
        assert s[0]["route"] == "GET /api/v1/skin/daily-tracking" and s[0]["n"] == 2 and s[0]["max_lag"] == 1400.0
        assert any(x["route"] == "GET /api/v1/tasks/{id}" for x in s)
    finally:
        perf.LAG_EVENTS.clear()


def test_照片按日期匹配():
    from app.services.skin_tracking_service import _match_photos
    idx = [("2026-11-08", "002拉布拉多小七", 12, "f1"), ("2026-11-07", "002拉布拉多小七", 5, "f0"), ("2026-11-08", "旺财", 3, "f1")]
    n, dog, pairs = _match_photos(idx, "2026-11-08", "小七")
    assert n == 12 and dog == "002拉布拉多小七" and pairs == [("f1", "002拉布拉多小七")]


def test_看门狗_循环被堵住时记下卡在哪一行(monkeypatch):
    import threading
    import time as _t

    perf.BLOCKED.clear()
    perf.LAST_TICK = _t.monotonic() - 10          # 假装循环已经 10 秒没转
    me = threading.get_ident()
    th = threading.Thread(target=perf._watchdog_thread, args=(me,), daemon=True)
    th.start()
    _t.sleep(1.5)                                  # 当前线程「卡」在 sleep 里
    assert perf.BLOCKED, "看门狗没记下来"
    ev = perf.BLOCKED[-1]
    assert ev["sec"] >= 5 and "test_monitor_stuck" in ev["stack"]
    perf.LAST_TICK = _t.monotonic() + 3600        # 让线程恢复安静
