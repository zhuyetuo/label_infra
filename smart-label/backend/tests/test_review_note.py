"""审核时按片段标「有问题」，退回时具体到哪几条。

以前只能整个任务退回，标注员拿回去不知道该看哪几条。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import tasks as tasks_api
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.task import TaskStatus
from app.models.user import User, UserRole
from app.schemas.task import ReviewNoteIn
from app.services import review_service, task_service
from tests.test_dup_segments import _world


def _in(label_id, start, end, origin=None):
    return SimpleNamespace(label_id=label_id, start_time_ms=start, end_time_ms=end, origin_item_id=origin,
                           source_type=LabelItemSource.human_added, ai_confidence=None,
                           ai_confirmed=None, uncertain=None, uncertain_reason=None)


@pytest.fixture()
def setup(db, run):
    admin, _p, lab, t = _world(db, run)
    annot = User(username="ann", password_hash="x", display_name="ann", role=UserRole.annotator)
    db.add(annot)
    run(db.commit())
    rec = run(task_service.save_draft(db, t.id, admin, [_in(lab.id, 1000, 5000), _in(lab.id, 8000, 9000)]))
    items = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == rec.id)
                           .order_by(AnnotationLabelItem.id))).scalars().all()
    return admin, annot, lab, t, items


def _note(run, db, user, t, item, note):
    return run(tasks_api.set_review_note(t.id, item.id, ReviewNoteIn(note=note), db=db, user=user))


def test_管理员标一条有问题_退回后带到新一轮(db, run, setup):
    admin, _annot, _lab, t, items = setup
    _note(run, db, admin, t, items[0], "类别错了：其实是甩身体")
    t.status = TaskStatus.APPROVED
    run(db.commit())
    run(review_service.reopen_task(db, t.id, admin, "有 1 段有问题"))
    rec = run(db.execute(select(AnnotationRecord).where(AnnotationRecord.task_id == t.id,
                                                        AnnotationRecord.round_no == 2))).scalar_one()
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == rec.id)
                         .order_by(AnnotationLabelItem.start_time_ms))).scalars().all()
    assert [i.review_note for i in got] == ["类别错了：其实是甩身体", None]
    assert got[0].review_flag_by == admin.id


def test_标注员不能给别人标_只能在自己认领的任务里清掉(db, run, setup):
    _admin, annot, _lab, t, items = setup
    t.locked_by = annot.id
    t.assigned_to = annot.id
    items[0].review_note = "起止不准"
    run(db.commit())
    with pytest.raises(HTTPException) as e:
        _note(run, db, annot, t, items[1], "我觉得不对")
    assert e.value.status_code == 403
    _note(run, db, annot, t, items[0], None)
    run(db.refresh(items[0]))
    assert items[0].review_note is None


def test_标注员改了这一条_标记自动清掉(db, run, setup):
    admin, _annot, lab, t, items = setup
    _note(run, db, admin, t, items[0], "起止不准")
    _note(run, db, admin, t, items[1], "类别错了")
    run(task_service.save_draft(db, t.id, admin, [_in(lab.id, 1200, 5000, origin=items[0].id),
                                                  _in(lab.id, 8000, 9000, origin=items[1].id)]))
    run(db.refresh(items[0]))
    run(db.refresh(items[1]))
    assert items[0].review_note is None, "改了起止就算处理过了"
    assert items[1].review_note == "类别错了", "没动的那条标记还在"


def test_别的任务的片段标不了(db, run, setup):
    admin, _annot, _lab, t, _items = setup
    with pytest.raises(HTTPException) as e:
        run(tasks_api.set_review_note(t.id, 999999, ReviewNoteIn(note="x"), db=db, user=admin))
    assert e.value.status_code == 404
