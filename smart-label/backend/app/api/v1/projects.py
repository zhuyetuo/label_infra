"""
项目管理。同一份数据在不同业务场景下要标的东西不一样，所以任务和标签都挂在
项目下，项目之间标签互不干扰。所有登录用户都能读（标注/审核页要按项目筛），
只有管理员能增删改。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.label import LabelDefinition
from app.models.review import ReviewRecord
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services.task_scope import visible_project_ids
from app.schemas.project import (
    ProjectAssignRequest,
    ProjectAssignResult,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """管理员看全部；标注员/审核员只看得到有自己任务的项目。"""
    query = select(Project)
    allowed = await visible_project_ids(db, user)
    if allowed is not None:
        if not allowed:
            return ok([])
        query = query.where(Project.id.in_(allowed))
    result = await db.execute(query.order_by(Project.created_at.desc()))
    return ok([ProjectOut.model_validate(p).model_dump() for p in result.scalars().all()])


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def create_project(
    body: ProjectCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    exists = (await db.execute(select(Project).where(Project.name == body.name))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "项目名已存在")
    project = Project(**body.model_dump(), created_by=admin.id)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ok(ProjectOut.model_validate(project).model_dump())


@router.patch("/{project_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def update_project(project_id: int, body: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    return ok(ProjectOut.model_validate(project).model_dump())


@router.post("/{project_id}/assign", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def assign_project(project_id: int, body: ProjectAssignRequest, db: AsyncSession = Depends(get_db)):
    """
    把整个项目的任务一次性指派给某人：一个项目往往就是一批要一起干的活儿，
    逐个任务点太麻烦。

    默认只改还没被认领的任务（PENDING_ASSIGN）——已经有人在标或已提交的
    不动，免得把别人做了一半的活儿抢走。确实要整体换人时传 include_claimed。
    已审核通过的任务任何情况下都不动，那是归档数据。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    if body.user_id is not None:
        target = await db.get(User, body.user_id)
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
        if not target.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该账号已停用，不能指派任务")
        if target.role == UserRole.reviewer:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "审核员不承担标注任务，请选标注员或管理员")

    movable = (
        [TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED, TaskStatus.REJECTED]
        if body.include_claimed
        else [TaskStatus.PENDING_ASSIGN]
    )
    total = (
        await db.execute(select(func.count()).select_from(Task).where(Task.project_id == project_id))
    ).scalar_one()

    values: dict = {"assigned_to": body.user_id}
    if body.include_claimed:
        # 换人就得把旧的软锁一起清掉，否则新人认领不了（claim 要求 PENDING_ASSIGN）
        values.update({"status": TaskStatus.PENDING_ASSIGN, "locked_by": None, "lock_expires_at": None})

    result = await db.execute(
        update(Task).where(Task.project_id == project_id, Task.status.in_(movable)).values(**values)
    )
    await db.commit()
    assigned = result.rowcount or 0
    return ok(ProjectAssignResult(assigned=assigned, skipped=total - assigned).model_dump())


@router.delete("/{project_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def delete_project(project_id: int, db: AsyncSession = Depends(get_db)):
    """
    删项目会把它下面的任务、标注结果、审核记录、标签一起删掉，不可恢复。
    外键都指向上一层，所以顺序是：标签条目 -> 标注记录 -> 审核记录 -> 任务
    -> 标签定义 -> 项目，不能直接删项目。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    task_ids = (
        (await db.execute(select(Task.id).where(Task.project_id == project_id))).scalars().all()
    )
    record_ids: list[int] = []
    if task_ids:
        record_ids = (
            (await db.execute(select(AnnotationRecord.id).where(AnnotationRecord.task_id.in_(task_ids))))
            .scalars()
            .all()
        )
    if record_ids:
        await db.execute(
            delete(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id.in_(record_ids))
        )
    if task_ids:
        await db.execute(delete(AnnotationRecord).where(AnnotationRecord.task_id.in_(task_ids)))
        await db.execute(delete(ReviewRecord).where(ReviewRecord.task_id.in_(task_ids)))
        # 子任务的 parent 指向本项目内的任务，先断开再删，避免自引用外键挡住
        await db.execute(update(Task).where(Task.parent_task_id.in_(task_ids)).values(parent_task_id=None))
        await db.execute(delete(Task).where(Task.project_id == project_id))
    label_count = (
        await db.execute(delete(LabelDefinition).where(LabelDefinition.project_id == project_id))
    ).rowcount or 0

    await db.delete(project)
    await db.commit()
    return ok(msg=f"项目已删除（连带 {len(task_ids)} 个任务、{label_count} 个标签）")
