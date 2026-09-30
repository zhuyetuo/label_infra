"""标注员工作量：每一条提交的时间、用时、片段数，给审核页和「标注统计」页用。

一条 = 一个任务的一轮提交（annotation_records 里 submitted_at 不为空的行）。
  提交时间  record.submitted_at
  开始时间  record.created_at —— 这一轮第一次保存草稿的时刻。认领和开始动手之间
            可能隔很久（认领了一批放着），所以不用认领时间
  用时      提交 - 开始。跨了饭点/下班的会虚高，前端按单条封顶
  片段数    这一轮的标注条目数
按 record 而不是按任务算，是因为驳回重标会有第二轮，两轮都是工作量。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User


async def record_briefs(db: AsyncSession, tasks) -> dict[int, dict]:
    """{task_id: {submitted_at, started_at, work_seconds, item_count}}，取每个任务当前轮的记录。"""
    if not tasks:
        return {}
    pairs = {(t.id, t.round_no) for t in tasks}
    task_ids = [t.id for t in tasks]
    recs = (await db.execute(
        select(AnnotationRecord).where(AnnotationRecord.task_id.in_(task_ids)))).scalars().all()
    recs = [r for r in recs if (r.task_id, r.round_no) in pairs]
    if not recs:
        return {}
    counts = dict((await db.execute(
        select(AnnotationLabelItem.annotation_record_id, func.count(AnnotationLabelItem.id))
        .where(AnnotationLabelItem.annotation_record_id.in_([r.id for r in recs]))
        .group_by(AnnotationLabelItem.annotation_record_id))).all())
    out = {}
    for r in recs:
        out[r.task_id] = {
            "submitted_at": r.submitted_at,
            "started_at": r.created_at,
            "work_seconds": _work_seconds(r.created_at, r.submitted_at),
            "item_count": int(counts.get(r.id, 0)),
        }
    return out


def _work_seconds(started: datetime | None, submitted: datetime | None) -> int | None:
    if started is None or submitted is None:
        return None
    s = (submitted - started).total_seconds()
    return int(s) if s >= 0 else None


async def annotator_work(db: AsyncSession, date_from: date, date_to: date,
                         user_id: int | None = None) -> list[dict]:
    """[date_from, date_to] 内提交的每一条。"""
    lo = datetime.combine(date_from, datetime.min.time())
    hi = datetime.combine(date_to + timedelta(days=1), datetime.min.time())
    q = (
        select(AnnotationRecord, Task, User.id, User.display_name, User.username,
               Project.id, Project.name, Sample.sample_code, Sample.video_duration_sec)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .join(Project, Project.id == Task.project_id)
        .join(Sample, Sample.id == Task.sample_id)
        .outerjoin(User, User.id == Task.assigned_to)
        .where(AnnotationRecord.submitted_at.is_not(None),
               AnnotationRecord.submitted_at >= lo, AnnotationRecord.submitted_at < hi)
        .order_by(AnnotationRecord.submitted_at.asc())
    )
    if user_id is not None:
        q = q.where(Task.assigned_to == user_id)
    rows = (await db.execute(q)).all()
    if not rows:
        return []
    rec_ids = [r[0].id for r in rows]
    counts: dict[int, int] = {}
    for i in range(0, len(rec_ids), 1000):
        counts.update(dict((await db.execute(
            select(AnnotationLabelItem.annotation_record_id, func.count(AnnotationLabelItem.id))
            .where(AnnotationLabelItem.annotation_record_id.in_(rec_ids[i:i + 1000]))
            .group_by(AnnotationLabelItem.annotation_record_id))).all()))
    out = []
    for rec, task, uid, dn, un, pid, pname, code, dur in rows:
        out.append({
            "task_id": task.id, "round_no": rec.round_no, "status": task.status.value,
            "user_id": uid, "user_name": (dn or un) if uid is not None else None,
            "project_id": pid, "project_name": pname,
            "sample_code": code, "video_duration_sec": dur,
            "submitted_at": rec.submitted_at.isoformat() if rec.submitted_at else None,
            "started_at": rec.created_at.isoformat() if rec.created_at else None,
            "work_seconds": _work_seconds(rec.created_at, rec.submitted_at),
            "item_count": int(counts.get(rec.id, 0)),
        })
    return out
