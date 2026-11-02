"""数据池：人认可的高质量片段库（跟「导出数据集」不是一回事）。

导出数据集是某一刻的快照；数据池是一直在长的那个库：
  · 片段审核里点了「通过」的自动在池里
  · 认可的历史数据可以整批「手动加入」（pool_state=in），不想要的「手动移出」（out）
  · 人改了起止 / 类别：审核通过的回到待审、手动加入的也失效——都离开池子，要重新认可
每次训练从池里按类别 / 每类上限 / 项目 / 狗 / 日期 / 采样率挑一部分，导出成一份数据集再训
（导出 scope=pool，见 training_export_service）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.dog import Dog
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus


def in_pool(seg_status: str | None, pool_state: str | None) -> bool:
    """一条片段在不在池里（Python 版，导出时逐条判）"""
    if pool_state == "in":
        return True
    return seg_status == "approved" and pool_state != "out"


def in_pool_cond():
    """同上，SQL 版。coalesce 不能省：NULL 参与比较得 NULL，NOT 之后还是 NULL，
    「不在池里」（~in_pool_cond()）会把空值的行全漏掉"""
    it = AnnotationLabelItem
    ps, ss = func.coalesce(it.pool_state, ""), func.coalesce(it.seg_status, "")
    return or_(ps == "in", and_(ss == "approved", ps != "out"))


def _base(project_ids: list[int] | None, dog_ids: list[int] | None,
          date_from: date | None, date_to: date | None):
    """当前这一轮的片段 + 任务 + 样本。不选项目时只看启用的项目（拆分后的原项目停用了，不重复算）"""
    it = AnnotationLabelItem
    q = (select(it, Task, Sample)
         .join(AnnotationRecord, AnnotationRecord.id == it.annotation_record_id)
         .join(Task, and_(Task.id == AnnotationRecord.task_id, AnnotationRecord.round_no == Task.round_no))
         .join(Sample, Sample.id == Task.sample_id)
         .where(it.uncertain.is_(False)))
    if project_ids:
        q = q.where(Task.project_id.in_(project_ids))
    else:
        q = q.where(Task.project_id.in_(select(Project.id).where(Project.is_active.is_(True))))
    if dog_ids:
        q = q.where(Sample.dog_id.in_(dog_ids))
    if date_from is not None:
        q = q.where(Sample.session_date >= date_from)
    if date_to is not None:
        q = q.where(Sample.session_date <= date_to)
    return q


def _hz_of(s: Sample) -> int:
    return int(round(float(s.sample_hz or s.imu_sample_rate_hz or 0)))


async def summary(db: AsyncSession, project_ids: list[int] | None = None, dog_ids: list[int] | None = None,
                  date_from: date | None = None, date_to: date | None = None,
                  sample_hz: list[float] | None = None) -> dict:
    """池里有什么：总量、按类别 / 项目 / 狗 / 采样率的段数和时长，以及有多少是审核通过、多少是手动加入"""
    rows = (await db.execute(_base(project_ids, dog_ids, date_from, date_to).where(in_pool_cond()))).all()
    want_hz = {round(float(h)) for h in (sample_hz or [])}
    labels = {l.id: l for l in (await db.execute(select(LabelDefinition))).scalars().all()}
    projects = {p.id: p.name for p in (await db.execute(select(Project))).scalars().all()}
    dogs = {d.id: (d.name or d.dog_code) for d in (await db.execute(select(Dog))).scalars().all()}

    def root_name(lid: int) -> str:
        cur, seen = labels.get(lid), set()
        while cur is not None and cur.parent_id and cur.parent_id in labels and cur.id not in seen:
            seen.add(cur.id)
            cur = labels[cur.parent_id]
        return cur.display_name if cur else f"#{lid}"

    by = {k: defaultdict(lambda: [0, 0.0]) for k in ("label", "root", "project", "dog", "hz")}
    n = n_manual = 0
    sec_total = 0.0
    for it, task, smp in rows:
        hz = _hz_of(smp)
        if want_hz and hz not in want_hz:
            continue
        sec = max(0, it.end_time_ms - it.start_time_ms) / 1000
        n += 1
        sec_total += sec
        n_manual += it.pool_state == "in"
        lab = labels.get(it.label_id)
        for k, key in (("label", lab.display_name if lab else f"#{it.label_id}"), ("root", root_name(it.label_id)),
                       ("project", projects.get(task.project_id, f"#{task.project_id}")),
                       ("dog", dogs.get(smp.dog_id, "未关联") if smp.dog_id else "未关联"), ("hz", f"{hz}Hz")):
            by[k][key][0] += 1
            by[k][key][1] += sec

    def fmt(d):
        return sorted(({"name": k, "n": v[0], "hours": round(v[1] / 3600, 3)} for k, v in d.items()),
                      key=lambda x: -x["n"])

    return {"n": n, "hours": round(sec_total / 3600, 3), "n_manual": n_manual, "n_approved": n - n_manual,
            **{f"by_{k}": fmt(v) for k, v in by.items()}}


async def add(db: AsyncSession, source: str, project_ids: list[int] | None = None, dog_ids: list[int] | None = None,
              date_from: date | None = None, date_to: date | None = None) -> int:
    """整批手动加入。source：
      reviewed       人确认过 / 改过 / 人工加的片段（没人看过的纯 AI 片段不加）
      approved_tasks 审核通过的任务里的全部片段（任务整份认可过）
    返回新进池的条数。"""
    if source not in ("reviewed", "approved_tasks"):
        raise ValueError("source 只能是 reviewed / approved_tasks")
    it = AnnotationLabelItem
    q = _base(project_ids, dog_ids, date_from, date_to).where(~in_pool_cond())
    if source == "approved_tasks":
        q = q.where(Task.status == TaskStatus.APPROVED)
    else:
        q = q.where(or_(it.ai_confirmed.is_(True), it.is_modified.is_(True), it.source_type == LabelItemSource.human_added))
    # 逐条改 ORM 对象，不用批量 UPDATE：批量的不更新会话里已经载入的对象，紧接着的统计会读到旧值
    items = [row[0] for row in (await db.execute(q)).all()]
    for x in items:
        x.pool_state = "in"
    if items:
        await db.commit()
    return len(items)


async def _label_ids_under(db: AsyncSession, names: list[str]) -> set[int]:
    """名字在这几个里、或者上级链上有这几个名字的类别 id"""
    want = set(names)
    defs = {d.id: (d.display_name, d.parent_id) for d in (await db.execute(select(LabelDefinition))).scalars()}
    out: set[int] = set()
    for lid in defs:
        cur, hops = lid, 0
        while cur is not None and cur in defs and hops < 16:
            if defs[cur][0] in want:
                out.add(lid)
                break
            cur, hops = defs[cur][1], hops + 1
    return out


async def remove(db: AsyncSession, item_ids: list[int] | None = None, project_ids: list[int] | None = None,
                 dog_ids: list[int] | None = None, date_from: date | None = None, date_to: date | None = None,
                 label_ids: list[int] | None = None, label_names: list[str] | None = None) -> int:
    """手动移出（标成 out）。给了 item_ids 就只动这几条，否则按条件整批。
    label_names：按类别名移（含它底下的细类，各项目同名的都算）。返回移出的条数"""
    it = AnnotationLabelItem
    if label_names:
        ids = await _label_ids_under(db, label_names)
        label_ids = sorted(set(label_ids or []) | ids) if label_ids else sorted(ids)
        if not label_ids:
            return 0
    q = _base(project_ids, dog_ids, date_from, date_to).where(in_pool_cond())
    if item_ids:
        q = q.where(it.id.in_(item_ids))
    if label_ids:
        q = q.where(it.label_id.in_(label_ids))
    items = [row[0] for row in (await db.execute(q)).all()]
    for x in items:
        x.pool_state = "out"
    if items:
        await db.commit()
    return len(items)
