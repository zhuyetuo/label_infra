"""片段标记：可以打好几个、只留认得的代码；草稿保存 / 只看模式的接口都能打；不改类别起止、不算「动过」"""

from types import SimpleNamespace

from app.api.v1 import segment_review as api
from app.services import task_service
from tests.test_dup_segments import _incoming, _items, _world as _dup_world
from tests.test_segment_review import _world


def test_清洗():
    assert task_service.clean_marks("boundary, compound,boundary,xxx") == "compound,boundary"
    assert task_service.clean_marks("") is None and task_service.clean_marks(None) is None


def test_草稿保存带标记_不算动过(db, run):
    u, _p, lab, t = _dup_world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1000, 5000)]))
    it = _items(db, run, rec.id)[0]
    before = it.touched_at
    inc = _incoming(lab.id, 1000, 5000, origin=it.id)
    inc.marks, inc.mark_note = "av_mismatch,boundary", "  画面里狗在睡，IMU 在动  "
    run(task_service.save_draft(db, t.id, u, [inc]))
    it = _items(db, run, rec.id)[0]
    assert it.marks == "boundary,av_mismatch" and it.mark_note == "画面里狗在睡，IMU 在动"
    assert it.touched_at == before      # 打标记不算「动过这条」
    # 不传 = 保持；传空串 = 清掉
    run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1000, 5000, origin=it.id)]))
    assert _items(db, run, rec.id)[0].marks == "boundary,av_mismatch"
    inc = _incoming(lab.id, 1000, 5000, origin=it.id)
    inc.marks = ""
    run(task_service.save_draft(db, t.id, u, [inc]))
    assert _items(db, run, rec.id)[0].marks is None


def test_只看模式直接打标记_标注员只能打自己的(db, run):
    w = _world(db, run)
    it = w.items[0]
    r = run(api.set_marks(it.id, api.MarksIn(marks=["compound", "other"], note="走着走着甩了一下"), db=db, user=w.rev))["data"]
    assert r["marks"] == "compound,other" and r["mark_note"] == "走着走着甩了一下"
    run(db.refresh(it))
    assert it.marks == "compound,other" and it.label_id == w.child.id and it.seg_status is None
    r = run(api.set_marks(it.id, api.MarksIn(marks=[]), db=db, user=w.ann))["data"]   # 任务的标注员
    assert r["marks"] is None
    stranger = SimpleNamespace(id=999999, role=w.ann.role)
    try:
        run(api.set_marks(it.id, api.MarksIn(marks=["boundary"]), db=db, user=stranger))
        raise AssertionError("别人的任务不该能打")
    except Exception as e:  # noqa: BLE001
        assert getattr(e, "status_code", None) in (403, 404)


def test_任务列表带标记段数(db, run):
    from app.api.v1 import tasks as tasks_api

    w = _world(db, run)
    run(api.set_marks(w.items[0].id, api.MarksIn(marks=["boundary"]), db=db, user=w.rev))
    run(api.set_marks(w.items[1].id, api.MarksIn(marks=["av_mismatch", "compound"]), db=db, user=w.rev))
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    assert {r["id"]: r for r in rows}[w.t.id]["mark_count"] == 2
