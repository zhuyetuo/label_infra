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
