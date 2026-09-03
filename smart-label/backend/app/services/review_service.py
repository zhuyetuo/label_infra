import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.review import ReviewDecision, ReviewRecord
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole


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


async def release_review(db: AsyncSession, task_id: int, reviewer: User) -> Task:
    """审核员主动放弃认领：任务还是 SUBMITTED，退回待审核队列给别人接手。"""
    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.reviewer_id == reviewer.id, Task.status == TaskStatus.SUBMITTED)
        .values(reviewer_id=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise ReviewConflictError("任务不在你名下或已不是待审核状态，无法放弃")
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

    权限：管理员/超级管理员/审核员随时能退，另外——如果这条正是自己被驳回的，
    标注员本人也能自己点，不用等审核员或管理员回头操作（人少的时候经常是
    自己一路标到审，被自己驳回了还得等自己去后台点一下，纯属多余）。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise ReviewConflictError("任务不存在")
    if task.status not in (TaskStatus.APPROVED, TaskStatus.REJECTED):
        raise ReviewConflictError("只有已通过/已驳回的任务才能退回重标")
    is_privileged = operator.role in (UserRole.admin, UserRole.super_admin, UserRole.reviewer)
    is_own_rejected = task.status == TaskStatus.REJECTED and task.assigned_to == operator.id
    if not is_privileged and not is_own_rejected:
        raise ReviewConflictError("没有权限退回这个任务")

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
        # 驳回先停在 REJECTED 这个状态上（不是马上转回待分配）：之前的写法是驳回
        # 立刻 round+1 打回待分配，任务在列表里一晃就变回"待认领"，标注员根本
        # 看不出这条被驳回过、也看不到审核意见。assigned_to/reviewer_id 都不清，
        # 原来的标注员和审核员是谁一目了然，"只看指派给我的"筛选也还能看到它。
        # 真正的 round+1/清空指派要等标注员自己点"退回重标"开始改的时候才发生
        # （见 reopen_task），审核意见就留在这一轮的 review_records 里。
        task.status = TaskStatus.REJECTED
        task.locked_by = None
        task.lock_expires_at = None

    await db.commit()
    await db.refresh(task)
    return task
