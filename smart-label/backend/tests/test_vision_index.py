"""画面向量索引：建索引任务 + 找相似 → 候选。

要守住的：同一路视频只建一次；找相似的命中按视频落到对应任务；短任务只收自己区间的；
跟已有同标签重叠的不重复写；t_s/text 二选一；范围为空报人话。
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import vision_index_service as vi


def _world(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    db.add(LabelDefinition(project_id=p.id, code="lick", display_name="舔身体-后肢臀尾", created_by=u.id))
    s1 = Sample(sample_code="s1", video_cam1_path="d/s1_cam1.mp4", imu_csv_path="d/s1.csv", created_by=u.id)
    s2 = Sample(sample_code="s2", video_cam1_path="d/s2_cam1.mp4", video_cam2_path="d/s2_cam2.mp4",
                imu_csv_path="d/s2.csv", created_by=u.id)
    db.add(s1)
    db.add(s2)
    run(db.flush())
    t1 = Task(project_id=p.id, sample_id=s1.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    t2 = Task(project_id=p.id, sample_id=s2.id, task_type=TaskType.ai_assisted, status=TaskStatus.IN_PROGRESS, created_by=u.id)
    # 同一样本 s2 的一个短任务（60-120 秒）
    t3 = Task(project_id=p.id, sample_id=s2.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN,
              segment_start_ms=60000, segment_end_ms=120000, created_by=u.id)
    t4 = Task(project_id=p.id, sample_id=s1.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED, created_by=u.id)
    for t in (t1, t2, t3, t4):
        db.add(t)
    run(db.commit())
    return u, p, (s1, s2), (t1, t2, t3, t4)


def _cands(db, run, task_id):
    return run(db.execute(select(AiCandidate).where(AiCandidate.task_id == task_id)
                          .order_by(AiCandidate.start_time_ms))).scalars().all()


def test_建索引_同一路只建一次_失败不带倒(db, run):
    u, p, _, _ = _world(db, run)
    calls = []

    async def build(path, force=False):
        calls.append((path, force))
        if "s2" in path:
            raise RuntimeError("坏视频")
        return {"n": 100, "cached": False, "seconds": 3}

    prog = vi.IndexProgress(status="running", project_id=p.id)
    run(vi.run_project(db, p.id, None, "cam1", True, prog, build_fn=build))
    assert calls == [("d/s1_cam1.mp4", True), ("d/s2_cam1.mp4", True)]   # s2 两个任务共用一路，只建一次；t4 已提交不算
    assert prog.total == 2 and prog.built == 1 and prog.failed == 1
    calls.clear()

    async def cached(path, force=False):
        calls.append(path)
        return {"n": 5, "cached": True}

    prog2 = vi.IndexProgress(status="running", project_id=p.id)
    run(vi.run_project(db, p.id, None, "cam2", False, prog2, build_fn=cached))
    assert calls == ["d/s2_cam2.mp4"] and prog2.cached == 1     # s1 没 cam2
    # all：有几路建几路，仍然每路只一次
    calls.clear()
    prog3 = vi.IndexProgress(status="running", project_id=p.id)
    run(vi.run_project(db, p.id, None, "all", False, prog3, build_fn=cached))
    assert sorted(calls) == ["d/s1_cam1.mp4", "d/s2_cam1.mp4", "d/s2_cam2.mp4"] and prog3.total == 3


def _search(result):
    calls = []

    async def fn(paths, **kw):
        calls.append({"paths": paths, **kw})
        return result
    fn.calls = calls
    return fn


def test_找相似_命中落到对应任务_短任务只收自己区间_重叠不重复(db, run):
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    # 已有一条同标签候选在 s2 的 10-14 秒（人确认过）：新命中 12-16 重叠，不重复写
    db.add(AiCandidate(task_id=t2.id, round_no=1, label_name="舔身体-后肢臀尾", start_time_ms=10000, end_time_ms=14000,
                       reason="vision", status=CandidateStatus.confirmed))
    run(db.commit())
    result = {"hits": [{}] * 5, "searched": 2, "missing": [],
              "segments": [{"path": "d/s2_cam1.mp4", "start_s": 12, "end_s": 16, "score": 0.9, "n": 3},
                           {"path": "d/s2_cam1.mp4", "start_s": 70, "end_s": 75, "score": 0.8, "n": 2},
                           {"path": "d/s1_cam1.mp4", "start_s": 200, "end_s": 203, "score": 0.7, "n": 1}]}
    fn = _search(result)
    r = run(vi.find_similar(db, t1, vi.SimilarParams(label_name="舔身体-后肢臀尾", t_s=42.0, top_k=30), search_fn=fn))
    call = fn.calls[0]
    assert sorted(call["paths"]) == ["d/s1_cam1.mp4", "d/s2_cam1.mp4"]
    assert call["ref"] == {"path": "d/s1_cam1.mp4", "t": 42.0} and call["text"] is None and call["top_k"] == 30
    assert r["written"] == 3 and r["searched"] == 2
    assert [(c.start_time_ms, c.end_time_ms, c.reason, c.model) for c in _cands(db, run, t1.id)] == [(200000, 203000, "similar", "siglip")]
    # t2 整段：12-16 跟已确认的 10-14 重叠 → 不写；70-75 写
    assert [(c.start_time_ms, c.status.value) for c in _cands(db, run, t2.id)] == [(10000, "confirmed"), (70000, "pending")]
    # t3 只收 60-120 秒里的
    assert [c.start_time_ms for c in _cands(db, run, t3.id)] == [70000]
    assert _cands(db, run, t4.id) == []
    assert _cands(db, run, t1.id)[0].confidence == 0.7 and _cands(db, run, t1.id)[0].label_name == "舔身体-后肢臀尾"

    # 再搜一遍同样的：全部重叠，一条都不加
    r2 = run(vi.find_similar(db, t1, vi.SimilarParams(label_name="舔身体-后肢臀尾", t_s=42.0), search_fn=fn))
    assert r2["written"] == 0


def test_找相似_只在本任务_和一句话搜(db, run):
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    fn = _search({"hits": [], "segments": [], "searched": 1, "missing": []})
    r = run(vi.find_similar(db, t2, vi.SimilarParams(label_name="舔身体-后肢臀尾", text="dog licking its tail", scope="task"),
                            search_fn=fn))
    assert fn.calls[0]["paths"] == ["d/s2_cam1.mp4"] and fn.calls[0]["text"] == "dog licking its tail" and fn.calls[0]["ref"] is None
    assert r["written"] == 0


def test_找相似_参数错报人话(db, run):
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    fn = _search({"hits": [], "segments": []})
    with pytest.raises(ValueError, match="二选一"):
        run(vi.find_similar(db, t1, vi.SimilarParams(label_name="x"), search_fn=fn))
    with pytest.raises(ValueError, match="二选一"):
        run(vi.find_similar(db, t1, vi.SimilarParams(label_name="x", t_s=1, text="a"), search_fn=fn))
    with pytest.raises(ValueError, match="cam2"):
        run(vi.find_similar(db, t1, vi.SimilarParams(label_name="x", t_s=1, cam="cam2"), search_fn=fn))
    with pytest.raises(ValueError, match="没有可搜"):
        run(vi.find_similar(db, t1, vi.SimilarParams(label_name="x", text="a", cam="cam3"), search_fn=fn))
    assert fn.calls == []


def test_overlaps():
    assert vi.overlaps(0, 10, 5, 15) and vi.overlaps(5, 6, 0, 10)
    assert not vi.overlaps(0, 10, 10, 20) and not vi.overlaps(10, 20, 0, 10)
