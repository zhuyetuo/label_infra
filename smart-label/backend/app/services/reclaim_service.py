from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus


async def reclaim_expired_tasks(db: AsyncSession) -> int:
    """
    标注超时回收：IN_PROGRESS 且 lock_expires_at 已过期 -> 打回 PENDING_ASSIGN，
    清空 assigned_to（决策⑧：annotation_records 草稿不删，round_no 不变，重新认领直接接着标）。
    """
    now = datetime.now(UTC)
    stmt = (
        update(Task)
        .where(Task.status == TaskStatus.IN_PROGRESS, Task.lock_expires_at < now)
        .values(status=TaskStatus.PENDING_ASSIGN, assigned_to=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount


async def reclaim_expired_reviews(db: AsyncSession) -> int:
    """审核超时回收：SUBMITTED 状态不变，只是把审核占用释放回队列，reviewer_id/locked_by清空。"""
    now = datetime.now(UTC)
    stmt = (
        update(Task)
        .where(
            Task.status == TaskStatus.SUBMITTED,
            Task.lock_expires_at.is_not(None),
            Task.lock_expires_at < now,
        )
        .values(reviewer_id=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount
