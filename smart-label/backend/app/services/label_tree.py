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


async def link_from_templates(db: AsyncSession, project_id: int | None = None) -> int:
    """老项目升级：还没有上级、但来自模板条目且条目有 parent_code 的标签，按同项目里
    code 等于 parent_code 的那条挂上。返回挂了几条。反复跑没副作用。"""
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
    by_pc = {(l.project_id, l.code): l.id for l in all_labels}
    n = 0
    for l, pcode in rows:
        pid = by_pc.get((l.project_id, pcode))
        if pid is not None and pid != l.id:
            l.parent_id = pid
            n += 1
    return n
