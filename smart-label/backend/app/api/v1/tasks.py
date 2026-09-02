"""
任务认领/心跳/草稿/提交。三角色共用，统一走 apply_task_scope() 过滤，
不允许在这里各自写 WHERE 条件。业务逻辑在 services/task_service.py，
这里只做参数校验+调用+异常转换。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.task import DraftOut, DraftSaveRequest, LabelItemOut, TaskCreate, TaskOut
from app.services.task_scope import apply_task_scope
from app.services.task_service import TaskConflictError, claim_task, heartbeat, save_draft, submit_task

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("", dependencies=[Depends(require_role(UserRole.admin))])
async def create_task(body: TaskCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)):
    sample = await db.get(Sample, body.sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    task = Task(
        sample_id=body.sample_id,
        task_type=body.task_type,
        segment_start_ms=body.segment_start_ms,
        segment_end_ms=body.segment_end_ms,
        assigned_to=body.assigned_to,
        created_by=admin.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return ok(TaskOut.model_validate(task).model_dump())


@router.get("")
async def list_tasks(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_task_scope(select(Task), user).order_by(Task.created_at.desc())
    result = await db.execute(query)
    tasks = result.scalars().all()
    return ok([TaskOut.model_validate(t).model_dump() for t in tasks])


@router.get("/{task_id}")
async def get_task(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_task_scope(select(Task).where(Task.id == task_id), user)
    result = await db.execute(query)
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/{task_id}/claim")
async def claim(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await claim_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.patch("/{task_id}/heartbeat")
async def send_heartbeat(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        await heartbeat(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(msg="心跳成功")


@router.get("/{task_id}/draft")
async def get_draft(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_task_scope(select(Task).where(Task.id == task_id), user)
    task = (await db.execute(query)).scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")

    record = (
        await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task_id, AnnotationRecord.round_no == task.round_no
            )
        )
    ).scalar_one_or_none()
    if record is None:
        return ok(DraftOut(round_no=task.round_no, items=[]).model_dump())

    items = (
        (await db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)))
        .scalars()
        .all()
    )
    return ok(
        DraftOut(
            round_no=task.round_no,
            items=[LabelItemOut.model_validate(i).model_dump() for i in items],
        ).model_dump()
    )


@router.put("/{task_id}/draft")
async def put_draft(
    task_id: int,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        await save_draft(db, task_id, user, body.items)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(msg="草稿已保存")


@router.post("/{task_id}/submit")
async def submit(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await submit_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())
