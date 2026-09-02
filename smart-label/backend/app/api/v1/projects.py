"""
项目管理。同一份数据在不同业务场景下要标的东西不一样，所以任务和标签都挂在
项目下，项目之间标签互不干扰。所有登录用户都能读（标注/审核页要按项目筛），
只有管理员能增删改。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.project import ProjectCreate, ProjectOut, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    result = await db.execute(select(Project).order_by(Project.created_at.desc()))
    return ok([ProjectOut.model_validate(p).model_dump() for p in result.scalars().all()])


@router.post("", dependencies=[Depends(require_role(UserRole.admin))])
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


@router.patch("/{project_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def update_project(project_id: int, body: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    return ok(ProjectOut.model_validate(project).model_dump())


@router.delete("/{project_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def delete_project(project_id: int, db: AsyncSession = Depends(get_db)):
    """
    项目下面还有任务或标签时不给删——那些数据连着标注结果和审核记录，
    静默级联删掉风险太大。要删先把任务删干净，或者直接把项目停用。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    task_count = (
        await db.execute(select(func.count()).select_from(Task).where(Task.project_id == project_id))
    ).scalar_one()
    label_count = (
        await db.execute(
            select(func.count()).select_from(LabelDefinition).where(LabelDefinition.project_id == project_id)
        )
    ).scalar_one()
    if task_count or label_count:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"项目下还有 {task_count} 个任务、{label_count} 个标签，先清空或直接停用项目",
        )

    await db.delete(project)
    await db.commit()
    return ok(msg="项目已删除")
