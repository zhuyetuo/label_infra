"""片段审核：按类别领一批、逐条通过 / 退回、直接改起止；工作台里改了自动回到待审。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import segment_review as api
from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import task_service


def _world(db, run, n_items=3):
    admin = User(username="boss", password_hash="x", display_name="管理员", role=UserRole.admin)
    rev = User(username="rev", password_hash="x", display_name="审核员", role=UserRole.reviewer)
    rev2 = User(username="rev2", password_hash="x", display_name="审核员2", role=UserRole.reviewer)
    ann = User(username="ann", password_hash="x", display_name="实习生", role=UserRole.annotator)
    for u in (admin, rev, rev2, ann):
        db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=admin.id)
    db.add(p)
    run(db.flush())
    parent = LabelDefinition(project_id=p.id, code="scratch", display_name="抓挠", created_by=admin.id)
    db.add(parent)
    run(db.flush())
    child = LabelDefinition(project_id=p.id, code="scratch_head", display_name="抓挠-头颈耳", parent_id=parent.id,
                            created_by=admin.id)
    other = LabelDefinition(project_id=p.id, code="act", display_name="活动", created_by=admin.id)
    db.add(child)
    db.add(other)
    s = Sample(sample_code="s1", video_cam1_path="a.mp4", imu_csv_path="a.csv", created_by=admin.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED,
             assigned_to=ann.id, created_by=admin.id)
    db.add(t)
    run(db.flush())
    rec = AnnotationRecord(task_id=t.id, round_no=t.round_no or 1, source_type=RecordSourceType.human_only)
    db.add(rec)
    run(db.flush())
    items = []
    for k in range(n_items):
        it = AnnotationLabelItem(annotation_record_id=rec.id, label_id=child.id, start_time_ms=k * 10000,
                                 end_time_ms=k * 10000 + 3000, source_type=LabelItemSource.human_added)
        db.add(it)
        items.append(it)
    # 没人看过的 AI 片段：默认不进审核
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=child.id, start_time_ms=90000,
                               end_time_ms=93000, source_type=LabelItemSource.ai_generated))
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=other.id, start_time_ms=50000,
                               end_time_ms=60000, source_type=LabelItemSource.human_added))
    run(db.commit())
    return SimpleNamespace(admin=admin, rev=rev, rev2=rev2, ann=ann, p=p, parent=parent, child=child, other=other,
                           t=t, rec=rec, items=items)


def _q(run, db, user, **kw):
    return run(api.queue(db=db, user=user, **{"label_id": None, "label_name": None, "seg_status": "pending", "source": "touched",
                                               "project_id": None, "mine": False, "limit": 300, **kw}))["data"]


def test_按大类筛含细类_只算人碰过的(db, run):
    w = _world(db, run)
    d = _q(run, db, w.rev, label_id=w.parent.id)
    assert len(d["items"]) == 3 and d["counts"]["pending"] == 3
    assert {i["label_name"] for i in d["items"]} == {"抓挠-头颈耳"}
    assert len(_q(run, db, w.rev, label_id=w.parent.id, source="all")["items"]) == 4


def test_领一批_别人看不到_通过和退回(db, run):
    w = _world(db, run)
    assert run(api.claim(api.ClaimIn(label_id=w.parent.id, n=2), db, w.rev))["data"]["claimed"] == 2
    assert len(_q(run, db, w.rev, mine=True)["items"]) == 2
    # 另一个审核员只看得到剩下那 1 条，也领不到那 2 条
    assert len(_q(run, db, w.rev2, label_id=w.parent.id)["items"]) == 1
    mine = [i["id"] for i in _q(run, db, w.rev, mine=True)["items"]]
    with pytest.raises(HTTPException) as e:
        run(api.decide(mine[0], api.DecideIn(decision="approved"), db, w.rev2))
    assert e.value.status_code == 409

    run(api.decide(mine[0], api.DecideIn(decision="approved"), db, w.rev))
    with pytest.raises(HTTPException):
        run(api.decide(mine[1], api.DecideIn(decision="returned"), db, w.rev))   # 退回要写原因
    run(api.decide(mine[1], api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    d = _q(run, db, w.rev, label_id=w.parent.id, seg_status="all")
    assert d["counts"] == {"pending": 1, "returned": 1, "approved": 1}
    assert _q(run, db, w.rev, mine=True)["items"] == []          # 审完就不再占着


def test_标注员改了退回的片段_自动回到待审_记调整(db, run):
    w = _world(db, run)
    it = w.items[0]
    run(api.decide(it.id, api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    ret = _q(run, db, w.ann, seg_status="returned")["items"]
    assert [i["id"] for i in ret] == [it.id] and ret[0]["review_note"] == "起止不准"
    run(api.edit(it.id, api.EditIn(start_time_ms=500, end_time_ms=3000), db, w.ann))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert got.seg_status is None and got.review_note is None and '"from": [0, 3000]' in got.boundary_edits


def test_审核员改起止不改状态_标注员不能动别人的(db, run):
    w = _world(db, run)
    it = w.items[1]
    run(api.edit(it.id, api.EditIn(start_time_ms=10200, end_time_ms=13000, label_id=w.child.id), db, w.rev))
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert (got.start_time_ms, got.seg_status) == (10200, "approved")
    with pytest.raises(HTTPException):
        run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.ann))   # 标注员不能通过


def test_工作台里改了通过的片段_回到待审(db, run):
    w = _world(db, run)
    it = w.items[2]
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    w.t.status = TaskStatus.IN_PROGRESS
    w.t.locked_by = w.ann.id
    run(db.commit())
    payload = [SimpleNamespace(label_id=x.label_id, start_time_ms=x.start_time_ms + (100 if x.id == it.id else 0),
                               end_time_ms=x.end_time_ms, origin_item_id=x.id, source_type=None, ai_confidence=None,
                               ai_confirmed=None, uncertain=None, uncertain_reason=None)
               for x in run(db.execute(select(AnnotationLabelItem))).scalars().all()]
    run(task_service.save_draft(db, w.t.id, w.ann, payload))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert got.seg_status is None


def test_导出只要审核通过的片段(db, run, tmp_path, monkeypatch):
    from datetime import date, datetime

    from app.services import training_export_service as svc

    w = _world(db, run)
    run(db.execute(select(Sample))).scalar_one().session_date = date(2026, 9, 1)
    run(api.decide(w.items[0].id, api.DecideIn(decision="approved"), db, w.rev))
    run(api.decide(w.items[1].id, api.DecideIn(decision="returned", note="类别错了"), db, w.rev))

    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_of", csv_start)
    monkeypatch.setattr(svc, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    out = run(svc.export_dataset(db, "seg", project_ids=[w.p.id], scope="seg_approved", dry_run=True))
    assert out["n_segments"] == 1 and out["n_unapproved_skipped"] == 4


def test_按名字跨项目(db, run):
    w = _world(db, run)
    d = _q(run, db, w.rev, label_name="抓挠")
    assert len(d["items"]) == 3
    assert run(api.claim(api.ClaimIn(label_name="抓挠-头颈耳", n=10), db, w.rev))["data"]["claimed"] == 3
    assert _q(run, db, w.rev, label_name="没有这个")["items"] == []


def test_退回数_按项目(db, run):
    w = _world(db, run)
    run(api.decide(w.items[0].id, api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    run(api.decide(w.items[1].id, api.DecideIn(decision="returned", note="类别错了"), db, w.rev))
    d = run(api.returned_summary(db=db, user=w.ann))["data"]
    assert d == {"total": 2, "by_project": {w.p.id: 2}}
    run(api.edit(w.items[0].id, api.EditIn(start_time_ms=100, end_time_ms=3000), db, w.ann))   # 改好一条
    assert run(api.returned_summary(db=db, user=w.ann))["data"]["total"] == 1
