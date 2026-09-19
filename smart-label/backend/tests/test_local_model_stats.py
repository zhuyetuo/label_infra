"""本地模型调用量：快照差值按小时落表、重启归零不记负数、平台刚起来只记快照、按天汇总。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select

from app.models.local_model_stat import LocalModelStat
from app.services import local_model_stats_service as lms


def _ov(dog_calls, dog_frames, sam_calls=0):
    return {"available": True, "models": [
        {"key": "dog", "meter": {"calls": dog_calls, "frames": dog_frames, "errors": 0, "total_ms": dog_calls * 10.0}},
        {"key": "sam", "meter": {"calls": sam_calls, "frames": sam_calls, "errors": 0, "total_ms": sam_calls * 500.0}},
    ]}


def test_差值_重启归零():
    assert lms.delta({"calls": 10, "frames": 100, "errors": 0, "total_ms": 100}, {"calls": 15, "frames": 160, "errors": 1, "total_ms": 150}) == {"calls": 5, "frames": 60, "errors": 1, "total_ms": 50}
    assert lms.delta({"calls": 10, "frames": 100, "errors": 0, "total_ms": 100}, {"calls": 3, "frames": 30, "errors": 0, "total_ms": 30})["calls"] == 3
    assert lms.delta(None, {"calls": 7})["calls"] == 7


def test_采集_第一次只记快照_之后记差值_按小时(db, run, monkeypatch):
    lms._last.clear()
    lms._primed = False
    snaps = iter([_ov(100, 1000), _ov(130, 1300, 2), _ov(5, 50, 2)])     # 第三次：视觉服务重启过

    async def fake():
        return next(snaps)

    monkeypatch.setattr(lms.vc, "models_overview", fake)
    t = datetime(2026, 9, 19, 10, 20)
    assert run(lms.collect(db, t))["collected"] == 0                  # 平台刚起来：只记快照
    assert run(lms.collect(db, t.replace(minute=40)))["collected"] == 2
    assert run(lms.collect(db, t.replace(hour=11)))["collected"] == 1  # sam 没变不记
    rows = run(db.execute(select(LocalModelStat).order_by(LocalModelStat.model_key, LocalModelStat.hour))).scalars().all()
    got = [(r.model_key, r.hour.hour, r.calls, r.frames) for r in rows]
    assert got == [("dog", 10, 30, 300), ("dog", 11, 5, 50), ("sam", 10, 2, 2)]
    st = run(lms.stats(db, 30))
    dog = next(m for m in st["models"] if m["key"] == "dog")
    assert dog["calls"] == 35 and dog["frames"] == 350 and dog["by_day"] == [{"day": "2026-09-19", "calls": 35, "frames": 350, "errors": 0, "total_ms": 350}]
    assert dog["avg_ms"] == 10 and dog["name"].startswith("狗检测")


def test_视觉服务不可用时跳过(db, run, monkeypatch):
    async def fake():
        return {"available": False, "error": "连不上", "models": []}

    monkeypatch.setattr(lms.vc, "models_overview", fake)
    assert run(lms.collect(db))["skipped"] == "连不上"


def test_imu预测模型按天汇总(db, run):
    from datetime import date

    from app.models.inference_run import SampleInferenceRun
    from app.models.sample import Sample
    from app.models.user import User, UserRole
    u = User(username="i", password_hash="x", display_name="i", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    # 同一份样本同模型同模式只有一行（唯一约束），所以三份样本各一次
    ss = []
    for i in range(3):
        s = Sample(sample_code=f"s{i}", video_cam1_path="v", imu_csv_path="c", session_date=date(2026, 9, 1), created_by=u.id)
        db.add(s)
        run(db.flush())
        ss.append(s)
    for i, s in enumerate(ss):
        db.add(SampleInferenceRun(sample_id=s.id, model_tag="ml_rf", mode="viterbi", json_path=f"j{i}", n_windows=100, n_segments=5, n_candidates=2,
                                  created_at=datetime(2026, 9, 18 + (i % 2), 10)))
    db.add(SampleInferenceRun(sample_id=ss[0].id, model_tag="dl_cnn", mode="raw", json_path="k", n_windows=50, created_at=datetime(2026, 9, 18, 9)))
    run(db.commit())
    st = run(lms.imu_stats(db, 400))
    rf = next(m for m in st["models"] if m["model_tag"] == "ml_rf")
    assert rf["samples"] == 3 and rf["windows"] == 300 and [d["samples"] for d in rf["by_day"]] == [2, 1]
    assert st["models"][0]["model_tag"] == "ml_rf"
