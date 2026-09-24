"""把一个混了好多天数据的老项目，按采集日期拆成一天一个项目。

早期导进来的项目（2026_7_17-2026_7_29_old 这种）一个项目里几百个任务、十几天
混在一起，查某一天的标注要翻半天。新采的数据已经是"每天各建一个项目"了，
老项目也拆成同样的形状，查阅和调整才一致。

**原项目原样保留，任务是复制过去的。** 第一版是搬过去的：老项目当场空了，
人没法拿它对照拆得对不对（2026-09-24 就是这样，被要求还原）。所以现在：
  · 每个新项目里是任务 + 标注记录 + 标注条目的副本，老项目一个字不动；
  · 标签是项目级的（label_definitions.project_id），先把老项目的标签整套克隆到
    每个新项目（含层级、分轨、颜色、模板来源），副本里的 label_id 对到新标签上；
  · 「撤销拆分」把拆出来的项目整个删掉，老项目回到原样；
  · 核对无误之后老项目自己去「停用」——导出训练集时不指定项目的话会跳过停用的
    项目（training_export_service），同一段标注不会算两遍。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_candidate import AiCandidate
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.services.task_service import purge_task_children


class SplitError(Exception):
    pass


def _mark(old: Project) -> str:
    return f"从「{old.name}」按日期拆出"


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


async def _copy_tasks(db: AsyncSession, task_ids: list[int], dst_project_id: int,
                      label_map: dict[int, int]) -> int:
    """把这些任务连同标注记录、标注条目复制到 dst。候选、审核记录、锁不复制——那是工作状态。"""
    tasks = (await db.execute(select(Task).where(Task.id.in_(task_ids)))).scalars().all()
    for t in tasks:
        nt = Task(project_id=dst_project_id, sample_id=t.sample_id, task_type=t.task_type, status=t.status,
                  segment_start_ms=t.segment_start_ms, segment_end_ms=t.segment_end_ms,
                  round_no=t.round_no, assigned_to=t.assigned_to, reviewer_id=t.reviewer_id,
                  created_by=t.created_by)
        db.add(nt)
        await db.flush()
        recs = (await db.execute(select(AnnotationRecord).where(AnnotationRecord.task_id == t.id))).scalars().all()
        for r in recs:
            nr = AnnotationRecord(task_id=nt.id, round_no=r.round_no, source_type=r.source_type,
                                  result_file_path=r.result_file_path, submitted_at=r.submitted_at)
            db.add(nr)
            await db.flush()
            items = (await db.execute(
                select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == r.id))).scalars().all()
            for it in items:
                db.add(AnnotationLabelItem(
                    annotation_record_id=nr.id, label_id=label_map.get(it.label_id, it.label_id),
                    start_time_ms=it.start_time_ms, end_time_ms=it.end_time_ms, source_type=it.source_type,
                    is_modified=it.is_modified, ai_confidence=it.ai_confidence, ai_confirmed=it.ai_confirmed,
                    uncertain=it.uncertain, uncertain_reason=it.uncertain_reason, created_by=it.created_by,
                ))
        await db.flush()
    return len(tasks)


async def split_by_date(db: AsyncSession, project_id: int, user_id: int) -> dict:
    """返回 {"created": [{"id","name","date","n_tasks"}], "skipped_no_date": n, "source": {...}}。不 commit。"""
    old = await db.get(Project, project_id)
    if old is None:
        raise SplitError("项目不存在")
    if await _children(db, old):
        raise SplitError("这个项目已经拆过了。要重拆先「撤销拆分」")
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
        new = Project(name=name, description=f"{_mark(old)}（{d.isoformat()}）",
                      is_active=True, created_by=user_id)
        db.add(new)
        await db.flush()
        mapping = await clone_labels(db, old.id, new.id, user_id)
        n = await _copy_tasks(db, task_ids, new.id, mapping)
        created.append({"id": new.id, "name": name, "date": d.isoformat(), "n_tasks": n})

    names = "、".join(c["name"] for c in created)
    note = f"已按日期拆成 {len(created)} 个项目（原任务保留在这里）：{names}"
    if no_date:
        note += f"（{len(no_date)} 个没有采集日期的任务没拆）"
    old.description = ((f"{old.description}\n" if old.description else "") + note)[:500]
    return {"created": created, "skipped_no_date": len(no_date),
            "source": {"id": old.id, "name": old.name}}


async def _children(db: AsyncSession, old: Project) -> list[Project]:
    return list((await db.execute(
        select(Project).where(Project.description.like(f"{_mark(old)}%"), Project.id != old.id)
    )).scalars().all())


async def _delete_project(db: AsyncSession, p: Project) -> int:
    task_ids = (await db.execute(select(Task.id).where(Task.project_id == p.id))).scalars().all()
    if task_ids:
        await purge_task_children(db, task_ids)
        await db.execute(delete(Task).where(Task.project_id == p.id))
    await db.execute(update(LabelDefinition).where(LabelDefinition.project_id == p.id).values(parent_id=None))
    await db.execute(delete(LabelDefinition).where(LabelDefinition.project_id == p.id))
    await db.delete(p)
    return len(task_ids)


async def unsplit(db: AsyncSession, project_id: int) -> dict:
    """撤销拆分：拆出来的项目整个删掉，老项目回到原样。

    兼容第一版（任务是搬走的）：拆出来的项目里，老项目没有同样本任务的那些，
    先搬回来（label_id 按 code 对回老项目的标签）再删项目。不 commit。
    """
    old = await db.get(Project, project_id)
    if old is None:
        raise SplitError("项目不存在")
    children = await _children(db, old)
    if not children:
        raise SplitError("这个项目没有拆出来的子项目")
    old_labels = {l.code: l.id for l in (await db.execute(
        select(LabelDefinition).where(LabelDefinition.project_id == old.id))).scalars().all()}
    old_samples = set((await db.execute(select(Task.sample_id).where(Task.project_id == old.id))).scalars().all())

    moved_back = 0
    removed = []
    for child in children:
        child_labels = (await db.execute(
            select(LabelDefinition).where(LabelDefinition.project_id == child.id))).scalars().all()
        back_map = {l.id: old_labels[l.code] for l in child_labels if l.code in old_labels}
        tasks = (await db.execute(select(Task).where(Task.project_id == child.id))).scalars().all()
        to_move = [t.id for t in tasks if t.sample_id not in old_samples]
        if to_move:
            record_ids = select(AnnotationRecord.id).where(AnnotationRecord.task_id.in_(to_move))
            for c_lid, o_lid in back_map.items():
                await db.execute(update(AnnotationLabelItem)
                                 .where(AnnotationLabelItem.label_id == c_lid,
                                        AnnotationLabelItem.annotation_record_id.in_(record_ids))
                                 .values(label_id=o_lid))
                await db.execute(update(AiCandidate)
                                 .where(AiCandidate.decided_label_id == c_lid, AiCandidate.task_id.in_(to_move))
                                 .values(decided_label_id=o_lid))
            await db.execute(update(Task).where(Task.id.in_(to_move)).values(project_id=old.id))
            moved_back += len(to_move)
        removed.append({"id": child.id, "name": child.name, "n_tasks": await _delete_project(db, child)})

    old.is_active = True
    if old.description:
        old.description = "\n".join(
            ln for ln in old.description.split("\n") if not ln.startswith("已按日期拆成")) or None
    return {"removed": removed, "moved_back": moved_back, "source": {"id": old.id, "name": old.name}}
