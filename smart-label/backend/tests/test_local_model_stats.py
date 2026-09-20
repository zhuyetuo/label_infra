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
    snaps = iter([_ov(100, 1000), _ov(130, 1300, 2), _ov(5, 50, 2)])     # 第三次：视觉服务重启过

    async def fake():
        return next(snaps)

    monkeypatch.setattr(lms.vc, "models_overview", fake)
    t = datetime(2026, 9, 19, 10, 20)
    assert run(lms.collect(db, t))["collected"] == 0                  # 库里没快照：只记快照
    from app.models.local_model_stat import LocalModelSnapshot
    assert {r.model_key: r.calls for r in run(db.execute(select(LocalModelSnapshot))).scalars().all()} == {"dog": 100, "sam": 0}
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


def test_即时采集_限流_出错不影响读数(db, run, monkeypatch):
    calls = {"n": 0}

    async def fake():
        calls["n"] += 1
        return _ov(10 + calls["n"], 100)

    monkeypatch.setattr(lms.vc, "models_overview", fake)
    lms._last_collect_at = 0.0
    run(lms.collect_throttled(db))
    run(lms.collect_throttled(db))          # 20 秒内不再采
    assert calls["n"] == 1
    lms._last_collect_at = 0.0

    async def boom():
        raise RuntimeError("x")

    monkeypatch.setattr(lms.vc, "models_overview", boom)
    run(lms.collect_throttled(db))          # 不抛
    assert run(lms.stats(db, 30))["models"] == []


def test_最近一次调用_只往后走_视觉服务重启不抹掉(db, run, monkeypatch):
    """视觉服务的 last_at 在它自己内存里，重启归零。快照行上记的那个不能跟着退回去。"""
    from app.models.local_model_stat import LocalModelSnapshot

    t0 = datetime(2026, 9, 19, 10, 0).timestamp()
    seq = iter([
        {"available": True, "models": [{"key": "dog", "meter": {"calls": 5, "frames": 50, "errors": 0, "total_ms": 50.0, "last_at": t0}}]},
        {"available": True, "models": [{"key": "dog", "meter": {"calls": 9, "frames": 90, "errors": 0, "total_ms": 90.0, "last_at": t0 + 3600}}]},
        # 重启了：计数归零、last_at 也退回到更早
        {"available": True, "models": [{"key": "dog", "meter": {"calls": 1, "frames": 10, "errors": 0, "total_ms": 10.0, "last_at": t0 - 99999}}]},
        # 没 last_at（老版本视觉服务）：不动已经记下的
        {"available": True, "models": [{"key": "dog", "meter": {"calls": 2, "frames": 20, "errors": 0, "total_ms": 20.0}}]},
    ])

    async def fake():
        return next(seq)

    monkeypatch.setattr(lms.vc, "models_overview", fake)
    at = lambda: run(db.execute(select(LocalModelSnapshot))).scalars().one().last_call_at
    run(lms.collect(db, datetime(2026, 9, 19, 10, 5)))
    assert at() == datetime.fromtimestamp(t0)                  # 第一次就记上
    run(lms.collect(db, datetime(2026, 9, 19, 11, 5)))
    assert at() == datetime.fromtimestamp(t0 + 3600)
    run(lms.collect(db, datetime(2026, 9, 19, 12, 5)))
    assert at() == datetime.fromtimestamp(t0 + 3600)            # 重启不往回退
    run(lms.collect(db, datetime(2026, 9, 19, 13, 5)))
    assert at() == datetime.fromtimestamp(t0 + 3600)            # 老版本没这个字段也不动
    dog = next(m for m in run(lms.stats(db, 30))["models"] if m["key"] == "dog")
    assert dog["last_call_at"] == datetime.fromtimestamp(t0 + 3600).isoformat(timespec="seconds")


def test_服务端和端侧分开_端侧服务没起时按命名兜底(db, run, monkeypatch):
    """跑的是服务器上的 sklearn 还是烧进项圈的那份 C，这两类不能混在一张表里看。"""
    from datetime import date

    from app.models.inference_run import SampleInferenceRun
    from app.models.sample import Sample
    from app.models.user import User, UserRole

    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    s = Sample(sample_code="s1", video_cam1_path="d/s1.mp4", imu_csv_path="d/s1.csv",
               session_date=date(2026, 9, 19), created_by=u.id)
    db.add(s)
    run(db.flush())
    for tag, mode in (("ml_rf", "viterbi"), ("acc3_rf", "viterbi"), ("edge_rf_d10", "viterbi"), ("edge_cnn_i8", "board")):
        db.add(SampleInferenceRun(sample_id=s.id, model_tag=tag, mode=mode, json_path=f"{tag}.json",
                                  n_windows=10, n_segments=2, n_candidates=1))
    run(db.commit())

    async def no_edge_service():
        return set()

    monkeypatch.setattr(lms, "_edge_tags", no_edge_service)
    got = {(m["model_tag"], m["mode"]): m["kind"] for m in run(lms.imu_stats(db, 30))["models"]}
    assert got == {("ml_rf", "viterbi"): "server", ("acc3_rf", "viterbi"): "server",
                   ("edge_rf_d10", "viterbi"): "edge", ("edge_cnn_i8", "board"): "edge"}
    # 服务端排在前面
    assert [m["kind"] for m in run(lms.imu_stats(db, 30))["models"]][:2] == ["server", "server"]

    # 端侧服务起着：按它报的清单分，名字不带 edge_ 的也能认出来
    async def with_edge_service():
        return {"acc3_rf"}

    monkeypatch.setattr(lms, "_edge_tags", with_edge_service)
    got = {(m["model_tag"], m["mode"]): m["kind"] for m in run(lms.imu_stats(db, 30))["models"]}
    assert got[("acc3_rf", "viterbi")] == "edge" and got[("ml_rf", "viterbi")] == "server"
