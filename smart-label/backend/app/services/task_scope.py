"""
数据隔离唯一入口。所有查询 tasks 表的地方都必须经过这里过滤，
不允许在各个路由里各自写 WHERE 条件——避免漏掉隔离导致标注员看到别人的任务。
"""

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole


def apply_task_scope(query: Select, user: User) -> Select:
    """
    - admin：不过滤，看全部任务
    - annotator：只能看分配给自己的任务（assigned_to = 自己）
    - reviewer：只能看待审核/自己在审的任务（reviewer_id = 自己，或状态为SUBMITTED且未指派审核人）
    """
    if user.role == UserRole.admin:
        return query
    if user.role == UserRole.annotator:
        return query.where(Task.assigned_to == user.id)
    if user.role == UserRole.reviewer:
        # 注意：这里必须带上 status==SUBMITTED 这个条件。只写 reviewer_id IS NULL
        # 的话，任何还没人认领审核的任务（包括别人正在标、还没提交的）都会对
        # 审核员可见，跟上面写的规则对不上，也会顺带放开这些任务对应的样本媒体。
        return query.where(
            or_(
                Task.reviewer_id == user.id,
                (Task.reviewer_id.is_(None)) & (Task.status == TaskStatus.SUBMITTED),
            )
        )
    # 未知角色一律拒绝，返回恒假条件
    return query.where(Task.id.is_(None))


async def visible_project_ids(db: AsyncSession, user: User) -> set[int] | None:
    """
    这个人能看到哪些项目。返回 None 表示不受限（admin）。

    非管理员不该看到跟自己无关的项目：项目名/说明本身就是业务信息，
    项目列表还会暴露有多少活儿、都派给了谁。所以统一由"他能看到哪些任务"
    反推——还是走 apply_task_scope 这一个口子，不另立规则。
    """
    if user.role == UserRole.admin:
        return None
    rows = await db.execute(apply_task_scope(select(Task.project_id).distinct(), user))
    return {pid for pid in rows.scalars().all() if pid is not None}
