"""把一个混了好多天数据的老项目，按采集日期拆成一天一个项目。

早期导进来的项目（2026_7_17-2026_7_29_old 这种）一个项目里几百个任务、十几天
混在一起，查某一天的标注要翻半天。新采的数据已经是"每天各建一个项目"了，
老项目也拆成同样的形状，查阅和调整才一致。

**任务是搬过去的，不是复制的**：标注结果、审核记录、轮次都挂在任务上，跟着
任务走，一条不丢；复制的话同一段标注会在导出/统计里算两遍。

标签是项目级的（label_definitions.project_id），搬任务之前先把老项目的标签
原样克隆到每个新项目里（含层级、分轨、颜色、模板来源），再把标注条目和候选
的 label_id 对到新项目的同名标签上——不对的话工作台会显示"未知标签"。

老项目搬空之后**保留、置为停用**，说明里写清拆到了哪些项目。要回头找它还能找到。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_candidate import AiCandidate
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task


class SplitError(Exception):
    pass


async def _unique_name(db: AsyncSession, base: str, old: Project) -> str:
    """新项目名：优先就叫日期；撞名了带上老项目名，再撞就带 id。"""
    for cand in (base, f"{base}_{old.name}"[:100], f"{base}_from{old.id}"):
        hit = (await db.execute(select(Project.id).where(Project.name == cand))).scalar_one_or_none()
        if hit is None:
            return cand
    raise SplitError(f"想不出不重名的项目名：{base}")


async def clone_labels(db: AsyncSession, src_project_id: int, dst_project_id: int, created_by: int) -> dict[int, int]:
    """把 src 的标签整套克隆到 dst，返回 {旧 label_id: 新 label_id}。层级按父先子后建。"""
    labels = (
        await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == src_project_id))
    ).scalars().all()
    by_id = {l.id: l for l in labels}
    mapping: dict[int, int] = {}

    def depth(l: LabelDefinition) -> int:
        d, cur, seen = 0, l, set()
        while cur.parent_id and cur.parent_id in by_id and cur.parent_id not in seen:
            seen.add(cur.parent_id)
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for l in sorted(labels, key=lambda x: (depth(x), x.sort_order, x.id)):
        new = LabelDefinition(
            project_id=dst_project_id, code=l.code, display_name=l.display_name, color=l.color,
            template_item_id=l.template_item_id,
            parent_id=mapping.get(l.parent_id) if l.parent_id else None,
            track=l.track, sort_order=l.sort_order, is_active=l.is_active, created_by=created_by,
        )
        db.add(new)
        await db.flush()
        mapping[l.id] = new.id
    return mapping


async def split_by_date(db: AsyncSession, project_id: int, user_id: int) -> dict:
    """返回 {"created": [{"id","name","date","n_tasks"}], "skipped_no_date": n, "source": {...}}。不 commit。"""
    old = await db.get(Project, project_id)
    if old is None:
        raise SplitError("项目不存在")
    rows = (
        await db.execute(
            select(Task.id, Sample.session_date)
            .join(Sample, Sample.id == Task.sample_id)
            .where(Task.project_id == project_id)
        )
    ).all()
    by_date: dict[date, list[int]] = defaultdict(list)
    no_date: list[int] = []
    for tid, d in rows:
        (by_date[d] if d is not None else no_date).append(tid)
    if not by_date:
        raise SplitError("这个项目里的样本都没有采集日期，没法按日期拆")
    if len(by_date) == 1 and not no_date:
        raise SplitError(f"这个项目的样本都是同一天（{next(iter(by_date))}），不用拆")

    created = []
    for d in sorted(by_date):
        task_ids = by_date[d]
        name = await _unique_name(db, d.isoformat(), old)
        new = Project(name=name, description=f"从「{old.name}」按日期拆出（{d.isoformat()}）",
                      is_active=True, created_by=user_id)
        db.add(new)
        await db.flush()
        mapping = await clone_labels(db, old.id, new.id, user_id)

        # 标注条目 / 候选的 label_id 对到新项目的标签上。按旧 label 逐个 UPDATE，
        # 范围限制在这批任务的记录里，别碰到还留在老项目（没日期）的那些
        record_ids = select(AnnotationRecord.id).where(AnnotationRecord.task_id.in_(task_ids))
        for old_lid, new_lid in mapping.items():
            await db.execute(
                update(AnnotationLabelItem)
                .where(AnnotationLabelItem.label_id == old_lid,
                       AnnotationLabelItem.annotation_record_id.in_(record_ids))
                .values(label_id=new_lid)
            )
            await db.execute(
                update(AiCandidate)
                .where(AiCandidate.decided_label_id == old_lid, AiCandidate.task_id.in_(task_ids))
                .values(decided_label_id=new_lid)
            )
        await db.execute(update(Task).where(Task.id.in_(task_ids)).values(project_id=new.id))
        created.append({"id": new.id, "name": name, "date": d.isoformat(), "n_tasks": len(task_ids)})

    # 老项目留着但停用；没日期的任务还在它里面
    names = "、".join(c["name"] for c in created)
    note = f"已按日期拆成 {len(created)} 个项目：{names}"
    if no_date:
        note += f"（{len(no_date)} 个没有采集日期的任务还留在这里）"
    old.description = (f"{old.description}\n" if old.description else "") + note
    old.description = old.description[:500]
    old.is_active = bool(no_date)
    return {"created": created, "skipped_no_date": len(no_date),
            "source": {"id": old.id, "name": old.name}}
