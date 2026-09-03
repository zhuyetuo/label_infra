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
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.task import (
    BulkTaskCreate,
    BulkTaskCreateResult,
    DraftOut,
    DraftSaveRequest,
    LabelItemOut,
    ReopenRequest,
    TaskCreate,
    TaskOut,
)
from app.services.review_service import ReviewConflictError, reopen_task
from app.services.task_scope import apply_task_scope
from app.services.task_service import TaskConflictError, claim_task, heartbeat, release_task, save_draft, submit_task

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def create_task(body: TaskCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)):
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    sample = await db.get(Sample, body.sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    task = Task(
        project_id=body.project_id,
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


@router.post("/bulk", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def bulk_create_tasks(
    body: BulkTaskCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    """
    批量建任务：样本页是按日期分组的，一天几十个样本很常见，一个个点「新建任务」
    太麻烦，这里一次性把整批样本各建一个长任务（覆盖整个样本，不切片段）。

    已经在这个项目下建过任务的样本会跳过，不重复建（比如同一天导入了两次）。
    """
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if not body.sample_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选中任何样本")

    existing_ids = set((await db.execute(select(Sample.id).where(Sample.id.in_(body.sample_ids)))).scalars().all())
    missing = set(body.sample_ids) - existing_ids
    if missing:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"样本不存在: {sorted(missing)}")

    already_has_task = set(
        (
            await db.execute(
                select(Task.sample_id).where(
                    Task.project_id == body.project_id, Task.sample_id.in_(body.sample_ids)
                )
            )
        )
        .scalars()
        .all()
    )

    created = 0
    for sample_id in body.sample_ids:
        if sample_id in already_has_task:
            continue
        db.add(
            Task(
                project_id=body.project_id,
                sample_id=sample_id,
                task_type=body.task_type,
                assigned_to=body.assigned_to,
                created_by=admin.id,
            )
        )
        created += 1
    await db.commit()

    skipped = sorted(already_has_task)
    return ok(
        BulkTaskCreateResult(created=created, skipped=len(skipped), skipped_sample_ids=skipped).model_dump()
    )


@router.post("/{task_id}/reopen")
async def reopen(
    task_id: int,
    body: ReopenRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    把已通过/已驳回的任务退回重标（轮次+1，上一轮内容原样带过去）。
    管理员/审核员随时能退；标注员只能退自己被驳回的那条（reopen_task 里判断），
    所以这里不按角色卡权限，交给 service 按具体任务判断。
    """
    try:
        task = await reopen_task(db, task_id, user, body.comment)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.delete("/{task_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
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
async def list_tasks(
    project_id: int | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    query = apply_task_scope(select(Task), user)
    if project_id is not None:
        query = query.where(Task.project_id == project_id)
    query = query.order_by(Task.created_at.desc())
    result = await db.execute(query)
    tasks = result.scalars().all()

    # 待认领但已经有人标过一部分（比如中途放弃）的任务，前端要标出来提示
    # "有草稿"，不是从零开始
    draft_task_ids: set[int] = set()
    task_ids = [t.id for t in tasks]
    if task_ids:
        rows = await db.execute(
            select(AnnotationRecord.task_id)
            .join(Task, Task.id == AnnotationRecord.task_id)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .where(AnnotationRecord.round_no == Task.round_no, Task.id.in_(task_ids))
            .distinct()
        )
        draft_task_ids = set(rows.scalars().all())

    # 被驳回的任务把审核意见带出来，标注员一看就知道要改什么，不用另外去问审核员
    rejected_ids = [t.id for t in tasks if t.status == TaskStatus.REJECTED]
    review_comments: dict[int, str | None] = {}
    if rejected_ids:
        rows = await db.execute(
            select(ReviewRecord.task_id, ReviewRecord.comment)
            .join(Task, Task.id == ReviewRecord.task_id)
            .where(ReviewRecord.task_id.in_(rejected_ids), ReviewRecord.round_no == Task.round_no)
        )
        review_comments = dict(rows.all())

    return ok(
        [
            {
                **TaskOut.model_validate(t).model_dump(),
                "has_draft": t.id in draft_task_ids,
                "review_comment": review_comments.get(t.id),
            }
            for t in tasks
        ]
    )


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


@router.post("/{task_id}/release")
async def release(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """标注员主动放弃任务，退回公共池；草稿保留，换人接手能接着标。"""
    try:
        task = await release_task(db, task_id, user)
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
