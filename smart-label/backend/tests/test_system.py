"""系统监控：日志尾巴 + 筛选（堆栈跟着上一条走）、资源状态能出。"""

import os

import pytest
from fastapi import HTTPException

from app.api.v1 import system


def test_logs(tmp_path, monkeypatch, run):
    monkeypatch.setattr(system.settings, "log_dir", str(tmp_path))
    lines = [
        "2026-11-03 10:00:00,001 INFO app: ok 1",
        "2026-11-03 10:00:01,001 ERROR app: boom",
        "Traceback (most recent call last):",
        '  File "x.py", line 1',
        "2026-11-03 10:00:02,001 WARNING slow: SLOW GET /api/v1/tasks 16000ms -> 200",
        "2026-11-03 10:00:03,001 INFO app: ok 2",
    ]
    (tmp_path / "api.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (tmp_path / "api.log.2026-11-02").write_text("old\n", encoding="utf-8")
    d = run(system.get_logs(file="api.log", lines=500))["data"]
    assert d["lines"] == lines and d["dates"] == ["2026-11-02"]
    d = run(system.get_logs(file="api.log", lines=500, level="ERROR"))["data"]
    assert d["lines"] == lines[1:4]                    # 堆栈跟着那条 ERROR
    d = run(system.get_logs(file="api.log", lines=500, q="slow"))["data"]
    assert d["lines"] == [lines[4]]
    d = run(system.get_logs(file="api.log", lines=2))["data"]
    assert d["lines"] == lines[-2:]
    with pytest.raises(HTTPException):
        run(system.get_logs(file="../etc/passwd"))
    with pytest.raises(HTTPException):
        run(system.get_logs(file="api.log", date="../../x"))


def test_status(db, run, tmp_path, monkeypatch):
    monkeypatch.setattr(system.settings, "nas_root", str(tmp_path))
    monkeypatch.setattr(system.settings, "algo_service_url", "")
    monkeypatch.setattr(system.settings, "vision_service_url", "")
    from app.core import perf

    async def fake_snapshot(timeout=3.0, session_factory=None):
        return {"ok": True, "ms": 1.0}
    monkeypatch.setattr(perf, "db_snapshot", fake_snapshot)
    perf.record_request("GET", "/api/v1/tasks", 120.0, 200)
    perf.record_request("GET", "/api/v1/tasks", 4200.0, 200)
    d = run(system.get_status())["data"]
    assert d["db"]["ok"] and d["disks"] and d["cpu"]["count"] == os.cpu_count()
    assert d["web"]["requests"] >= 2 and d["web"]["over_3s"] >= 1
    assert d["web"]["slowest"][0]["route"] == "GET /api/v1/tasks"
    assert d["mem"]["total"] and d["services"][0]["ok"] is None



def test_数据库卡死时监控不跟着卡(run):
    """库卡住（连接池拿不到连接 / 查询在等锁）：监控在超时内返回「没回应」，不会一直挂着"""
    import asyncio
    import time
    from contextlib import asynccontextmanager

    from app.core import perf

    @asynccontextmanager
    async def stuck():
        await asyncio.sleep(10)
        yield None

    t0 = time.perf_counter()
    snap = run(perf.db_snapshot(0.3, session_factory=stuck))
    assert time.perf_counter() - t0 < 2
    assert snap["ok"] is False and "没回应" in snap["error"]
