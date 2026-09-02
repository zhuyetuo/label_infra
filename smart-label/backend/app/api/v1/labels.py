from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.label import LabelCreate, LabelOut, LabelUpdate

router = APIRouter(prefix="/label-definitions", tags=["labels"])


@router.get("")
async def list_labels(
    project_id: int | None = None, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)
):
    """所有登录用户都可读（标注UI需要），仅 admin 可写。project_id 不传则返回全部项目的标签。"""
    query = select(LabelDefinition).where(LabelDefinition.is_active.is_(True))
    if project_id is not None:
        query = query.where(LabelDefinition.project_id == project_id)
    result = await db.execute(query.order_by(LabelDefinition.sort_order))
    labels = result.scalars().all()
    return ok([LabelOut.model_validate(item).model_dump() for item in labels])


@router.post("", dependencies=[Depends(require_role(UserRole.admin))])
async def create_label(
    body: LabelCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    # code 只在项目内唯一，不同项目可以有同名 code
    exists = await db.execute(
        select(LabelDefinition).where(
            LabelDefinition.project_id == body.project_id, LabelDefinition.code == body.code
        )
    )
    if exists.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "该项目下标签code已存在")
    label = LabelDefinition(**body.model_dump(), created_by=admin.id)
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return ok(LabelOut.model_validate(label).model_dump())


@router.patch("/{label_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def update_label(label_id: int, body: LabelUpdate, db: AsyncSession = Depends(get_db)):
    label = await db.get(LabelDefinition, label_id)
    if label is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(label, field, value)
    await db.commit()
    await db.refresh(label)
    return ok(LabelOut.model_validate(label).model_dump())
