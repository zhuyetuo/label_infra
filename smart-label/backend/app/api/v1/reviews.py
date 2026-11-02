"""审核认领/通过/驳回。业务逻辑在 services/review_service.py。"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.review import ReviewDecisionRequest
from app.schemas.task import TaskOut
from app.services.review_service import (
    ReviewConflictError, approved_summary, bulk_approve, claim_review, decide_review, release_review, unapprove,
)
from app.services.annotator_work_service import record_briefs
from app.services.task_scope import exclude_own_annotation, exclude_sensitive
from app.services.task_service import sample_brief

router = APIRouter(
    prefix="/reviews", tags=["reviews"], dependencies=[Depends(require_role(UserRole.reviewer, UserRole.admin, UserRole.super_admin))]
)


@router.get("/queue")
async def review_queue(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """待审核队列：状态=SUBMITTED，且未被其他审核员占用。审核员自己标的不能自己审。"""
    query = select(Task).where(
        Task.status == TaskStatus.SUBMITTED,
        (Task.reviewer_id.is_(None)) | (Task.reviewer_id == user.id),
    ).order_by(Task.updated_at.asc())
    query = exclude_own_annotation(query, user)
    # 敏感样本上的任务只出现在管理员的审核队列里
    query = exclude_sensitive(query, user)
    tasks = (await db.execute(query)).scalars().all()
    briefs = await sample_brief(db, tasks)
    # 审核的人要知道是谁标的、什么时候交的、花了多久——只给一个 ID 的话得去账号页对
    recs = await record_briefs(db, tasks)
    names: dict[int, str] = {}
    uids = {t.assigned_to for t in tasks if t.assigned_to is not None}
    if uids:
        for uid, dn, un in (await db.execute(
                select(User.id, User.display_name, User.username).where(User.id.in_(uids)))).all():
            names[uid] = dn or un
    # 每个任务各类别几段 / 各类候选几条：审核页按类别筛（只看含「饮水」的任务）要用
    label_counts, cand_labels = await _per_task_kinds(db, [t.id for t in tasks])
    pnames: dict[int, str] = {}
    pids = {t.project_id for t in tasks}
    if pids:
        pnames = dict((await db.execute(select(Project.id, Project.name).where(Project.id.in_(pids)))).all())
    return ok([{**TaskOut.model_validate(t).model_dump(), **briefs.get(t.sample_id, {}),
                **recs.get(t.id, {}),
                "project_name": pnames.get(t.project_id),
                "label_counts": label_counts.get(t.id, {}),
                "cand_labels": cand_labels.get(t.id, {}),
                "assigned_to_name": names.get(t.assigned_to) if t.assigned_to is not None else None}
               for t in tasks])


async def _per_task_kinds(db: AsyncSession, task_ids: list[int]):
    """{task_id: {label_id: {n, ai_pending, max_ms, ms}}}、{task_id: {候选类别名: {n, pending}}}，当前轮。"""
    from sqlalchemy import case, func

    from app.models.ai_candidate import AiCandidate, CandidateStatus
    from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource

    lc: dict[int, dict[int, dict[str, int]]] = {}
    cl: dict[int, dict[str, dict[str, int]]] = {}
    if not task_ids:
        return lc, cl
    pending = ((AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
               & AnnotationLabelItem.ai_confirmed.is_(False) & AnnotationLabelItem.is_modified.is_(False))
    dur = AnnotationLabelItem.end_time_ms - AnnotationLabelItem.start_time_ms
    rows = await db.execute(
        select(AnnotationRecord.task_id, AnnotationLabelItem.label_id, func.count(AnnotationLabelItem.id),
               func.sum(case((pending, 1), else_=0)), func.max(dur), func.sum(dur))
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(task_ids), AnnotationRecord.round_no == Task.round_no)
        .group_by(AnnotationRecord.task_id, AnnotationLabelItem.label_id))
    for tid, lid, n, p, mx, tot in rows.all():
        # max_ms / ms：最长一段、合计时长——审核页按「最长一段」挑长片段（长的往往更干净）
        lc.setdefault(tid, {})[lid] = {"n": int(n), "ai_pending": int(p or 0),
                                       "max_ms": int(mx or 0), "ms": int(tot or 0)}
    rows = await db.execute(
        select(AiCandidate.task_id, AiCandidate.label_name, func.count(AiCandidate.id),
               func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)))
        .join(Task, Task.id == AiCandidate.task_id)
        .where(AiCandidate.task_id.in_(task_ids), AiCandidate.round_no == Task.round_no)
        .group_by(AiCandidate.task_id, AiCandidate.label_name))
    for tid, name, n, p in rows.all():
        cl.setdefault(tid, {})[name] = {"n": int(n), "pending": int(p or 0)}
    return lc, cl


@router.post("/{task_id}/claim")
async def claim(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await claim_review(db, task_id, user)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/{task_id}/release")
async def release(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """审核员主动放弃认领，任务退回待审核队列给别人接手。"""
    try:
        task = await release_review(db, task_id, user)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/{task_id}/decision")
async def decision(
    task_id: int,
    body: ReviewDecisionRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        task = await decide_review(db, task_id, user, body.decision, body.comment)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/bulk-approve", dependencies=[Depends(require_role(UserRole.super_admin))])
async def bulk_approve_api(body: dict | None = None, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    """超级管理员一键通过待审核的任务。body: {"project_id": 项目ID}，不给就是全部项目。"""
    pid = (body or {}).get("project_id")
    try:
        return ok(await bulk_approve(db, user, int(pid) if pid is not None else None))
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc


@router.post("/unapprove", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def unapprove_api(body: dict | None = None, db: AsyncSession = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """已通过的退回待审核，原样（不改轮次、不动片段）。
    body: {"task_ids": [...]} 指定几条；或 {"project_id": N, "only_bulk": true}；都不给 = 全部项目里批量通过的。"""
    b = body or {}
    ids = [int(x) for x in (b.get("task_ids") or [])]
    pid = b.get("project_id")
    try:
        return ok(await unapprove(db, user, ids or None, int(pid) if pid is not None else None,
                                  bool(b.get("only_bulk", True))))
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc


@router.get("/approved-summary", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def approved_summary_api(db: AsyncSession = Depends(get_db)):
    """每个项目已通过几个、其中批量通过的几个。"""
    return ok(await approved_summary(db))
