"""标签模板 → 项目：套用（拷条目、挂父子）、模板改了往跟着它的项目标签同步。

「跟着模板」= LabelDefinition.template_item_id 还指着模板条目（项目里手动改过颜色 / 名字
就断开）。跟着的标签：模板改名、改颜色会同步过去；模板加了条目，启动时给套过这个模板
的项目自动补上（人不用每个项目再套一次）。
"""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.services import label_tree


def parents_first(items: list[LabelTemplateItem]) -> list[LabelTemplateItem]:
    """按层级排：上级在前。坏数据（上级不在、绕圈）就按原顺序放最后。"""
    by_code = {i.code: i for i in items}
    out: list[LabelTemplateItem] = []
    done: set[str] = set()

    def visit(i: LabelTemplateItem, stack: set[str]) -> None:
        if i.code in done or i.code in stack:
            return
        stack.add(i.code)
        if i.parent_code and i.parent_code in by_code:
            visit(by_code[i.parent_code], stack)
        done.add(i.code)
        out.append(i)

    for i in items:
        visit(i, set())
    return out


async def apply_to_project(db: AsyncSession, items: list[LabelTemplateItem], project_id: int, created_by: int) -> dict:
    """把模板条目拷到项目里：同 code **或同名** 的已有标签直接复用（不会多出第二个「抓挠」），
    其余新建；然后按 parent_code 挂父子（上级可以是项目里已有的，内置父标签没有就建）。
    不 commit。返回 {created, skipped, skipped_codes, linked}。"""
    project_labels = (
        await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == project_id))
    ).scalars().all()
    existing = {l.code: l for l in project_labels}
    by_name = {l.display_name: l for l in project_labels}

    created = 0
    skipped: list[str] = []
    id_of: dict[str, int] = {code: l.id for code, l in existing.items()}
    ordered = parents_first(items)
    for item in ordered:
        hit = existing.get(item.code) or by_name.get(item.display_name)
        if hit is not None:
            skipped.append(item.code)
            existing[item.code] = hit
            id_of[item.code] = hit.id
            continue
        label = LabelDefinition(
            project_id=project_id, code=item.code, display_name=item.display_name, color=item.color,
            sort_order=item.sort_order, template_item_id=item.id, created_by=created_by,
        )
        db.add(label)
        await db.flush()
        id_of[item.code] = label.id
        existing[item.code] = label
        by_name[item.display_name] = label
        created += 1
    linked = 0
    pool = list(existing.values())
    for item in ordered:
        if not item.parent_code:
            continue
        label = existing.get(item.code)
        if label is None:
            continue
        parent = await label_tree.resolve_parent(db, project_id, item.parent_code, pool, created_by)
        if parent is None or parent.id == label.id:
            continue
        if parent.code not in existing:
            existing[parent.code] = parent
            id_of[parent.code] = parent.id
            created += 1
        if label.parent_id is None:
            label.parent_id = parent.id
            if item.code in skipped:
                linked += 1
    return {"created": created, "skipped": len(skipped), "skipped_codes": skipped, "linked": linked}


async def rename_followers(db: AsyncSession, item_id: int, display_name: str) -> None:
    """模板条目改名：还跟着它的项目标签一起改（跟颜色的同步一样）。"""
    await db.execute(update(LabelDefinition).where(LabelDefinition.template_item_id == item_id)
                     .values(display_name=display_name))


async def sync_projects(db: AsyncSession, template_id: int) -> dict:
    """模板加了条目 / 改了父子：给所有套过这个模板（有标签还跟着它）的项目补齐。
    只补不删：项目里删掉的条目不会再补回来吗？——会补。要不想要，在项目里停用而不是删。
    返回 {projects, created, linked}。"""
    items = (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == template_id)
        .order_by(LabelTemplateItem.sort_order, LabelTemplateItem.id)
    )).scalars().all()
    if not items:
        return {"projects": 0, "created": 0, "linked": 0}
    item_ids = [i.id for i in items]
    rows = (await db.execute(
        select(LabelDefinition.project_id, LabelDefinition.created_by)
        .where(LabelDefinition.template_item_id.in_(item_ids)).distinct()
    )).all()
    by_project: dict[int, int] = {}
    for pid, uid in rows:
        by_project.setdefault(pid, uid)
    total = {"projects": 0, "created": 0, "linked": 0}
    for pid, uid in by_project.items():
        r = await apply_to_project(db, items, pid, uid)
        if r["created"] or r["linked"]:
            total["projects"] += 1
            total["created"] += r["created"]
            total["linked"] += r["linked"]
    return total


async def builtin_template_id(db: AsyncSession, name: str) -> int | None:
    return (await db.execute(select(LabelTemplate.id).where(LabelTemplate.name == name))).scalar_one_or_none()
