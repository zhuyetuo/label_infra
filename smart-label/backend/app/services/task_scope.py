"""
数据隔离唯一入口。所有查询 tasks 表的地方都必须经过这里过滤，
不允许在各个路由里各自写 WHERE 条件——避免漏掉隔离导致标注员看到别人的任务。
"""

from sqlalchemy import Select, or_

from app.models.task import Task
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
        return query.where(
            or_(Task.reviewer_id == user.id, Task.reviewer_id.is_(None))
        )
    # 未知角色一律拒绝，返回恒假条件
    return query.where(Task.id.is_(None))
