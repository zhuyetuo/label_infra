"""
任务认领/心跳/草稿/提交。三角色共用，统一走 apply_task_scope() 过滤，
不允许在这里各自写 WHERE 条件。业务逻辑在 services/task_service.py，
这里只做参数校验+调用+异常转换。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.task import DraftOut, DraftSaveRequest, LabelItemOut, ReopenRequest, TaskCreate, TaskOut
from app.services.review_service import ReviewConflictError, reopen_task
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


@router.post("/{task_id}/reopen", dependencies=[Depends(require_role(UserRole.admin, UserRole.reviewer))])
async def reopen(
    task_id: int,
    body: ReopenRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """把已通过/已驳回的任务退回重标（轮次+1，上一轮内容原样带过去）。"""
    try:
        task = await reopen_task(db, task_id, user, body.comment)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.delete("/{task_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    """
    管理员删除任务。任务下面挂着标注记录/标签条目/审核记录，外键都指向 tasks，
    所以要按 标签条目 -> 标注记录 -> 审核记录 -> 任务 的顺序清掉，不能直接删任务。
    被它当作父任务的子任务不跟着删，只把 parent_task_id 置空，避免误伤已拆分的短任务。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")

    record_ids = (
        (await db.execute(select(AnnotationRecord.id).where(AnnotationRecord.task_id == task_id))).scalars().all()
    )
    if record_ids:
        await db.execute(
            delete(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id.in_(record_ids))
        )
    await db.execute(delete(AnnotationRecord).where(AnnotationRecord.task_id == task_id))
    await db.execute(delete(ReviewRecord).where(ReviewRecord.task_id == task_id))
    await db.execute(update(Task).where(Task.parent_task_id == task_id).values(parent_task_id=None))
    await db.execute(delete(Task).where(Task.id == task_id))
    await db.commit()
    return ok(msg="任务已删除")


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
