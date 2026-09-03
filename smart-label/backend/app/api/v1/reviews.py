"""审核认领/通过/驳回。业务逻辑在 services/review_service.py。"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.review import ReviewDecisionRequest
from app.schemas.task import TaskOut
from app.services.review_service import ReviewConflictError, claim_review, decide_review, release_review

router = APIRouter(
    prefix="/reviews", tags=["reviews"], dependencies=[Depends(require_role(UserRole.reviewer, UserRole.admin, UserRole.super_admin))]
)


@router.get("/queue")
async def review_queue(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """待审核队列：状态=SUBMITTED，且未被其他审核员占用。"""
    query = select(Task).where(
        Task.status == TaskStatus.SUBMITTED,
        (Task.reviewer_id.is_(None)) | (Task.reviewer_id == user.id),
    ).order_by(Task.updated_at.asc())
    tasks = (await db.execute(query)).scalars().all()
    return ok([TaskOut.model_validate(t).model_dump() for t in tasks])


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
