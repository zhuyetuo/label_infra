"""
数据隔离唯一入口。所有查询 tasks 表的地方都必须经过这里过滤，
不允许在各个路由里各自写 WHERE 条件——避免漏掉隔离导致标注员看到别人的任务。

敏感样本（samples.is_sensitive）也在这里统一挡：非管理员的任何任务查询/认领
都自动排除掉敏感样本上的任务；媒体、IMU 这类按样本访问的接口用
sample_visible() 判断。
"""

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole


def is_privileged(user: User) -> bool:
    """管理员/超级管理员：不受任务范围和敏感样本限制。"""
    return user.role in (UserRole.admin, UserRole.super_admin)


def _sensitive_sample_ids():
    return select(Sample.id).where(Sample.is_sensitive.is_(True))


def exclude_sensitive(stmt, user: User):
    """
    非管理员的 Select/Update 语句都加上"样本不敏感"这一条。Select 和 Update 都有
    .where()，认领用的 UPDATE...WHERE 也能直接套，不用另写一份。
    """
    if is_privileged(user):
        return stmt
    return stmt.where(Task.sample_id.not_in(_sensitive_sample_ids()))


def exclude_own_annotation(stmt, user: User):
    """
    审核员也能标注了，那就得挡住"自己标的自己审"。管理员不受限（项目默认
    指派给超级管理员，他自己标完自己过是常规操作）。Select/Update 都能套。
    """
    if is_privileged(user):
        return stmt
    return stmt.where(or_(Task.assigned_to.is_(None), Task.assigned_to != user.id))


def apply_task_scope(query: Select, user: User) -> Select:
    """
    - admin/super_admin：不过滤，看全部任务
    - annotator：只能看分配给自己的任务（assigned_to = 自己）
    - reviewer：既能标也能审——分配给自己的标注任务（assigned_to = 自己）+
      待审核/自己在审的任务（reviewer_id = 自己，或状态为SUBMITTED且未指派审核人）
    - 非管理员一律看不到敏感样本上的任务
    """
    if is_privileged(user):
        return query
    query = exclude_sensitive(query, user)
    if user.role == UserRole.annotator:
        return query.where(Task.assigned_to == user.id)
    if user.role == UserRole.reviewer:
        # 注意：这里必须带上 status==SUBMITTED 这个条件。只写 reviewer_id IS NULL
        # 的话，任何还没人认领审核的任务（包括别人正在标、还没提交的）都会对
        # 审核员可见，跟上面写的规则对不上，也会顺带放开这些任务对应的样本媒体。
        return query.where(
            or_(
                Task.assigned_to == user.id,
                Task.reviewer_id == user.id,
                (Task.reviewer_id.is_(None)) & (Task.status == TaskStatus.SUBMITTED),
            )
        )
    # 未知角色一律拒绝，返回恒假条件
    return query.where(Task.id.is_(None))


async def sample_visible(db: AsyncSession, sample_id: int, user: User) -> bool:
    """
    这个人能不能碰这个样本（看视频/IMU/AI 预标注）。管理员随便看；其他人要在
    这个样本上有自己能看到的任务——还是走 apply_task_scope 反推，敏感样本自然
    也被挡在外面。
    """
    if is_privileged(user):
        return True
    row = (
        await db.execute(apply_task_scope(select(Task.id).where(Task.sample_id == sample_id), user).limit(1))
    ).scalar_one_or_none()
    return row is not None


async def visible_project_ids(db: AsyncSession, user: User) -> set[int] | None:
    """
    这个人能看到哪些项目。返回 None 表示不受限（admin/super_admin）。

    非管理员不该看到跟自己无关的项目：项目名/说明本身就是业务信息，
    项目列表还会暴露有多少活儿、都派给了谁。所以统一由"他能看到哪些任务"
    反推——还是走 apply_task_scope 这一个口子，不另立规则。
    """
    if is_privileged(user):
        return None
    rows = await db.execute(apply_task_scope(select(Task.project_id).distinct(), user))
    return {pid for pid in rows.scalars().all() if pid is not None}
