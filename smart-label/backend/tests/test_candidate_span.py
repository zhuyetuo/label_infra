"""疑似片段在波形上调起止：改了就记一笔；确认成片段时调整记录跟过去。"""

from __future__ import annotations

from sqlalchemy import select

from app.api.v1 import candidates as api
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem
from app.models.task import TaskStatus
from tests.test_dup_segments import _world


def test_调起止记录_确认时带到片段(db, run):
    u, _p, lab, t = _world(db, run)
    t.status = TaskStatus.IN_PROGRESS
    c = AiCandidate(task_id=t.id, round_no=t.round_no or 1, label_name=lab.display_name,
                    start_time_ms=1000, end_time_ms=4000, reason="grooming", status=CandidateStatus.pending)
    db.add(c)
    run(db.commit())

    out = run(api.set_span(c.id, api.SpanIn(start_time_ms=1500, end_time_ms=4000), db, u))["data"]
    assert (out["start_time_ms"], out["end_time_ms"]) == (1500, 4000)
    assert [(e["from"], e["to"]) for e in out["boundary_edits"]] == [([1000, 4000], [1500, 4000])]

    run(api.decide(c.id, api.DecideIn(decision="confirmed", label_id=lab.id), db, u))
    it = run(db.execute(select(AnnotationLabelItem))).scalars().one()
    assert (it.start_time_ms, it.end_time_ms) == (1500, 4000) and "1500" in (it.boundary_edits or "")
