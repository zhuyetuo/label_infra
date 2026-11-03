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
    d = run(system.get_status(db=db))["data"]
    assert d["db"]["ok"] and d["disks"] and d["cpu"]["count"] == os.cpu_count()
    assert d["mem"]["total"] and d["services"][0]["ok"] is None
