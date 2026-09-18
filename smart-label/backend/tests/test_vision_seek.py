"""画面找片段（视觉大模型走 API）→ 候选。

要守住的：
  1. 只送项目里有的那几类，部位取项目里真有的子标签。
  2. 视频秒 → 候选毫秒；带部位且项目里有「父-部位」就落到部位标签。
  3. 只换 reason=vision 且 pending 的旧候选：IMU 来的、人判过的都不碰。
  4. dry_run 一条候选都不写，但会累计"会送多少段"。
  5. 一个任务失败/没那一路视频不影响别的；取消能停。
"""

from __future__ import annotations

from sqlalchemy import select

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import vision_seek_service as vs


class _L:
    _n = 0

    def __init__(self, name, active=True, code=None, parent=None):
        _L._n += 1
        self.id = _L._n
        self.code = code or name
        self.display_name = name
        self.is_active = active
        self.parent_id = parent.id if parent else None
        self.sort_order = self.id


def test_label_specs_只送项目里有的_部位取真有的():
    # 老项目：父叫「舔身体」、部位靠名字前缀，没挂父子关系
    lick = _L("舔身体")
    labels = [_L("抓挠"), lick, _L("舔身体-前肢爪"), _L("舔身体-躯干侧腹"), _L("舔身体-前左爪"),
              _L("蹭身体", active=False), _L("活动")]
    specs = vs.label_specs(labels)
    assert [s["name"] for s in specs] == ["舔身体", "抓挠"]              # 蹭停用了、活动不在四类里
    assert specs[0]["parts"] == ["前左爪", "前肢爪", "躯干侧腹"] and specs[0]["description"]
    assert specs[1]["parts"] == []                                       # 抓挠没加部位子标签
    assert [s["name"] for s in vs.label_specs(labels, ["抓挠"])] == ["抓挠"]
    assert vs.label_specs(labels, ["蹭身体"]) == []
    # 新项目：父叫「舔」、层级挂好；部位按树取（去掉「舔-」前缀），孙辈也送
    lick = _L("舔", code="lick_body")
    fore = _L("舔-前爪", code="lick_body_fore", parent=lick)
    labels = [lick, fore, _L("舔-前左爪", code="lick_body_fore_l", parent=fore), _L("舔-躯干侧腹", parent=lick)]
    specs = vs.label_specs(labels)
    assert [s["name"] for s in specs] == ["舔"]
    assert specs[0]["parts"] == ["前爪", "前左爪", "躯干侧腹"]


def test_segments_to_candidates_秒转毫秒_部位落到子标签():
    names = {"舔身体", "舔身体-前肢爪", "抓挠"}
    segs = [
        {"start_s": 12.0, "end_s": 18.5, "label": "舔身体", "body_part": "前肢爪", "confidence": 0.8},
        {"start_s": 30, "end_s": 36, "label": "舔身体", "body_part": "后肢臀尾", "confidence": 0.7},  # 项目没这个子标签
        {"start_s": 40, "end_s": 46, "label": "抓挠", "body_part": None, "confidence": 0.3},          # 低于 min_conf
        {"start_s": 50, "end_s": 50, "label": "抓挠", "confidence": 0.9},                             # 零长
        {"start_s": "x", "end_s": 3, "label": "抓挠"},                                                # 坏数据
        {"start_s": 5, "end_s": 9, "label": "", "confidence": 0.9},
    ]
    c = vs.segments_to_candidates(segs, names, min_conf=0.5)
    assert [(x.label_name, x.start_time_ms, x.end_time_ms, x.reason) for x in c] == [
        ("舔身体-前肢爪", 12000, 18500, "vision"),
        ("舔身体", 30000, 36000, "vision"),
    ]
    assert c[0].confidence == 0.8 and c[0].spec is None


# ── 写库 ──────────────────────────────────────────────────────────────

def _world(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    for name in ("抓挠", "舔身体", "舔身体-前肢爪", "蹭身体"):
        db.add(LabelDefinition(project_id=p.id, code=name, display_name=name, created_by=u.id))
    s1 = Sample(sample_code="s1", video_cam1_path="d/s1_cam1.mp4", video_cam2_path="d/s1_cam2.mp4",
                imu_csv_path="d/s1.csv", created_by=u.id)
    s2 = Sample(sample_code="s2", video_cam1_path="d/s2_cam1.mp4", imu_csv_path="d/s2.csv", created_by=u.id)
    db.add(s1)
    db.add(s2)
    run(db.flush())
    t1 = Task(project_id=p.id, sample_id=s1.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    t2 = Task(project_id=p.id, sample_id=s2.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    t3 = Task(project_id=p.id, sample_id=s2.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED, created_by=u.id)
    db.add(t1)
    db.add(t2)
    db.add(t3)
    run(db.commit())
    return u, p, (s1, s2), (t1, t2, t3)


def _cands(db, run, task_id):
    return run(db.execute(select(AiCandidate).where(AiCandidate.task_id == task_id)
                          .order_by(AiCandidate.start_time_ms))).scalars().all()


def test_replace_只动画面来的_pending(db, run):
    u, p, (s1, _), (t1, _, _) = _world(db, run)
    db.add(AiCandidate(task_id=t1.id, round_no=1, label_name="抓挠", start_time_ms=0, end_time_ms=1000, reason="spectral"))
    db.add(AiCandidate(task_id=t1.id, round_no=1, label_name="舔身体", start_time_ms=2000, end_time_ms=3000,
                       reason="vision", status=CandidateStatus.confirmed))
    db.add(AiCandidate(task_id=t1.id, round_no=1, label_name="舔身体", start_time_ms=4000, end_time_ms=5000, reason="vision"))
    run(db.commit())
    new = vs.segments_to_candidates([{"start_s": 9, "end_s": 12, "label": "蹭身体", "confidence": 0.9}], {"蹭身体"})
    assert run(vs.replace_vision_candidates(db, t1, new)) == 1
    run(db.commit())
    got = [(c.reason, c.status.value, c.start_time_ms) for c in _cands(db, run, t1.id)]
    assert got == [("spectral", "pending", 0), ("vision", "confirmed", 2000), ("vision", "pending", 9000)]


def _fake_seek(calls, per_path=None, fail_on=None):
    async def seek(path, specs, **kw):
        calls.append({"path": path, "specs": specs, **kw})
        if fail_on and fail_on in path:
            raise RuntimeError("视觉服务挂了")
        segs = (per_path or {}).get(path, [])
        return {"segments": [] if kw.get("dry_run") else segs,
                "stats": {"clips_candidate": 7, "clips_sent": 0 if kw.get("dry_run") else 7,
                          "usage": {"est_usd": 0 if kw.get("dry_run") else 0.05}},
                "dry_run": kw.get("dry_run")}
    return seek


def test_run_project_写候选_跳过没那路视频的_失败不带倒别的(db, run):
    u, p, (s1, s2), (t1, t2, t3) = _world(db, run)
    calls = []
    segs = {"d/s1_cam1.mp4": [{"start_s": 10, "end_s": 16, "label": "舔身体", "body_part": "前肢爪", "confidence": 0.9},
                              {"start_s": 20, "end_s": 26, "label": "蹭身体", "confidence": 0.6}]}
    prog = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, None, vs.SeekParams(max_clips=30), prog, seek_fn=_fake_seek(calls, segs, fail_on="s2")))
    assert prog.total == 2                                   # t3 已提交不碰
    assert (prog.succeeded, prog.failed, prog.skipped) == (1, 1, 0)
    assert prog.candidates == 2 and prog.clips_sent == 7 and prog.est_usd == 0.05
    assert [s["name"] for s in calls[0]["specs"]] == ["舔身体", "抓挠", "蹭身体"]
    assert calls[0]["max_clips"] == 30 and calls[0]["dry_run"] is False
    got = _cands(db, run, t1.id)
    assert [(c.label_name, c.start_time_ms, c.end_time_ms, c.reason) for c in got] == [
        ("舔身体-前肢爪", 10000, 16000, "vision"), ("蹭身体", 20000, 26000, "vision")]
    assert _cands(db, run, t2.id) == []
    assert any("失败" in d for d in prog.detail)

    # 没 cam2 的样本跳过
    calls.clear()
    prog2 = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, None, vs.SeekParams(cam="cam2"), prog2, seek_fn=_fake_seek(calls, segs)))
    assert prog2.skipped == 1 and prog2.succeeded == 1
    assert [c["path"] for c in calls] == ["d/s1_cam2.mp4"]


def test_dry_run_不写候选_只累计段数(db, run):
    u, p, _, (t1, t2, _) = _world(db, run)
    calls = []
    prog = vs.SeekProgress(status="running", project_id=p.id, dry_run=True)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(dry_run=True), prog, seek_fn=_fake_seek(calls)))
    assert calls[0]["dry_run"] is True and prog.total == 1
    assert prog.clips_candidate == 7 and prog.clips_sent == 0 and prog.candidates == 0 and prog.est_usd == 0
    assert _cands(db, run, t1.id) == []


def test_短任务只找那一段_并只送选中的类别(db, run):
    u, p, (s1, _), (t1, _, _) = _world(db, run)
    t1.segment_start_ms, t1.segment_end_ms = 60000, 120000
    run(db.commit())
    calls = []
    prog = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(labels=["蹭身体"]), prog, seek_fn=_fake_seek(calls)))
    assert calls[0]["start_s"] == 60.0 and calls[0]["end_s"] == 120.0
    assert [s["name"] for s in calls[0]["specs"]] == ["蹭身体"] and prog.labels == ["蹭身体"]


def test_项目没这几类标签直接报错(db, run):
    u, p, _, (t1, _, _) = _world(db, run)
    prog = vs.SeekProgress(status="running", project_id=p.id)
    import pytest
    with pytest.raises(RuntimeError, match="模板"):
        run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(labels=["活动"]), prog, seek_fn=_fake_seek([])))


def test_取消后不再发下一个(db, run):
    u, p, _, (t1, t2, _) = _world(db, run)
    calls = []

    async def seek(path, specs, **kw):
        calls.append(path)
        vs._cancelled.add(p.id)      # 第一个跑完就点了取消
        return {"segments": [], "stats": {}}

    prog = vs.SeekProgress(status="running", project_id=p.id)
    try:
        run(vs.run_project(db, p.id, None, vs.SeekParams(), prog, seek_fn=seek))
    finally:
        vs._cancelled.discard(p.id)
    assert len(calls) == 1 and prog.processed == 1 and any("已取消" in d for d in prog.detail)


def test_start_同一项目不重复起(monkeypatch):
    import asyncio

    started = []
    monkeypatch.setattr(vs, "_run", lambda *a: _noop(started, a))
    vs._running.discard(7)
    assert asyncio.run(vs.start(7, None, vs.SeekParams())) is True
    assert asyncio.run(vs.start(7, None, vs.SeekParams())) is False
    vs._running.discard(7)
    assert vs.cancel(7) is False


async def _noop(started, a):
    started.append(a)


def test_选了哪家就带_llm_过去_候选记模型_不同模型互不冲(db, run, monkeypatch):
    from app.services import llm_provider_service as llmsvc

    u, p, (s1, _), (t1, _, _) = _world(db, run)
    run(llmsvc.ensure_rows(db))
    row = run(llmsvc.get_row(db, "gemini"))
    row.api_key = "gk"
    run(db.commit())
    calls = []
    segs = {"d/s1_cam1.mp4": [{"start_s": 10, "end_s": 16, "label": "舔身体", "confidence": 0.9}]}

    prog = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(provider="gemini", model="gemini-2.5-flash"), prog,
                       seek_fn=_fake_seek(calls, segs)))
    assert calls[0]["llm"] == {"provider": "gemini", "model": "gemini-2.5-flash", "api_key": "gk",
                               "base_url": "https://generativelanguage.googleapis.com/v1beta", "price_in": 0.0, "price_out": 0.0}
    assert prog.llm == "gemini:gemini-2.5-flash"
    assert [(c.label_name, c.model) for c in _cands(db, run, t1.id)] == [("舔身体", "gemini:gemini-2.5-flash")]

    # 换一家再跑同一批：第一家的候选留着，两家并排
    row2 = run(llmsvc.get_row(db, "anthropic"))
    row2.api_key = "ak"
    run(db.commit())
    prog2 = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(provider="anthropic"), prog2, seek_fn=_fake_seek(calls, segs)))
    assert calls[1]["llm"]["model"] == "claude-opus-5" and calls[1]["llm"]["price_in"] == 5.0
    assert sorted(c.model for c in _cands(db, run, t1.id)) == ["anthropic:claude-opus-5", "gemini:gemini-2.5-flash"]

    # 同一家重跑：只换自己那份
    prog3 = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(provider="gemini", model="gemini-2.5-flash"), prog3,
                       seek_fn=_fake_seek(calls, {"d/s1_cam1.mp4": []})))
    assert [c.model for c in _cands(db, run, t1.id)] == ["anthropic:claude-opus-5"]

    # 没选哪家：不带 llm（视觉服务用环境变量），候选 model 为空
    prog4 = vs.SeekProgress(status="running", project_id=p.id)
    run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(), prog4, seek_fn=_fake_seek(calls, segs)))
    assert "llm" not in calls[-1] and prog4.llm is None
    assert sorted(str(c.model) for c in _cands(db, run, t1.id)) == ["None", "anthropic:claude-opus-5"]


def test_选的那家没配_key_一个任务都不跑(db, run):
    from app.services import llm_provider_service as llmsvc
    import pytest

    u, p, _, (t1, _, _) = _world(db, run)
    run(llmsvc.ensure_rows(db))
    calls = []
    prog = vs.SeekProgress(status="running", project_id=p.id)
    with pytest.raises(ValueError, match="API key"):
        run(vs.run_project(db, p.id, [t1.id], vs.SeekParams(provider="openai"), prog, seek_fn=_fake_seek(calls)))
    assert calls == [] and prog.total == 0
