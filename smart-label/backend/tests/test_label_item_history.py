"""已标注片段要能一眼看出来历：AI 当初判的是什么、人确认了还是改成了别的。

is_modified 只说"改过"，说不出原来是什么；这里守：AI 原始判断在生成时记下、
之后怎么改都不动；从疑似片段确认来的，草稿接口带上那条候选猜的类别。
"""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import select

from app.api.v1 import tasks as tasks_api
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, LabelItemSource
from app.models.label import LabelDefinition
from app.services import task_service
from tests.test_dup_segments import _world


def _in(label_id, start, end, origin=None, src=LabelItemSource.human_added):
    return SimpleNamespace(label_id=label_id, start_time_ms=start, end_time_ms=end, origin_item_id=origin,
                           source_type=src, ai_confidence=0.7 if src == LabelItemSource.ai_generated else None,
                           ai_confirmed=None, uncertain=None, uncertain_reason=None)


def _one(db, run, rec_id):
    return run(db.execute(select(AnnotationLabelItem)
                          .where(AnnotationLabelItem.annotation_record_id == rec_id))).scalars().one()


def test_AI片段改了类别和起止_原始判断还在(db, run):
    u, p, lick, t = _world(db, run)
    act = LabelDefinition(project_id=p.id, code="act", display_name="活动", created_by=u.id)
    db.add(act)
    run(db.commit())

    rec = run(task_service.save_draft(db, t.id, u, [_in(lick.id, 1000, 5000, src=LabelItemSource.ai_generated)]))
    it = _one(db, run, rec.id)
    assert (it.ai_label_id, it.ai_start_ms, it.ai_end_ms) == (lick.id, 1000, 5000)

    rec = run(task_service.save_draft(db, t.id, u, [_in(act.id, 1200, 4800, origin=it.id)]))
    it = _one(db, run, rec.id)
    assert it.label_id == act.id and it.is_modified
    assert (it.ai_label_id, it.ai_start_ms, it.ai_end_ms) == (lick.id, 1000, 5000), "改完原始判断不能丢"


def test_人工画的没有AI原始判断(db, run):
    u, p, lick, t = _world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [_in(lick.id, 1000, 5000)]))
    assert _one(db, run, rec.id).ai_label_id is None


def test_草稿接口带上疑似片段当初猜的类别(db, run):
    u, p, lick, t = _world(db, run)
    c = AiCandidate(task_id=t.id, round_no=1, label_name="舔", start_time_ms=1000, end_time_ms=5000,
                    reason="grooming", status=CandidateStatus.confirmed)
    db.add(c)
    run(db.flush())
    rec = run(task_service.save_draft(db, t.id, u, [_in(lick.id, 1000, 5000)]))
    it = _one(db, run, rec.id)
    it.from_candidate_id = c.id
    run(db.commit())
    out = run(tasks_api.get_draft(t.id, db=db, user=u))
    body = out["data"] if isinstance(out, dict) else out
    item = body["items"][0]
    assert item["cand_label_name"] == "舔" and item["cand_reason"] == "grooming"
    assert item["ai_label_id"] is None
