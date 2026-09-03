from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User
from app.schemas.task import LabelItemIn
from app.services.annotation_validation import find_first_overlap


class TaskConflictError(Exception):
    """认领/续期/保存 因状态不符或不是当前持有人而失败。"""


async def claim_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """
    原子认领：单条 UPDATE...WHERE 利用 InnoDB 行锁防止两人抢同一任务，
    不需要显式 SELECT...FOR UPDATE。
    - 开放任务池（assigned_to 为空）：谁先认领算谁的
    - 预指派（assigned_to 已指定）：只有被指定的人能认领
    """
    ttl_hours = settings.annotation_timeout_hours
    lock_expires = datetime.now(UTC) + timedelta(hours=ttl_hours)

    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.status == TaskStatus.PENDING_ASSIGN,
            (Task.assigned_to.is_(None)) | (Task.assigned_to == user.id),
        )
        .values(
            status=TaskStatus.IN_PROGRESS,
            assigned_to=user.id,
            locked_by=user.id,
            lock_expires_at=lock_expires,
        )
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务已被认领或不存在，请刷新列表")

    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def release_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """
    标注员主动放弃任务：不管标了没标、标了多少，草稿都留着不动（草稿按
    task_id+round_no 存，跟谁认领的没关系），只是把任务退回公共池，
    换个人认领之后打开工作台会看到上一个人留下的草稿，接着标即可。

    跟"退回重标"（reopen）不是一回事：那个是审核驳回专用，会开新一轮；
    这个是标注中途自己放弃，轮次不变。
    """
    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.locked_by == user.id, Task.status == TaskStatus.IN_PROGRESS)
        .values(status=TaskStatus.PENDING_ASSIGN, assigned_to=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务不在你名下或已不在进行中，无法放弃")

    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def heartbeat(db: AsyncSession, task_id: int, user: User) -> None:
    """只有当前锁定人能续期，推迟 lock_expires_at。"""
    ttl_hours = settings.annotation_timeout_hours
    lock_expires = datetime.now(UTC) + timedelta(hours=ttl_hours)

    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.locked_by == user.id, Task.status == TaskStatus.IN_PROGRESS)
        .values(lock_expires_at=lock_expires)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务不在你名下或已不在进行中，心跳失败")
    await db.commit()


async def _get_or_create_record(db: AsyncSession, task: Task) -> AnnotationRecord:
    result = await db.execute(
        select(AnnotationRecord).where(
            AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        source_type = (
            RecordSourceType.ai_revised if task.task_type == TaskType.ai_assisted else RecordSourceType.human_only
        )
        record = AnnotationRecord(task_id=task.id, round_no=task.round_no, source_type=source_type)
        db.add(record)
        await db.flush()
    return record


async def save_draft(db: AsyncSession, task_id: int, user: User, items: list[LabelItemIn]) -> AnnotationRecord:
    """
    保存草稿：UPSERT annotation_records(task_id, round_no)，逐条 replace-in-place
    label items。草稿阶段允许时间重叠（画到一半的中间态），提交时才强制校验。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise TaskConflictError("任务不存在")
    if task.locked_by != user.id or task.status != TaskStatus.IN_PROGRESS:
        raise TaskConflictError("任务不在你名下或已不在进行中，无法保存")

    record = await _get_or_create_record(db, task)

    existing_result = await db.execute(
        select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)
    )
    existing_by_id = {item.id: item for item in existing_result.scalars().all()}

    keep_ids: set[int] = set()
    for incoming in items:
        origin = existing_by_id.get(incoming.origin_item_id) if incoming.origin_item_id else None
        if origin is not None:
            keep_ids.add(origin.id)
            changed = (
                origin.label_id != incoming.label_id
                or origin.start_time_ms != incoming.start_time_ms
                or origin.end_time_ms != incoming.end_time_ms
            )
            origin.label_id = incoming.label_id
            origin.start_time_ms = incoming.start_time_ms
            origin.end_time_ms = incoming.end_time_ms
            if changed:
                origin.is_modified = True
                origin.created_by = user.id
        else:
            new_item = AnnotationLabelItem(
                annotation_record_id=record.id,
                label_id=incoming.label_id,
                start_time_ms=incoming.start_time_ms,
                end_time_ms=incoming.end_time_ms,
                source_type=LabelItemSource.human_added,
                is_modified=False,
                created_by=user.id,
            )
            db.add(new_item)
            await db.flush()
            keep_ids.add(new_item.id)

    for item_id, item in existing_by_id.items():
        if item_id not in keep_ids:
            await db.delete(item)

    await db.commit()
    await db.refresh(record)
    return record


async def submit_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """提交：强制校验标签不重叠（决策③），通过后状态流转到 SUBMITTED。"""
    task = await db.get(Task, task_id)
    if task is None:
        raise TaskConflictError("任务不存在")
    if task.locked_by != user.id or task.status != TaskStatus.IN_PROGRESS:
        raise TaskConflictError("任务不在你名下或已不在进行中，无法提交")

    record = await _get_or_create_record(db, task)
    items_result = await db.execute(
        select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)
    )
    items = items_result.scalars().all()
    as_schema = [
        LabelItemIn(label_id=i.label_id, start_time_ms=i.start_time_ms, end_time_ms=i.end_time_ms) for i in items
    ]
    overlap = find_first_overlap(as_schema)
    if overlap is not None:
        raise TaskConflictError(
            f"存在时间重叠的标签（{overlap[0].start_time_ms}-{overlap[0].end_time_ms}ms 与 "
            f"{overlap[1].start_time_ms}-{overlap[1].end_time_ms}ms），请修正后再提交"
        )

    record.submitted_at = datetime.now(UTC)
    task.status = TaskStatus.SUBMITTED
    task.locked_by = None
    task.lock_expires_at = None
    await db.commit()
    await db.refresh(task)
    return task
