"""皮肤评估「抓挠复核完」和项目页片段审核同步"""
from sqlalchemy import select

from app.api.v1 import skin as skin_api
from app.api.v1 import tasks as tasks_api
from app.models.annotation import AnnotationLabelItem
from tests.test_segment_review import _world


def test_抓挠复核完_抓挠片段算审核通过_退回和待定的不动(db, run):
    w = _world(db, run)
    items = w.items
    items[0].review_note = "起止不准"          # 退回的
    items[0].seg_status = "returned"
    items[1].uncertain = True                  # 待定的
    run(db.commit())
    before = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]["projects"][str(w.p.id)]
    assert before["unreviewed"] > 0
    r = run(skin_api.mark_scratch_checked(w.t.id, db=db, user=w.rev))["data"]
    assert r["approved"] > 0
    rows = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == w.rec.id))).scalars().all()
    by_id = {x.id: x for x in rows}
    assert by_id[items[0].id].seg_status == "returned"          # 退回的不动
    assert by_id[items[1].id].seg_status is None                # 待定的不动
    other = [x for x in rows if x.label_id == w.other.id]
    assert all(x.seg_status is None for x in other)            # 别的类别不动
    ai = [x for x in rows if x.label_id == w.child.id and x.start_time_ms == 90000][0]
    assert ai.seg_status == "approved" and ai.ai_confirmed     # AI 的算人确认过
    after = run(tasks_api.label_review_progress(label="抓挠", db=db, user=w.admin))["data"]["projects"][str(w.p.id)]
    assert after["unreviewed"] == 1   # 只剩那条待定的
