"""标注员工作量：每一条提交的时间、用时、片段数，给审核页和「标注统计」页用。

一条 = 一个任务的一轮提交（annotation_records 里 submitted_at 不为空的行）。
  提交时间  record.submitted_at
  开始时间  这一轮**人第一次动手**的时刻：人加/改的第一条片段、或第一次判定候选，
            取最早的那个。不能用 record.created_at——AI 预标注一跑就把记录建了，
            那是机器动手的时刻，离人认领可能隔一天（2026-09-30 审核页上「用时 686 分」
            就是这么来的）
  用时      提交 - 开始。跨了饭点/下班的会虚高，前端按单条封顶
  片段数    这一轮的标注条目数
按 record 而不是按任务算，是因为驳回重标会有第二轮，两轮都是工作量。

**时区**：submitted_at / decided_at 写库时用的是 datetime.now(UTC)（存进去是 UTC 的
钟面），而 created_at 那些列是 MySQL 的 func.now()（容器时区，Asia/Shanghai）。两套
混在一张表里，直接相减差 8 小时、直接显示是凌晨 4 点交的活。这里统一换成本地时间
再往外给：UTC 的那几列 + 本机时区偏移。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.models.user import User

SCRATCH_PREFIX = "抓挠"


def local_offset() -> timedelta:
    return datetime.now().astimezone().utcoffset() or timedelta(0)


def utc_to_local(dt: datetime | None) -> datetime | None:
    """写库时用 datetime.now(UTC) 的列：读出来是 UTC 钟面（可能带 tz 也可能不带），换成本地 naive。"""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone().replace(tzinfo=None)
    return dt + local_offset()


def _work_seconds(started: datetime | None, submitted: datetime | None) -> int | None:
    if started is None or submitted is None:
        return None
    s = (submitted - started).total_seconds()
    return int(s) if s >= 0 else None


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


async def _first_touch(db: AsyncSession, recs: list[AnnotationRecord]) -> dict[int, datetime]:
    """{record_id: 人第一次动手的本地时间}。人加/改的片段（created_by 不空）和判定候选，取最早。"""
    if not recs:
        return {}
    rec_ids = [r.id for r in recs]
    first: dict[int, datetime] = {}
    for i in range(0, len(rec_ids), 1000):
        rows = (await db.execute(
            select(AnnotationLabelItem.annotation_record_id, func.min(AnnotationLabelItem.created_at))
            .where(AnnotationLabelItem.annotation_record_id.in_(rec_ids[i:i + 1000]),
                   AnnotationLabelItem.created_by.is_not(None))
            .group_by(AnnotationLabelItem.annotation_record_id))).all()
        for rid, t in rows:
            if t is not None:
                first[rid] = t
    # 候选判定：按 (task, round) 对回 record
    by_task_round = {(r.task_id, r.round_no): r.id for r in recs}
    task_ids = list({r.task_id for r in recs})
    for i in range(0, len(task_ids), 1000):
        rows = (await db.execute(
            select(AiCandidate.task_id, AiCandidate.round_no, func.min(AiCandidate.decided_at))
            .where(AiCandidate.task_id.in_(task_ids[i:i + 1000]), AiCandidate.decided_at.is_not(None))
            .group_by(AiCandidate.task_id, AiCandidate.round_no))).all()
        for tid, rn, t in rows:
            rid = by_task_round.get((tid, rn))
            if rid is None or t is None:
                continue
            t = utc_to_local(t)
            if rid not in first or t < first[rid]:
                first[rid] = t
    return first


async def _scratch_counts(db: AsyncSession, recs: list[AnnotationRecord]) -> dict[int, dict]:
    """{record_id: {item_count, scratch_items, scratch_pending}}：这一轮几段、其中抓挠几段、抓挠里 AI 给的还没人确认的几段。"""
    if not recs:
        return {}
    rec_ids = [r.id for r in recs]
    is_scratch = LabelDefinition.display_name.like(f"{SCRATCH_PREFIX}%")
    pending = ((AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
               & (AnnotationLabelItem.ai_confirmed.is_(False))
               & (AnnotationLabelItem.is_modified.is_(False))
               & (AnnotationLabelItem.uncertain.is_(False)))
    out: dict[int, dict] = {}
    for i in range(0, len(rec_ids), 1000):
        rows = (await db.execute(
            select(AnnotationLabelItem.annotation_record_id,
                   func.count(AnnotationLabelItem.id),
                   func.sum(case((is_scratch, 1), else_=0)),
                   func.sum(case((is_scratch & pending, 1), else_=0)))
            .join(LabelDefinition, LabelDefinition.id == AnnotationLabelItem.label_id)
            .where(AnnotationLabelItem.annotation_record_id.in_(rec_ids[i:i + 1000]))
            .group_by(AnnotationLabelItem.annotation_record_id))).all()
        for rid, n, ns, npend in rows:
            out[rid] = {"item_count": int(n), "scratch_items": int(ns or 0), "scratch_pending": int(npend or 0)}
    return out


async def _cand_counts(db: AsyncSession, tasks) -> dict[int, dict]:
    """{task_id: {cand_total, cand_pending}} 当前轮的候选。"""
    if not tasks:
        return {}
    pairs = {(t.id, t.round_no) for t in tasks}
    task_ids = [t.id for t in tasks]
    out: dict[int, dict] = {}
    for i in range(0, len(task_ids), 1000):
        rows = (await db.execute(
            select(AiCandidate.task_id, AiCandidate.round_no, func.count(AiCandidate.id),
                   func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)))
            .where(AiCandidate.task_id.in_(task_ids[i:i + 1000]))
            .group_by(AiCandidate.task_id, AiCandidate.round_no))).all()
        for tid, rn, n, npend in rows:
            if (tid, rn) in pairs:
                out[tid] = {"cand_total": int(n), "cand_pending": int(npend or 0)}
    return out


_NO_ITEMS = {"item_count": 0, "scratch_items": 0, "scratch_pending": 0}
_NO_CANDS = {"cand_total": 0, "cand_pending": 0}


async def record_briefs(db: AsyncSession, tasks) -> dict[int, dict]:
    """审核队列用：{task_id: {submitted_at, started_at, work_seconds, item_count,
    scratch_items, scratch_pending, cand_total, cand_pending}}，取每个任务当前轮。"""
    tasks = list(tasks)
    if not tasks:
        return {}
    pairs = {(t.id, t.round_no) for t in tasks}
    recs = [r for r in (await db.execute(
        select(AnnotationRecord).where(AnnotationRecord.task_id.in_([t.id for t in tasks])))).scalars().all()
            if (r.task_id, r.round_no) in pairs]
    first = await _first_touch(db, recs)
    counts = await _scratch_counts(db, recs)
    cands = await _cand_counts(db, tasks)
    out: dict[int, dict] = {t.id: dict(cands.get(t.id, _NO_CANDS)) for t in tasks}
    for r in recs:
        submitted = utc_to_local(r.submitted_at)
        started = first.get(r.id)
        out[r.task_id].update({
            "submitted_at": submitted, "started_at": started,
            "work_seconds": _work_seconds(started, submitted),
            **counts.get(r.id, _NO_ITEMS),
        })
    return out


async def annotator_work(db: AsyncSession, date_from: date, date_to: date,
                         user_id: int | None = None) -> dict:
    """[date_from, date_to]（本地日期）内的提交明细 + 候选判定明细。"""
    off = local_offset()
    lo = datetime.combine(date_from, datetime.min.time()) - off          # 换回 UTC 钟面去查
    hi = datetime.combine(date_to + timedelta(days=1), datetime.min.time()) - off
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
    recs = [r[0] for r in rows]
    tasks_by_id = {r[1].id: r[1] for r in rows}
    first = await _first_touch(db, recs)
    counts = await _scratch_counts(db, recs)
    cands = await _cand_counts(db, list(tasks_by_id.values()))
    submissions = []
    for rec, task, uid, dn, un, pid, pname, code, dur in rows:
        submitted = utc_to_local(rec.submitted_at)
        started = first.get(rec.id)
        submissions.append({
            "task_id": task.id, "round_no": rec.round_no, "status": task.status.value,
            "user_id": uid, "user_name": (dn or un) if uid is not None else None,
            "project_id": pid, "project_name": pname,
            "sample_code": code, "video_duration_sec": dur,
            "submitted_at": _iso(submitted), "started_at": _iso(started),
            "work_seconds": _work_seconds(started, submitted),
            **counts.get(rec.id, _NO_ITEMS),
            **cands.get(task.id, _NO_CANDS),
        })

    # 候选判定：每判一条算一次动作，跟提交任务分开数——一天判 200 条候选和交 5 个任务
    # 是两种工作量，混在一起谁都看不清
    cq = (
        select(AiCandidate.decided_at, AiCandidate.status, AiCandidate.label_name, AiCandidate.task_id,
               User.id, User.display_name, User.username, Project.id, Project.name)
        .join(Task, Task.id == AiCandidate.task_id)
        .join(Project, Project.id == Task.project_id)
        .outerjoin(User, User.id == AiCandidate.decided_by)
        .where(AiCandidate.decided_at.is_not(None), AiCandidate.decided_at >= lo, AiCandidate.decided_at < hi)
        .order_by(AiCandidate.decided_at.asc())
    )
    if user_id is not None:
        cq = cq.where(AiCandidate.decided_by == user_id)
    decisions = [{
        "decided_at": _iso(utc_to_local(d)), "status": st.value if hasattr(st, "value") else str(st),
        "label_name": ln, "task_id": tid,
        "user_id": uid, "user_name": (dn or un) if uid is not None else None,
        "project_id": pid, "project_name": pname,
    } for d, st, ln, tid, uid, dn, un, pid, pname in (await db.execute(cq)).all()]
    return {"submissions": submissions, "candidate_decisions": decisions}


async def project_progress(db: AsyncSession, only_active: bool = True) -> list[dict]:
    """每个项目：任务交了几个、抓挠片段确认了几段、疑似候选判了几条。
    给「每天必须把抓挠片段和疑似抓挠看完」这个要求一个能看的完成度。"""
    pq = select(Project)
    if only_active:
        pq = pq.where(Project.is_active.is_(True))
    projects = (await db.execute(pq.order_by(Project.name.desc()))).scalars().all()
    if not projects:
        return []
    pids = [p.id for p in projects]
    done_states = (TaskStatus.SUBMITTED, TaskStatus.APPROVED)
    task_rows = (await db.execute(
        select(Task.project_id, func.count(Task.id),
               func.sum(case((Task.status.in_(done_states), 1), else_=0)),
               func.sum(case((Task.status == TaskStatus.APPROVED, 1), else_=0)))
        .where(Task.project_id.in_(pids)).group_by(Task.project_id))).all()
    tasks = {pid: (int(n), int(d or 0), int(a or 0)) for pid, n, d, a in task_rows}

    is_scratch = LabelDefinition.display_name.like(f"{SCRATCH_PREFIX}%")
    pending = ((AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
               & (AnnotationLabelItem.ai_confirmed.is_(False))
               & (AnnotationLabelItem.is_modified.is_(False))
               & (AnnotationLabelItem.uncertain.is_(False)))
    item_rows = (await db.execute(
        select(Task.project_id,
               func.sum(case((is_scratch, 1), else_=0)),
               func.sum(case((is_scratch & pending, 1), else_=0)))
        .select_from(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .join(LabelDefinition, LabelDefinition.id == AnnotationLabelItem.label_id)
        .where(Task.project_id.in_(pids), AnnotationRecord.round_no == Task.round_no)
        .group_by(Task.project_id))).all()
    scratch = {pid: (int(n or 0), int(p or 0)) for pid, n, p in item_rows}

    cand_rows = (await db.execute(
        select(Task.project_id, func.count(AiCandidate.id),
               func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)))
        .select_from(AiCandidate).join(Task, Task.id == AiCandidate.task_id)
        .where(Task.project_id.in_(pids), AiCandidate.round_no == Task.round_no)
        .group_by(Task.project_id))).all()
    cands = {pid: (int(n), int(p or 0)) for pid, n, p in cand_rows}

    out = []
    for p in projects:
        n, done, approved = tasks.get(p.id, (0, 0, 0))
        if n == 0:
            continue
        s_total, s_pending = scratch.get(p.id, (0, 0))
        c_total, c_pending = cands.get(p.id, (0, 0))
        out.append({
            "project_id": p.id, "project_name": p.name,
            "tasks_total": n, "tasks_submitted": done, "tasks_approved": approved,
            "scratch_total": s_total, "scratch_pending": s_pending,
            "cand_total": c_total, "cand_pending": c_pending,
        })
    return out
