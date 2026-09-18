"""层级标签的几件公共事：父子校验、往下找子孙、往上找祖先、老项目补父子关系。

层级的用法（跟标注员约定的）：
  看得清就标最细的（舔身体-前左爪），看不清就停在上级（舔身体-前爪 / 舔身体）。
  标了细的自动算进上级——统计、皮肤跟踪、模型评测都按"这个标签 + 它的全部子孙"算；
  导出训练集时一段带整条链（舔身体 / 舔身体-前爪 / 舔身体-前左爪），训练用哪层自己挑。
  父子重叠不算矛盾标注（细的那段本来就在粗的里面）。

parent_id 在 label_definitions 上早就有；模板条目用 parent_code，套用时换算。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplateItem

# 最多几层：舔身体 → 前爪 → 前左爪 是三层，再深标注员就选不过来了
MAX_DEPTH = 4


def children_map(labels: list[LabelDefinition]) -> dict[int | None, list[LabelDefinition]]:
    m: dict[int | None, list[LabelDefinition]] = {}
    for l in labels:
        m.setdefault(l.parent_id, []).append(l)
    for v in m.values():
        v.sort(key=lambda x: (x.sort_order, x.id))
    return m


def descendants(labels: list[LabelDefinition], root_ids: set[int]) -> set[int]:
    """root_ids 自己 + 全部子孙的 id。"""
    cm = children_map(labels)
    out: set[int] = set()
    stack = list(root_ids)
    while stack:
        i = stack.pop()
        if i in out:
            continue
        out.add(i)
        stack.extend(c.id for c in cm.get(i, []))
    return out


def ancestors_chain(by_id: dict[int, LabelDefinition], label_id: int) -> list[int]:
    """从最上级到自己：[祖, 父, 自己]。断链/成环就到哪算哪。"""
    chain: list[int] = []
    cur: int | None = label_id
    seen: set[int] = set()
    while cur is not None and cur not in seen and cur in by_id:
        seen.add(cur)
        chain.append(cur)
        cur = by_id[cur].parent_id
    chain.reverse()
    return chain


async def expand_ids(db: AsyncSession, ids: set[int]) -> set[int]:
    """给定几个标签 id，补上它们的全部子孙。跨项目也行（每个项目各自那棵树）。"""
    if not ids:
        return set()
    pids = set((await db.execute(
        select(LabelDefinition.project_id).where(LabelDefinition.id.in_(ids)).distinct()
    )).scalars().all())
    labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id.in_(pids)))).scalars().all()
    return descendants(labels, ids)


async def validate_parent(db: AsyncSession, project_id: int, label_id: int | None, parent_id: int | None) -> None:
    """parent_id 得是同项目的标签、不是自己、不是自己的子孙、挂上去不超过 MAX_DEPTH 层。
    不合法就 ValueError（一句人话）。"""
    if parent_id is None:
        return
    if label_id is not None and parent_id == label_id:
        raise ValueError("上级不能是自己")
    labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == project_id))).scalars().all()
    by_id = {l.id: l for l in labels}
    parent = by_id.get(parent_id)
    if parent is None:
        raise ValueError("上级标签不存在或不在这个项目里")
    if label_id is not None and parent_id in descendants(labels, {label_id}):
        raise ValueError("上级不能是自己的子标签（会绕成圈）")
    up = len(ancestors_chain(by_id, parent_id))
    down = 0
    if label_id is not None:
        cm = children_map(labels)

        def depth(i: int) -> int:
            return 1 + max((depth(c.id) for c in cm.get(i, [])), default=0)

        down = depth(label_id) - 1
    if up + 1 + down > MAX_DEPTH:
        raise ValueError(f"层级最多 {MAX_DEPTH} 层")


def _name_variants(name: str) -> set[str]:
    """「舔-前爪」也认「舔身体-前爪」这种旧前缀。"""
    from app.services.grooming_labels import GROUPS, alias_names

    out = {name}
    for _c, gname, _col, _t, _p in GROUPS:
        if name.startswith(gname + "-"):
            for alias in alias_names(gname):
                out.add(alias + name[len(gname):])
    return out


def _group_spec(parent_code: str) -> tuple[str, str, int] | None:
    """内置分组里这个 code 的父标签长什么样：(显示名, 颜色, 排序)。不是内置的返回 None。"""
    from app.services.grooming_labels import GROUPS, SORT_BASE, SORT_STRIDE

    for i, (code, name, color, _tpl, _parts) in enumerate(GROUPS):
        if code == parent_code:
            return name, color, SORT_BASE + i * SORT_STRIDE
    return None


async def resolve_parent(db: AsyncSession, project_id: int, parent_code: str,
                         labels: list[LabelDefinition], created_by: int) -> LabelDefinition | None:
    """按 parent_code 在项目里找父标签：先按 code，再按名字（内置分组的名字新旧都认，
    比如「抓挠」「舔身体」/「舔」），都没有而它是内置分组的父标签就建出来（模板故意
    不带「抓挠」，指望项目里已有；项目里真没有的话部位就挂不上，全成了大类）。
    建出来的会 add 进 session 并 flush，同时追加到 labels 里。"""
    from app.services.grooming_labels import alias_names

    hit = next((l for l in labels if l.code == parent_code), None)
    if hit is not None:
        return hit
    spec = _group_spec(parent_code)
    if spec is None:
        # 中间那层（舔-前爪）项目里没有：按名字找一下，再没有就退到它的上级（舔）
        from app.services.grooming_labels import wanted_rows

        row = next((r for r in wanted_rows() if r.code == parent_code), None)
        if row is None:
            return None
        hit = next((l for l in labels if l.display_name in _name_variants(row.display_name)), None)
        if hit is not None:
            return hit
        return await resolve_parent(db, project_id, row.parent_code, labels, created_by) if row.parent_code else None
    name, color, sort = spec
    names = set(alias_names(name))
    hit = next((l for l in labels if l.display_name in names), None)
    if hit is not None:
        return hit
    l = LabelDefinition(project_id=project_id, code=parent_code, display_name=name, color=color,
                        sort_order=sort, created_by=created_by)
    db.add(l)
    await db.flush()
    labels.append(l)
    return l


async def link_from_templates(db: AsyncSession, project_id: int | None = None) -> int:
    """老项目升级：还没有上级、但来自模板条目且条目有 parent_code 的标签，挂到同项目里
    对应的父标签上（找不到的内置父标签会建出来，见 resolve_parent）。返回挂了几条。
    反复跑没副作用。"""
    q = (select(LabelDefinition, LabelTemplateItem.parent_code)
         .join(LabelTemplateItem, LabelTemplateItem.id == LabelDefinition.template_item_id)
         .where(LabelDefinition.parent_id.is_(None), LabelTemplateItem.parent_code.is_not(None)))
    if project_id is not None:
        q = q.where(LabelDefinition.project_id == project_id)
    rows = (await db.execute(q)).all()
    if not rows:
        return 0
    pids = {l.project_id for l, _ in rows}
    all_labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id.in_(pids)))).scalars().all()
    by_project: dict[int, list[LabelDefinition]] = {}
    for l in all_labels:
        by_project.setdefault(l.project_id, []).append(l)
    n = 0
    for l, pcode in rows:
        parent = await resolve_parent(db, l.project_id, pcode, by_project.setdefault(l.project_id, []), l.created_by)
        if parent is not None and parent.id != l.id:
            l.parent_id = parent.id
            n += 1
    return n


async def link_by_convention(db: AsyncSession, project_id: int | None = None) -> int:
    """不是从模板来的（手工建的、命令行脚本建的、老版本套的）也补上级：
    code 对得上内置定义的（lick_body_fore_l → lick_body_fore），或者名字是「父名-部位」
    （抓挠-头颈耳 → 抓挠；舔身体-前爪 → 舔身体 / 舔）。父标签没有的内置父会建出来。
    只动还没有上级的，反复跑没副作用。返回挂了几条。"""
    from app.services.grooming_labels import GROUPS, alias_names, wanted_rows

    q = select(LabelDefinition).where(LabelDefinition.parent_id.is_(None))
    if project_id is not None:
        q = q.where(LabelDefinition.project_id == project_id)
    orphans = (await db.execute(q)).scalars().all()
    if not orphans:
        return 0
    pids = {l.project_id for l in orphans}
    all_labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id.in_(pids)))).scalars().all()
    by_project: dict[int, list[LabelDefinition]] = {}
    for l in all_labels:
        by_project.setdefault(l.project_id, []).append(l)
    parent_code_of = {r.code: r.parent_code for r in wanted_rows() if r.parent_code}
    # 「父名-xxx」：父名新旧都认；子的直接上级按内置定义找（舔-前左爪 的上级是 舔-前爪，不是 舔）
    want_by_name = {r.display_name: r for r in wanted_rows()}
    n = 0
    for l in orphans:
        pool = by_project.setdefault(l.project_id, [])
        pcode = parent_code_of.get(l.code)
        if pcode is None:
            # 按名字：先把「舔身体-前爪」归一成「舔-前爪」再查内置定义
            for gcode, gname, _c, _t, _p in GROUPS:
                for alias in alias_names(gname):
                    if l.display_name.startswith(alias + "-"):
                        canon = gname + l.display_name[len(alias):]
                        r = want_by_name.get(canon)
                        pcode = r.parent_code if r is not None else gcode
                        break
                if pcode:
                    break
        if not pcode:
            continue
        parent = await resolve_parent(db, l.project_id, pcode, pool, l.created_by)
        if parent is None or parent.id == l.id:
            continue
        # 内置定义里的直接上级项目里没有（比如没套过左右爪那层）：退到再上一级
        l.parent_id = parent.id
        n += 1
    return n
