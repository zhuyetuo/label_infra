"""任务页项目行的「完成情况」：服务端按项目汇总，必须跟逐个任务的统计加起来一样"""

from app.api.v1 import tasks as tasks_api
from tests.test_segment_review import _world


def test_progress_跟逐个任务加起来一样(db, run):
    w = _world(db, run)
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    segs = sum(c["n"] for r in rows for c in r["label_counts"].values())
    pend = sum(c["ai_pending"] for r in rows for c in r["label_counts"].values())
    cands = sum(r["cand_count"] for r in rows)
    cpend = sum(r["cand_pending"] for r in rows)
    got = run(tasks_api.tasks_progress(db=db, user=w.admin))["data"][str(w.p.id)]
    assert got == {"segs": segs, "seg_pending": pend, "cands": cands, "cand_pending": cpend}
    assert segs > 0
    # 只看我的：admin 名下没有任务时这个项目不出现（或全是 0）
    mine = run(tasks_api.tasks_progress(mine=True, db=db, user=w.admin))["data"]
    mine_rows = [r for r in rows if r.get("assigned_to") == w.admin.id]
    if not mine_rows:
        assert str(w.p.id) not in mine


def test_抓挠审核进度_按项目汇总_跟逐个任务加起来一样(db, run):
    w = _world(db, run)
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    got = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]
    # 只算抓挠（含子类）：拿逐个任务的 label_counts 按名字挑出来加
    from app.models.label import LabelDefinition
    from sqlalchemy import select

    names = {l.id: l.display_name for l in run(db.execute(select(LabelDefinition))).scalars().all()}
    want = {"n": 0, "approved": 0, "returned": 0}
    for r in rows:
        for lid, c in r["label_counts"].items():
            if names.get(int(lid), "").startswith("抓挠"):
                for k in want:
                    want[k] += c.get(k, 0)
    p = got["projects"][str(w.p.id)]
    assert {k: p[k] for k in want} == want and want["n"] > 0
    assert p["unreviewed"] == want["n"] - want["approved"] - want["returned"]
    assert got["total"]["n"] == want["n"]


def test_项目行的备忘数_跟逐个任务的mark_count一样(db, run):
    """项目行不用展开就能看到「还有几段打了 🔖 备忘」，按种类拆开。"""
    from sqlalchemy import select
    from app.models.annotation import AnnotationLabelItem

    w = _world(db, run)
    items = run(db.execute(select(AnnotationLabelItem))).scalars().all()
    assert len(items) >= 2
    items[0].marks = "compound"
    items[1].marks = "compound,av_mismatch"
    run(db.commit())
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    want = sum(r.get("mark_count") or 0 for r in rows)
    got = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]["marks"]
    m = got.get(str(w.p.id), {"n": 0, "by_kind": {}})
    assert m["n"] == want
    if want == 2:
        assert m["by_kind"] == {"compound": 2, "av_mismatch": 1}


def test_打了备忘的不算还没审(db, run):
    """项目页写着「还没审 2」，点进去两条都是备忘——白跑一趟（2026-11-13）。备忘 = 先放着，单独数。"""
    from sqlalchemy import select
    from app.models.annotation import AnnotationLabelItem

    w = _world(db, run)
    before = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]["projects"][str(w.p.id)]
    it = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.label_id == w.child.id,
                                                          AnnotationLabelItem.seg_status.is_(None),
                                                          AnnotationLabelItem.review_note.is_(None)))).scalars().first()
    assert it is not None
    it.marks = "unclear"
    run(db.commit())
    after = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]["projects"][str(w.p.id)]
    assert after["unreviewed"] == before["unreviewed"] - 1 and after["marked"] == before.get("marked", 0) + 1
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    c = rows[0]["label_counts"][str(w.child.id)] if str(w.child.id) in rows[0]["label_counts"] else rows[0]["label_counts"][w.child.id]
    assert c["marked"] == 1


def test_每类通过的分别是谁(db, run):
    from app.api.v1 import segment_review as seg_api

    w = _world(db, run)
    run(seg_api.decide(w.items[0].id, seg_api.DecideIn(decision="approved"), db, w.rev))
    run(seg_api.decide(w.items[1].id, seg_api.DecideIn(decision="approved"), db, w.rev2))
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    lc = rows[0]["label_counts"]
    c = lc.get(w.child.id) or lc.get(str(w.child.id))
    assert c["approved_by"] == {str(w.rev.id): 1, str(w.rev2.id): 1}
