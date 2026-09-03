from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services.task_scope import visible_project_ids
from app.schemas.label import LabelCreate, LabelOut, LabelUpdate

router = APIRouter(prefix="/label-definitions", tags=["labels"])


@router.get("")
async def list_labels(
    project_id: int | None = None,
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    所有登录用户都可读（标注UI需要），仅 admin 可写。project_id 不传则返回全部项目的标签。
    默认只返回启用中的（标注界面不该看到停用的标签）；标签管理页要能看到并重新启用
    停用掉的，所以给了 include_inactive。
    """
    query = select(LabelDefinition)
    if not include_inactive:
        query = query.where(LabelDefinition.is_active.is_(True))
    # 非管理员只能看到自己有任务的那些项目的标签，别的项目标签也是业务信息
    allowed = await visible_project_ids(db, user)
    if allowed is not None:
        if not allowed:
            return ok([])
        query = query.where(LabelDefinition.project_id.in_(allowed))
    if project_id is not None:
        query = query.where(LabelDefinition.project_id == project_id)
    result = await db.execute(query.order_by(LabelDefinition.sort_order))
    labels = result.scalars().all()
    return ok([LabelOut.model_validate(item).model_dump() for item in labels])


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
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


@router.delete("/{label_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def delete_label(label_id: int, db: AsyncSession = Depends(get_db)):
    """
    删除标签。已经被标注结果引用的标签不能删——那些标注条目指着它，删了会变成
    孤儿数据，历史标注也就读不出标签名了。这种情况让改成停用：停用后标注界面
    不再出现，但历史数据还认得出来。
    """
    label = await db.get(LabelDefinition, label_id)
    if label is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签不存在")

    used = (
        await db.execute(
            select(func.count()).select_from(AnnotationLabelItem).where(AnnotationLabelItem.label_id == label_id)
        )
    ).scalar_one()
    if used:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"已有 {used} 条标注在用这个标签，不能删除；可以改成停用（停用后标注界面不再出现，历史标注不受影响）",
        )

    await db.delete(label)
    await db.commit()
    return ok(msg="标签已删除")


@router.patch("/{label_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def update_label(label_id: int, body: LabelUpdate, db: AsyncSession = Depends(get_db)):
    label = await db.get(LabelDefinition, label_id)
    if label is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(label, field, value)
    await db.commit()
    await db.refresh(label)
    return ok(LabelOut.model_validate(label).model_dump())
