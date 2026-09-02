import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.review import ReviewDecision, ReviewRecord
from app.models.task import Task, TaskStatus
from app.models.user import User


class ReviewConflictError(Exception):
    pass


async def claim_review(db: AsyncSession, task_id: int, reviewer: User) -> Task:
    """原子认领待审核任务，语义同 task_service.claim_task。"""
    lock_expires = datetime.now(UTC) + timedelta(hours=settings.review_timeout_hours)
    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.status == TaskStatus.SUBMITTED,
            (Task.reviewer_id.is_(None)) | (Task.reviewer_id == reviewer.id),
        )
        .values(reviewer_id=reviewer.id, locked_by=reviewer.id, lock_expires_at=lock_expires)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise ReviewConflictError("任务已被其他审核员认领或不处于待审核状态")
    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def _clone_record_forward(db: AsyncSession, task: Task, new_round_no: int) -> None:
    """驳回重标：把当前轮次的标注内容拷贝到新一轮，标注员重新认领后能接着改，不用从空白开始（决策⑧）。"""
    old_record = (
        await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no
            )
        )
    ).scalar_one_or_none()
    if old_record is None:
        return

    new_record = AnnotationRecord(task_id=task.id, round_no=new_round_no, source_type=old_record.source_type)
    db.add(new_record)
    await db.flush()

    old_items = (
        (await db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == old_record.id)))
        .scalars()
        .all()
    )
    for item in old_items:
        db.add(
            AnnotationLabelItem(
                annotation_record_id=new_record.id,
                label_id=item.label_id,
                start_time_ms=item.start_time_ms,
                end_time_ms=item.end_time_ms,
                source_type=item.source_type,
                is_modified=item.is_modified,
                ai_confidence=item.ai_confidence,
                created_by=item.created_by,
            )
        )


async def reopen_task(db: AsyncSession, task_id: int, operator: User, comment: str | None) -> Task:
    """
    把已通过（或已驳回待重标）的任务退回重标：当时审通过了，后来复查发现问题，
    需要能打回去重新标，而不是只能删掉重建（那样会丢掉历史轮次）。

    处理方式跟驳回一致：轮次+1、把上一轮内容拷到新一轮、回到待分配。
    不写 review_records —— (task_id, round_no) 上有唯一约束，那一轮的审核结论
    确实就是"通过"，历史不该被改写；退回这个动作记到 audit_logs 里。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise ReviewConflictError("任务不存在")
    if task.status not in (TaskStatus.APPROVED, TaskStatus.REJECTED):
        raise ReviewConflictError("只有已通过/已驳回的任务才能退回重标")

    new_round_no = task.round_no + 1
    await _clone_record_forward(db, task, new_round_no)
    task.round_no = new_round_no
    task.status = TaskStatus.PENDING_ASSIGN
    task.assigned_to = None
    task.reviewer_id = None
    task.locked_by = None
    task.lock_expires_at = None

    db.add(
        AuditLog(
            user_id=operator.id,
            action="task.reopen",
            target_type="task",
            target_id=task.id,
            detail=json.dumps({"new_round_no": new_round_no, "comment": comment}, ensure_ascii=False),
        )
    )

    await db.commit()
    await db.refresh(task)
    return task


async def decide_review(
    db: AsyncSession, task_id: int, reviewer: User, decision: ReviewDecision, comment: str | None
) -> Task:
    task = await db.get(Task, task_id)
    if task is None:
        raise ReviewConflictError("任务不存在")
    if task.locked_by != reviewer.id or task.status != TaskStatus.SUBMITTED:
        raise ReviewConflictError("任务不在你名下或已不在待审核状态")

    db.add(
        ReviewRecord(
            task_id=task.id,
            round_no=task.round_no,
            reviewer_id=reviewer.id,
            decision=decision,
            comment=comment,
        )
    )

    if decision == ReviewDecision.approved:
        task.status = TaskStatus.APPROVED
        task.locked_by = None
        task.lock_expires_at = None
    else:
        new_round_no = task.round_no + 1
        await _clone_record_forward(db, task, new_round_no)
        task.round_no = new_round_no
        task.status = TaskStatus.PENDING_ASSIGN
        task.assigned_to = None  # 驳回后回到待分配，由管理员/标注员重新认领（决策⑧：草稿已保留，不会白标）
        task.reviewer_id = None
        task.locked_by = None
        task.lock_expires_at = None

    await db.commit()
    await db.refresh(task)
    return task
