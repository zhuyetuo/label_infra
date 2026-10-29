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
        # 记下原来是谁的：项目页「有未指派」要能说清这几个是怎么来的。
        # **必须排在清空 assigned_to 前面**：MySQL 的 UPDATE 从左到右赋值，后面的
        # 赋值读到的是前面已经改过的值，顺序反了记下来的就是 NULL
        .ordered_values(
            (Task.reclaimed_from, Task.assigned_to),
            (Task.reclaimed_at, now.replace(tzinfo=None)),
            (Task.status, TaskStatus.PENDING_ASSIGN),
            (Task.assigned_to, None),
            (Task.locked_by, None),
            (Task.lock_expires_at, None),
        )
        # 不在 Python 里同步会话里已加载的对象：那一步拿带时区的 now 跟库里不带时区的
        # lock_expires_at 比会直接 TypeError。批量 UPDATE 本来就不靠它
        .execution_options(synchronize_session=False)
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
