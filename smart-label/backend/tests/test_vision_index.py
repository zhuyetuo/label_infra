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

    async def build(path, force=False, mode=None):
        calls.append((path, force))
        if "s2" in path:
            raise RuntimeError("坏视频")
        return {"n": 100, "cached": False, "seconds": 3}

    prog = vi.IndexProgress(status="running", project_id=p.id)
    run(vi.run_project(db, p.id, None, "cam1", True, prog, build_fn=build))
    assert calls == [("d/s1_cam1.mp4", True), ("d/s2_cam1.mp4", True)]   # s2 两个任务共用一路，只建一次；t4 已提交不算
    assert prog.total == 2 and prog.built == 1 and prog.failed == 1
    calls.clear()

    async def cached(path, force=False, mode=None):
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
    # 不是一间一狗的场地：样本有几路搜几路（s2 有 cam2）
    assert sorted(call["paths"]) == ["d/s1_cam1.mp4", "d/s2_cam1.mp4", "d/s2_cam2.mp4"]
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
        run(vi.find_similar(db, t1, vi.SimilarParams(label_name="x", text="a", cam="cam3", scope="task"), search_fn=fn))
    assert fn.calls == []


def test_overlaps():
    assert vi.overlaps(0, 10, 5, 15) and vi.overlaps(5, 6, 0, 10)
    assert not vi.overlaps(0, 10, 10, 20) and not vi.overlaps(10, 20, 0, 10)


def test_按现场布局选路_狗场只用自己单间_影棚全用并提醒(db, run):
    u = User(username="b", password_hash="x", display_name="b", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="q", created_by=u.id)
    db.add(p)
    run(db.flush())
    # 狗场 imu15（旺财，4 号单间）：cam1 槽 = cam4 自己单间，cam2 槽 = cam7 公共区
    g = Sample(sample_code="multicam_1_imu15", video_cam1_path="data_raw/2026_9_13_gouchang/m_cam4_imu15_raw.mp4",
               video_cam2_path="data_raw/2026_9_13_gouchang/m_cam7_raw.mp4", imu_csv_path="x.csv", created_by=u.id)
    # 影棚 imu3（巴利）：三路都是公共的
    y = Sample(sample_code="multicam_2_imu3", video_cam1_path="data_raw/2026_9_13_yingpeng/b_cam1_imu3_raw.mp4",
               video_cam2_path="data_raw/2026_9_13_yingpeng/b_cam2_imu3_raw.mp4",
               video_cam3_path="data_raw/2026_9_13_yingpeng/b_cam3_imu3_raw.mp4", imu_csv_path="y.csv", created_by=u.id)
    db.add(g)
    db.add(y)
    run(db.flush())
    tg = Task(project_id=p.id, sample_id=g.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    ty = Task(project_id=p.id, sample_id=y.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    db.add(tg)
    db.add(ty)
    run(db.commit())
    assert vi.usable_cams(g) == ["cam1"]
    assert vi.usable_cams(y) == ["cam1", "cam2", "cam3"]
    assert vi.is_multi_dog(g, "cam1") is False and vi.is_multi_dog(g, "cam2") is True and vi.is_multi_dog(y, "cam1") is True

    calls = []

    async def build(path, force=False, mode=None):
        calls.append(path)
        return {"n": 1, "cached": False}

    prog = vi.IndexProgress(status="running", project_id=p.id)
    run(vi.run_project(db, p.id, None, "all", False, prog, build_fn=build))
    assert sorted(calls) == ["data_raw/2026_9_13_gouchang/m_cam4_imu15_raw.mp4",
                             "data_raw/2026_9_13_yingpeng/b_cam1_imu3_raw.mp4",
                             "data_raw/2026_9_13_yingpeng/b_cam2_imu3_raw.mp4",
                             "data_raw/2026_9_13_yingpeng/b_cam3_imu3_raw.mp4"]

    db.add(LabelDefinition(project_id=p.id, code="l", display_name="舔身体", created_by=u.id))
    run(db.commit())
    fn = _search({"hits": [{}], "searched": 4, "missing": [],
                  "segments": [{"path": "data_raw/2026_9_13_yingpeng/b_cam2_imu3_raw.mp4", "start_s": 1, "end_s": 4, "score": 0.9, "n": 1},
                               {"path": "data_raw/2026_9_13_gouchang/m_cam4_imu15_raw.mp4", "start_s": 5, "end_s": 8, "score": 0.8, "n": 1}]})
    r = run(vi.find_similar(db, tg, vi.SimilarParams(label_name="舔身体", t_s=3.0), search_fn=fn))
    assert "data_raw/2026_9_13_gouchang/m_cam7_raw.mp4" not in fn.calls[0]["paths"]     # 公共区不搜
    assert r["written"] == 2 and r["multi_dog_candidates"] == 1                          # 影棚那条要提醒


def test_认不出场地的老数据照常全用(db, run):
    u = User(username="c", password_hash="x", display_name="c", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    s = Sample(sample_code="multicam_9_imu2", video_cam1_path="data_raw/2026_9_1/a_cam1_imu2_raw.mp4",
               video_cam2_path="data_raw/2026_9_1/a_cam2_imu2_raw.mp4", imu_csv_path="z.csv", created_by=u.id)
    db.add(s)
    run(db.commit())
    assert vi.usable_cams(s) == ["cam1", "cam2"] and vi.is_multi_dog(s, "cam1") is False


def test_找相似结果带样本和时间_便于找到落在哪(db, run):
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    fn = _search({"hits": [{}] * 2, "searched": 2, "missing": [],
                  "segments": [{"path": "d/s1_cam1.mp4", "start_s": 200, "end_s": 203, "score": 0.7, "n": 1},
                               {"path": "d/s1_cam1.mp4", "start_s": 10, "end_s": 13, "score": 0.9, "n": 1}]})
    r = run(vi.find_similar(db, t1, vi.SimilarParams(label_name="舔身体-后肢臀尾", t_s=42.0), search_fn=fn))
    pt = next(x for x in r["per_task"] if x["task_id"] == t1.id)
    assert pt["sample_code"] == "s1" and pt["candidates"] == 2 and pt["multi_dog"] is False
    assert [i["start_s"] for i in pt["items"]] == [10, 200]          # 分数高的在前


def test_找相似预览接口_把样例帧的狗框交给前端_没视频报人话(db, run, monkeypatch):
    from fastapi import HTTPException

    from app.api.v1 import candidates as api
    from app.services import vision_sam_client as vc

    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    sent = {}

    async def fake(path, t):
        sent.update(path=path, t=t)
        return {"t": t, "has_dog": True, "boxes": [{"bbox": [0.1, 0.1, 0.2, 0.2], "conf": 0.9}],
                "crop": [0, 0, 0.5, 0.5], "jpeg": "", "w": 1920, "h": 1080}

    monkeypatch.setattr(vc, "embed_preview", fake)
    r = run(api.similar_preview(api.SimilarPreviewIn(task_id=t1.id, t_s=42.5), db=db, user=u))["data"]
    assert r["has_dog"] is True and sent == {"path": "d/s1_cam1.mp4", "t": 42.5}
    with pytest.raises(HTTPException) as e:
        run(api.similar_preview(api.SimilarPreviewIn(task_id=t1.id, cam="cam2", t_s=1), db=db, user=u))
    assert e.value.status_code == 422 and "cam2" in e.value.detail
    with pytest.raises(HTTPException) as e:
        run(api.similar_preview(api.SimilarPreviewIn(task_id=t1.id, cam="cam9", t_s=1), db=db, user=u))
    assert e.value.status_code == 422

    async def down(path, t):
        raise vc.SamUnavailable("连不上视觉服务")

    monkeypatch.setattr(vc, "embed_preview", down)
    with pytest.raises(HTTPException) as e:
        run(api.similar_preview(api.SimilarPreviewIn(task_id=t1.id, t_s=1), db=db, user=u))
    assert e.value.status_code == 503


def test_清掉画面相似候选_只删没判过的(db, run):
    from app.api.v1 import candidates as api
    from app.models.ai_candidate import CandidateStatus

    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    for st, reason in ((CandidateStatus.pending, "similar"), (CandidateStatus.pending, "similar"),
                       (CandidateStatus.confirmed, "similar"), (CandidateStatus.pending, "grooming")):
        db.add(AiCandidate(task_id=t1.id, round_no=t1.round_no, label_name="舔", start_time_ms=0, end_time_ms=1000,
                           reason=reason, status=st))
    run(db.commit())
    r = run(api.clear_similar(t1.id, db=db, user=u))["data"]
    assert r["deleted"] == 2
    left = _cands(db, run, t1.id)
    assert sorted((c.reason, c.status.value) for c in left) == [("grooming", "pending"), ("similar", "confirmed")]
    assert run(api.clear_similar(t1.id, db=db, user=u))["data"]["deleted"] == 0


def test_找相似_只看不写_命中带任务和样本_缩略图要token(db, run, monkeypatch):
    from fastapi import HTTPException

    from app.api.v1 import candidates as api
    from app.services import vision_sam_client as vc

    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    result = {"hits": [{"path": "d/s2_cam1.mp4", "t": 70.0, "score": 0.5}, {"path": "d/s1_cam1.mp4", "t": 5.0, "score": 0.4},
                       {"path": "d/s2_cam1.mp4", "t": 100.0, "score": 0.3}],
              "searched": 2, "missing": [], "centered": True,
              "segments": [{"path": "d/s2_cam1.mp4", "start_s": 69, "end_s": 71, "score": 0.5, "n": 1}]}
    fn = _search(result)
    r = run(vi.find_similar(db, t1, vi.SimilarParams(label_name="随便什么", t_s=42.0, dry_run=True, center=False, pose_w=0.3), search_fn=fn))
    assert fn.calls[0]["center"] is False and fn.calls[0]["pose_w"] == 0.3
    assert r["pose_used"] is False
    assert r["dry_run"] is True and r["written"] == 0 and r["centered"] is True and r["ref_path"] == "d/s1_cam1.mp4"
    assert _cands(db, run, t2.id) == [] and _cands(db, run, t1.id) == []          # 一条都没写
    hl = r["hit_list"]
    # 70 秒和 100 秒都落在短任务 t3（60-120）里：短任务优先于整段的 t2
    assert [(h["task_id"], h["sample_code"]) for h in hl] == [(t3.id, "s2"), (t1.id, "s1"), (t3.id, "s2")]
    # 缩略图：要 token，path 得在项目里
    tok = run(api.similar_thumb_token(t1.id, db=db, user=u))["data"]["token"]

    # 每个命中带样本 id 和槽位：前端拿它换视频流，在预览里直接循环播放
    assert [(h["sample_id"], h["cam"]) for h in hl] == [(s2.id, "cam1"), (s1.id, "cam1"), (s2.id, "cam1")]

    async def thumb(path, t, crop=True, view=None, max_side=None):
        return b"\xff\xd8" + path.encode() + (b"c" if crop else b"f") + (view or "").encode() + (str(max_side) if max_side else "").encode()

    monkeypatch.setattr(vc, "embed_thumb", thumb)
    resp = run(api.similar_thumb(t1.id, "d/s2_cam1.mp4", 70.0, tok, crop=False, db=db))
    assert resp.media_type == "image/jpeg" and resp.body.endswith(b"s2_cam1.mp4f")
    resp = run(api.similar_thumb(t1.id, "d/s2_cam1.mp4", 70.0, tok, view="pose", db=db))
    assert resp.body.endswith(b"cpose")
    resp = run(api.similar_thumb(t1.id, "d/s2_cam1.mp4", 70.0, tok, view="mask", max_side=5000, db=db))
    assert resp.body.endswith(b"cmask1920")                                  # 上限 1920
    with pytest.raises(HTTPException) as e:
        run(api.similar_thumb(t1.id, "d/s2_cam1.mp4", 70.0, tok, view="xx", db=db))
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        run(api.similar_thumb(t1.id, "d/other.mp4", 1.0, tok, db=db))      # 不是库里登记的视频
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        run(api.similar_thumb(t1.id, "d/s2_cam1.mp4", 1.0, "bad.token", db=db))
    assert e.value.status_code == 401


def test_找相似_所有项目(db, run):
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    p2 = Project(name="p2", created_by=u.id)
    db.add(p2)
    run(db.flush())
    s9 = Sample(sample_code="s9", video_cam1_path="d/s9_cam1.mp4", imu_csv_path="d/s9.csv", created_by=u.id)
    db.add(s9)
    run(db.flush())
    t9 = Task(project_id=p2.id, sample_id=s9.id, task_type=TaskType.ai_assisted, status=TaskStatus.PENDING_ASSIGN, created_by=u.id)
    db.add(t9)
    run(db.commit())
    result = {"hits": [{"path": "d/s9_cam1.mp4", "t": 5.0, "score": 0.7}], "searched": 1, "missing": ["d/s1_cam1.mp4"],
              "segments": [{"path": "d/s9_cam1.mp4", "start_s": 4, "end_s": 6, "score": 0.7, "n": 1}]}
    fn = _search(result)
    r = run(vi.find_similar(db, t1, vi.SimilarParams(label_name="舔", t_s=1.0, scope="all"), search_fn=fn))
    assert "d/s9_cam1.mp4" in fn.calls[0]["paths"] and "d/s1_cam1.mp4" in fn.calls[0]["paths"]
    assert r["hit_list"][0]["task_id"] == t9.id and r["hit_list"][0]["project_id"] == p2.id
    assert [c.label_name for c in _cands(db, run, t9.id)] == ["舔"]
    assert next(pt for pt in r["per_task"] if pt["task_id"] == t9.id)["project_id"] == p2.id
    # 只搜本项目时别的项目不在
    fn2 = _search(result)
    run(vi.find_similar(db, t1, vi.SimilarParams(label_name="舔", t_s=1.0, scope="project"), search_fn=fn2))
    assert "d/s9_cam1.mp4" not in fn2.calls[0]["paths"]


def test_建索引_暂停继续_停止立刻掐掉正在建的(db, run, monkeypatch):
    """暂停：正在建的建完，后面的停在门口；继续：接着建。停止：正在建的那一路也直接掐掉，不等。"""
    import asyncio

    u, p, _, _ = _world(db, run)
    monkeypatch.setattr(vi.settings, "vision_index_concurrency", 1)

    async def go():
        started, release = [], asyncio.Event()

        async def build(path, force=False, mode=None):
            started.append(path)
            await release.wait()
            return {"n": 1, "cached": False, "seconds": 1}

        prog = vi.IndexProgress(status="running", project_id=p.id)
        _prev = vi._progress.get(p.id)
        vi._progress[p.id] = prog
        vi._running.add(p.id)
        gate = asyncio.Event()
        gate.set()
        vi._gate[p.id] = gate
        try:
            job = asyncio.ensure_future(vi.run_project(db, p.id, None, "all", False, prog, build_fn=build))
            await asyncio.sleep(0.01)
            assert len(started) == 1                       # 并行 1，只开了第一路
            assert vi.pause(p.id) is True and prog.status == "paused"
            release.set()                                  # 第一路建完
            await asyncio.sleep(0.02)
            assert prog.processed == 1 and len(started) == 1   # 第二路停在门口没开始
            release.clear()
            assert vi.resume(p.id) is True and prog.status == "running"
            await asyncio.sleep(0.01)
            assert len(started) == 2                       # 继续：第二路开了
            assert vi.cancel(p.id) is True                 # 停止：第二路正在等 build，直接掐
            await asyncio.wait_for(job, 1)
            assert prog.processed == 1 and prog.total == 3
            assert any("停止" in line for line in prog.detail)
        finally:
            vi._running.discard(p.id)
            vi._cancelled.discard(p.id)
            vi._paused.discard(p.id)
            vi._gate.pop(p.id, None)
            vi._tasks.pop(p.id, None)
            if _prev is None:
                vi._progress.pop(p.id, None)

    run(go())
    assert vi.pause(p.id) is False and vi.resume(p.id) is False and vi.cancel(p.id) is False   # 没在跑


def test_日志里直接说慢在哪一步():
    """建索引慢的时候要能一眼看出是解码/检测慢还是某个模型慢，不用去算法机翻日志。
    只列 0.5 秒以上的，按耗时从大到小；老版本视觉服务不报 spent 就什么都不加。"""
    note = vi._spent_note({"spent": {"scan": 12.0, "pose": 30.5, "seg": 0.2, "embed": 3.0}})
    assert note == "（姿态 30.5s，解码+检测 12.0s，向量 3.0s）"          # 0.2s 的抠狗不占地方
    assert vi._spent_note({}) == "" and vi._spent_note({"spent": {"pose": 0.0}}) == ""


def test_部位条件透传_判不了的部位要如实说没筛(db, run):
    """part 是**几何硬条件不是相似度**：只留「鼻子够到了这个部位」的帧。

    part 有值而 part_used 是 null = 这个部位判不了（腰、腹股沟…鼻子到爪的距离
    说明不了它们），**整条没筛**。这个必须如实带到前端——否则人会把没筛过的
    一大堆当成筛过的结果，越看越糊涂。
    """
    from app.models.project import Project
    from app.models.sample import Sample
    from app.models.task import Task, TaskStatus, TaskType
    from app.models.user import User, UserRole
    from datetime import date

    u = User(username="p1", password_hash="x", display_name="p", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    pj = Project(name="部位", created_by=u.id)
    db.add(pj)
    run(db.flush())
    s = Sample(sample_code="sp1", video_cam1_path="d/sp1_cam1.mp4", imu_csv_path="d/sp1.csv",
               session_date=date(2026, 9, 14), created_by=u.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=pj.id, sample_id=s.id, task_type=TaskType.ai_assisted,
             status=TaskStatus.IN_PROGRESS, round_no=1, created_by=u.id)
    db.add(t)
    run(db.commit())

    base = {"hits": [], "segments": [], "searched": 1, "missing": [],
            "centered": True, "pose_used": True, "pose_w": 0.5}
    fn = _search({**base, "part": "后爪", "part_used": "后爪"})
    r = run(vi.find_similar(db, t, vi.SimilarParams(label_name="舔身体", t_s=10.0,
                                                    part="后爪", dry_run=True), search_fn=fn))
    assert fn.calls[0]["part"] == "后爪"                      # 一路透传到视觉服务
    assert r["part"] == "后爪" and r["part_used"] == "后爪"

    # 判不了的：part_used 为 null，前端据此提示"没筛"
    fn2 = _search({**base, "part": "腹股沟", "part_used": None})
    r2 = run(vi.find_similar(db, t, vi.SimilarParams(label_name="舔身体", t_s=10.0,
                                                     part="腹股沟", dry_run=True), search_fn=fn2))
    assert r2["part"] == "腹股沟" and r2["part_used"] is None

    # 不填部位：不传给视觉服务，回来也是空
    fn3 = _search(base)
    r3 = run(vi.find_similar(db, t, vi.SimilarParams(label_name="舔身体", t_s=10.0, dry_run=True),
                             search_fn=fn3))
    assert fn3.calls[0]["part"] is None and r3["part_used"] is None


def test_勾掉的命中不写候选_段跟着重算(db, run):
    """检索总会混进几张一眼就不对的。为那几张去调参数常常把对的也一起调没了——
    人点两下扔掉更准。扔掉之后**段要重算**：被扔的那帧如果在段边界上，段就得缩；
    整段的帧都被扔了，这段不该再写。"""
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    hits = [{"path": "d/s1_cam1.mp4", "t": 200.0, "score": 0.9},
            {"path": "d/s1_cam1.mp4", "t": 203.0, "score": 0.8},   # 跟上一帧同段（gap 15）
            {"path": "d/s1_cam1.mp4", "t": 400.0, "score": 0.7}]   # 单独一段
    result = {"hits": hits, "searched": 1, "missing": [],
              "segments": [{"path": "d/s1_cam1.mp4", "start_s": 199, "end_s": 204, "score": 0.9, "n": 2},
                           {"path": "d/s1_cam1.mp4", "start_s": 399, "end_s": 401, "score": 0.7, "n": 1}]}
    fn = _search(result)
    r = run(vi.find_similar(db, t1, vi.SimilarParams(
        label_name="舔身体-后肢臀尾", t_s=42.0,
        # 扔掉段尾那一帧 + 整个第二段
        drop=(("d/s1_cam1.mp4", 203.0), ("d/s1_cam1.mp4", 400.0))), search_fn=fn))
    assert r["dropped"] == 2 and r["hits"] == 1
    # 只剩 200 那一帧：段缩成 199~201，400 那一段整个没了
    assert [(c.start_time_ms, c.end_time_ms) for c in _cands(db, run, t1.id)] == [(199000, 201000)]

    # 没勾掉任何一帧时，照旧用视觉服务给的段，不自己重算
    r2 = run(vi.find_similar(db, t2, vi.SimilarParams(label_name="舔身体-后肢臀尾", t_s=42.0), search_fn=_search(result)))
    assert r2["dropped"] == 0


def test_合段规则_相邻的合一段_前后各留一秒():
    """跟视觉服务那边同一套规则。两个仓库解耦，宁可各留一份，也不 import 对方的内部函数。"""
    hits = [{"path": "a", "t": 10.0, "score": 0.5}, {"path": "a", "t": 12.0, "score": 0.9},
            {"path": "a", "t": 40.0, "score": 0.6}, {"path": "b", "t": 0.2, "score": 0.4}]
    segs = vi.group_hits(hits, gap_s=15.0)
    assert {(s["path"], s["start_s"], s["end_s"], s["score"], s["n"]) for s in segs} == {
        ("a", 9.0, 13.0, 0.9, 2), ("a", 39.0, 41.0, 0.6, 1), ("b", 0.0, 1.2, 0.4, 1)}   # 起点不为负
    assert [s["score"] for s in segs] == sorted([s["score"] for s in segs], reverse=True)
    assert vi.group_hits([], gap_s=15.0) == []


def test_逐帧标不同类别_按类别分段写(db, run):
    """一次检索里常常混着别的动作（舔着舔着开始甩身体）。全按一个类别写进去，
    等于把活儿推到后面让人一条条改——在「先看命中」里当场分开标，改的机会就在眼前。

    挨着的两帧标成了不同类别就该是两段：合成一段就得替人选一个类别，
    而那正是人刚刚分开标的东西。"""
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    db.add(LabelDefinition(project_id=p.id, code="shake", display_name="甩身体", created_by=u.id))
    run(db.commit())
    hits = [{"path": "d/s1_cam1.mp4", "t": 200.0, "score": 0.9},
            {"path": "d/s1_cam1.mp4", "t": 203.0, "score": 0.8},    # 紧挨着，但标成别的类别
            {"path": "d/s1_cam1.mp4", "t": 400.0, "score": 0.7}]    # 没勾：不写
    fn = _search({"hits": hits, "searched": 1, "missing": [], "segments": []})
    r = run(vi.find_similar(db, t1, vi.SimilarParams(
        label_name="舔身体-后肢臀尾", t_s=42.0, pick=(
            ("d/s1_cam1.mp4", 200.0, "舔身体-后肢臀尾"),
            ("d/s1_cam1.mp4", 203.0, "甩身体"))), search_fn=fn))
    assert r["written"] == 2 and r["dropped"] == 1
    got = [(c.label_name, c.start_time_ms, c.end_time_ms) for c in _cands(db, run, t1.id)]
    assert got == [("舔身体-后肢臀尾", 199000, 201000), ("甩身体", 202000, 204000)]


def test_合段按视频和类别一起分(db, run):
    hits = [{"path": "a", "t": 10.0, "score": 0.5, "label": "舔"},
            {"path": "a", "t": 12.0, "score": 0.9, "label": "舔"},
            {"path": "a", "t": 13.0, "score": 0.6, "label": "甩身体"}]     # 夹在中间但类别不同
    segs = vi.group_hits(hits, gap_s=15.0)
    assert {(s["label"], s["start_s"], s["end_s"], s["n"]) for s in segs} == {
        ("舔", 9.0, 13.0, 2), ("甩身体", 12.0, 14.0, 1)}


def test_一句话搜不需要当前任务(db, run):
    """想找「一张狗咬尾巴的图」时，人手上还没有任何样例，本来也不该先随便挑个
    任务、打开工作台、再去里面找这个功能。所以 task 可以是 None。"""
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    fn = _search({"hits": [{"path": "d/s1_cam1.mp4", "t": 5.0, "score": 0.8}],
                  "segments": [], "searched": 3, "missing": []})
    r = run(vi.find_similar(db, None, vi.SimilarParams(
        label_name="", text="a dog biting its own tail", dry_run=True), search_fn=fn, project_id=p.id))
    assert r["hits"] == 1 and r["hit_list"][0]["task_id"] == t1.id
    assert sorted(fn.calls[0]["paths"]) == ["d/s1_cam1.mp4", "d/s2_cam1.mp4", "d/s2_cam2.mp4"]
    assert fn.calls[0]["ref"] is None                    # 一句话搜没有样例帧
    # 以图搜图仍然要有任务：没有任务就没有"样例在哪一路的第几秒"
    with pytest.raises(ValueError, match="样例帧"):
        run(vi.find_similar(db, None, vi.SimilarParams(label_name="x", t_s=1.0), search_fn=fn, project_id=p.id))


def test_项目级一句话搜_管理员能搜_别人只能搜自己有任务的项目(db, run, monkeypatch):
    """这两处都写错过一次，一进来就 500：
    visible_project_ids 的参数顺序是 (db, user)；管理员那一档返回的是
    **None（不受限）**，不是空集合——`project_id not in None` 直接 TypeError。
    """
    from fastapi import HTTPException

    from app.api.v1 import projects as api
    from app.services import vision_index_service as vi_

    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    fn = _search({"hits": [{"path": "d/s1_cam1.mp4", "t": 5.0, "score": 0.8}],
                  "segments": [], "searched": 3, "missing": []})
    monkeypatch.setattr(vi_.vc, "embed_search", fn)
    body = api.ProjectSearchIn(text="a dog biting its own tail")
    r = run(api.project_similar_search(p.id, body, db=db, user=u))["data"]
    assert r["hits"][0]["task_id"] == t1.id and r["searched"] == 3

    # 标注员：没有这个项目的任务就看不到（返回的是集合，不是 None）
    from app.models.user import User as _U
    other = _U(username="b", password_hash="x", display_name="b", role=UserRole.annotator)
    db.add(other)
    run(db.commit())
    with pytest.raises(HTTPException) as e:
        run(api.project_similar_search(p.id, body, db=db, user=other))
    assert e.value.status_code == 404


def test_被挡下来时要说清是哪条候选挡的_包括已确认的(db, run):
    """人删掉的是「片段」，挡路的是那条还留着的「候选」——而且多半已经不在
    「待确认」里。只回一句「之前已经写过了」，人点进任务只会看到「待确认 1」里
    没有这一段，然后觉得系统在乱讲。所以挡路的那条要点名：任务、时间、状态。"""
    u, p, (s1, s2), (t1, t2, t3, t4) = _world(db, run)
    db.add(AiCandidate(task_id=t1.id, round_no=t1.round_no, label_name="舔身体-后肢臀尾",
                       start_time_ms=199000, end_time_ms=201000, confidence=0.5,
                       reason="similar", status=CandidateStatus.confirmed))
    run(db.commit())
    blocked: list[dict] = []
    n = run(vi.add_similar_candidates(
        db, t1, "舔身体-后肢臀尾",
        [{"start_s": 199.5, "end_s": 200.5, "score": 0.9}], blocked=blocked))
    assert n == 0
    assert len(blocked) == 1
    b = blocked[0]
    assert b["task_id"] == t1.id and b["status"] == "confirmed"
    assert (b["start_time_ms"], b["end_time_ms"]) == (199000, 201000)
    assert (b["want_start_ms"], b["want_end_ms"]) == (199500, 200500)
