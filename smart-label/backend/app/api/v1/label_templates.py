"""
标签模板：常用的一套标签存下来，新建项目直接套用，不用每次从头敲一遍。

模板是全局的，不属于任何项目；套用时把模板里的条目拷贝成该项目自己的标签，
之后改项目标签不会反向影响模板，改模板也不会影响已经套用过的项目——
拷贝而不是引用，是为了让各项目的标签体系可以各自演进。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.project import Project
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.label_template import (
    ApplyTemplateResult,
    LabelTemplateCreate,
    LabelTemplateItemIn,
    LabelTemplateItemOut,
    LabelTemplateOut,
    LabelTemplateUpdate,
    SaveAsTemplateRequest,
)

router = APIRouter(
    prefix="/label-templates",
    tags=["label-templates"],
    dependencies=[Depends(require_role(UserRole.admin))],
)


async def _load_items(db: AsyncSession, template_ids: list[int]) -> dict[int, list[LabelTemplateItem]]:
    if not template_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(LabelTemplateItem)
                .where(LabelTemplateItem.template_id.in_(template_ids))
                .order_by(LabelTemplateItem.sort_order, LabelTemplateItem.id)
            )
        )
        .scalars()
        .all()
    )
    grouped: dict[int, list[LabelTemplateItem]] = {}
    for r in rows:
        grouped.setdefault(r.template_id, []).append(r)
    return grouped


def _to_out(tpl: LabelTemplate, items: list[LabelTemplateItem]) -> dict:
    data = LabelTemplateOut.model_validate(tpl).model_dump()
    data["items"] = [LabelTemplateItemOut.model_validate(i).model_dump() for i in items]
    return data


async def _replace_items(db: AsyncSession, template_id: int, items: list[LabelTemplateItemIn]) -> None:
    """模板里的条目整组替换：先清空再插入，省得逐条比对增删改。"""
    await db.execute(delete(LabelTemplateItem).where(LabelTemplateItem.template_id == template_id))
    seen: set[str] = set()
    for item in items:
        if item.code in seen:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"模板里 code 重复: {item.code}")
        seen.add(item.code)
        db.add(LabelTemplateItem(template_id=template_id, **item.model_dump()))


@router.get("")
async def list_templates(db: AsyncSession = Depends(get_db)):
    templates = (
        (await db.execute(select(LabelTemplate).order_by(LabelTemplate.created_at.desc()))).scalars().all()
    )
    grouped = await _load_items(db, [t.id for t in templates])
    return ok([_to_out(t, grouped.get(t.id, [])) for t in templates])


@router.post("")
async def create_template(
    body: LabelTemplateCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    exists = (await db.execute(select(LabelTemplate).where(LabelTemplate.name == body.name))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "模板名已存在")

    tpl = LabelTemplate(name=body.name, description=body.description, created_by=admin.id)
    db.add(tpl)
    await db.flush()
    await _replace_items(db, tpl.id, body.items)
    await db.commit()
    await db.refresh(tpl)
    grouped = await _load_items(db, [tpl.id])
    return ok(_to_out(tpl, grouped.get(tpl.id, [])))


@router.post("/from-project")
async def save_project_labels_as_template(
    body: SaveAsTemplateRequest, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    """把某个项目现在的标签原样存成模板，方便下个项目直接套用。"""
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    exists = (await db.execute(select(LabelTemplate).where(LabelTemplate.name == body.name))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "模板名已存在")

    labels = (
        (
            await db.execute(
                select(LabelDefinition)
                .where(LabelDefinition.project_id == body.project_id, LabelDefinition.is_active.is_(True))
                .order_by(LabelDefinition.sort_order, LabelDefinition.id)
            )
        )
        .scalars()
        .all()
    )
    if not labels:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "该项目还没有启用中的标签，没什么可存的")

    tpl = LabelTemplate(name=body.name, description=body.description, created_by=admin.id)
    db.add(tpl)
    await db.flush()
    for label in labels:
        db.add(
            LabelTemplateItem(
                template_id=tpl.id,
                code=label.code,
                display_name=label.display_name,
                color=label.color,
                sort_order=label.sort_order,
            )
        )
    await db.commit()
    await db.refresh(tpl)
    grouped = await _load_items(db, [tpl.id])
    return ok(_to_out(tpl, grouped.get(tpl.id, [])))


@router.patch("/{template_id}")
async def update_template(template_id: int, body: LabelTemplateUpdate, db: AsyncSession = Depends(get_db)):
    tpl = await db.get(LabelTemplate, template_id)
    if tpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "模板不存在")

    if body.name is not None and body.name != tpl.name:
        exists = (
            await db.execute(select(LabelTemplate).where(LabelTemplate.name == body.name))
        ).scalar_one_or_none()
        if exists is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "模板名已存在")
        tpl.name = body.name
    if body.description is not None:
        tpl.description = body.description
    if body.items is not None:
        await _replace_items(db, template_id, body.items)

    await db.commit()
    await db.refresh(tpl)
    grouped = await _load_items(db, [template_id])
    return ok(_to_out(tpl, grouped.get(template_id, [])))


@router.delete("/{template_id}")
async def delete_template(template_id: int, db: AsyncSession = Depends(get_db)):
    """删模板只删模板本身，已经套用到项目里的标签是拷贝，不受影响。"""
    tpl = await db.get(LabelTemplate, template_id)
    if tpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "模板不存在")
    await db.execute(delete(LabelTemplateItem).where(LabelTemplateItem.template_id == template_id))
    await db.delete(tpl)
    await db.commit()
    return ok(msg="模板已删除")


@router.post("/{template_id}/apply-to/{project_id}")
async def apply_template(template_id: int, project_id: int, db: AsyncSession = Depends(get_db),
                         admin: User = Depends(get_current_user)):
    """
    把模板里的标签拷贝到项目下。项目里已经有同 code 的标签就跳过，
    不覆盖已有配置（那可能已经被标注引用了），并把跳过的 code 一并返回。
    """
    tpl = await db.get(LabelTemplate, template_id)
    if tpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "模板不存在")
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    items = (await _load_items(db, [template_id])).get(template_id, [])
    if not items:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "这个模板里还没有标签")

    existing_codes = set(
        (
            await db.execute(
                select(LabelDefinition.code).where(LabelDefinition.project_id == project_id)
            )
        )
        .scalars()
        .all()
    )

    created = 0
    skipped: list[str] = []
    for item in items:
        if item.code in existing_codes:
            skipped.append(item.code)
            continue
        db.add(
            LabelDefinition(
                project_id=project_id,
                code=item.code,
                display_name=item.display_name,
                color=item.color,
                sort_order=item.sort_order,
                created_by=admin.id,
            )
        )
        created += 1
    await db.commit()
    return ok(ApplyTemplateResult(created=created, skipped=len(skipped), skipped_codes=skipped).model_dump())
