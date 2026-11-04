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
from dataclasses import dataclass
from datetime import date

from sqlalchemy import and_, case, func, or_, select
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


@dataclass
class PoolFilter:
    """池子的筛选条件（统计 / 列表 / 加入 / 移出共用）"""
    project_ids: list[int] | None = None
    dog_ids: list[int] | None = None
    date_from: date | None = None
    date_to: date | None = None
    task_ids: list[int] | None = None
    sample_hz: list[float] | None = None
    # 只要不短于这么多秒的片段
    min_sec: float | None = None
    # 类别名（含细类，各项目同名的都算）
    label_names: list[str] | None = None

    def any(self) -> bool:
        return bool(self.project_ids or self.dog_ids or self.task_ids or self.label_names
                    or self.date_from is not None or self.date_to is not None)


_DUR = AnnotationLabelItem.end_time_ms - AnnotationLabelItem.start_time_ms
_HZ = func.round(func.coalesce(Sample.sample_hz, Sample.imu_sample_rate_hz, 0))
# 名义采样率：设备实际报出来的是 51 / 53 / 57 / 61 / 66Hz 这种（蓝牙抖动），按精确值筛
# 「50Hz」几乎什么都对不上。归到最近的那一档：16 / 25 / 31.25（记成 31）/ 50
_NOMINAL_EDGES = ((20.5, 16), (28, 25), (40, 31))


def nominal_hz(hz: float) -> int:
    if hz <= 0:
        return 0          # 不知道采样率的，单独一档，不混进 16Hz
    for edge, v in _NOMINAL_EDGES:
        if hz < edge:
            return v
    return 50


_HZ_NOMINAL = case((_HZ <= 0, 0), *[(_HZ < edge, v) for edge, v in _NOMINAL_EDGES], else_=50)


async def _query(db: AsyncSession, f: PoolFilter):
    """当前这一轮的片段 + 任务 + 样本。不选项目也不选任务时只看启用的项目（拆分后的原项目停用了，不重复算）"""
    it = AnnotationLabelItem
    q = (select(it, Task, Sample)
         .join(AnnotationRecord, AnnotationRecord.id == it.annotation_record_id)
         .join(Task, and_(Task.id == AnnotationRecord.task_id, AnnotationRecord.round_no == Task.round_no))
         .join(Sample, Sample.id == Task.sample_id)
         .where(it.uncertain.is_(False)))
    if f.task_ids:
        q = q.where(Task.id.in_(f.task_ids))
    if f.project_ids:
        q = q.where(Task.project_id.in_(f.project_ids))
    elif not f.task_ids:
        q = q.where(Task.project_id.in_(select(Project.id).where(Project.is_active.is_(True))))
    if f.dog_ids:
        q = q.where(Sample.dog_id.in_(f.dog_ids))
    if f.date_from is not None:
        q = q.where(Sample.session_date >= f.date_from)
    if f.date_to is not None:
        q = q.where(Sample.session_date <= f.date_to)
    if f.sample_hz:
        q = q.where(_HZ_NOMINAL.in_([nominal_hz(float(h)) for h in f.sample_hz]))
    if f.min_sec:
        q = q.where(_DUR >= int(f.min_sec * 1000))
    if f.label_names:
        ids = await _label_ids_under(db, f.label_names)
        q = q.where(it.label_id.in_(ids or {-1}))
    return q


def _hz_of(s: Sample) -> int:
    return int(round(float(s.sample_hz or s.imu_sample_rate_hz or 0)))


async def summary(db: AsyncSession, f: PoolFilter) -> dict:
    """池里有什么：总量、按类别 / 项目 / 狗 / 采样率的段数和时长，以及有多少是审核通过、多少是手动加入"""
    rows = (await db.execute((await _query(db, f)).where(in_pool_cond()))).all()
    labels = {l.id: l for l in (await db.execute(select(LabelDefinition))).scalars().all()}
    projects = {p.id: p.name for p in (await db.execute(select(Project))).scalars().all()}
    dogs = {d.id: (d.name or d.dog_code) for d in (await db.execute(select(Dog))).scalars().all()}

    def root_name(lid: int) -> str:
        cur, seen = labels.get(lid), set()
        while cur is not None and cur.parent_id and cur.parent_id in labels and cur.id not in seen:
            seen.add(cur.id)
            cur = labels[cur.parent_id]
        return cur.display_name if cur else f"#{lid}"

    def chain_names(lid: int) -> list[str]:
        """根 → 叶的名字链：[抓挠, 抓挠-头颈耳, 抓挠-眼周/颊]"""
        out: list[str] = []
        cur, seen = labels.get(lid), set()
        while cur is not None and cur.id not in seen:
            seen.add(cur.id)
            out.append(cur.display_name)
            cur = labels.get(cur.parent_id) if cur.parent_id else None
        return out[::-1] or [f"#{lid}"]

    # 层级树：每一层都算上它底下所有细类（抓挠 41 段 = 自己标的 + 头颈耳 32 + 躯干 9）。
    # 按名字合（各项目各一套标签、id 不同，名字相同就是一类）
    tree: dict[str, list] = {}   # 名字 → [段数, 秒, 上级名字]
    # 项目 / 狗按 (id, 名字) 记：筛选下拉要拿 id；日期按样本的采集日（筛选下拉只列池里有的）
    by = {k: defaultdict(lambda: [0, 0.0]) for k in ("label", "root", "project", "dog", "hz", "date")}
    n = n_manual = 0
    sec_total = 0.0
    for it, task, smp in rows:
        hz = _hz_of(smp)
        sec = max(0, it.end_time_ms - it.start_time_ms) / 1000
        n += 1
        sec_total += sec
        n_manual += it.pool_state == "in"
        lab = labels.get(it.label_id)
        parent = None
        for nm in chain_names(it.label_id):
            node = tree.setdefault(nm, [0, 0.0, parent])
            node[0] += 1
            node[1] += sec
            parent = nm
        for k, key in (("label", lab.display_name if lab else f"#{it.label_id}"), ("root", root_name(it.label_id)),
                       ("project", (task.project_id, projects.get(task.project_id, f"#{task.project_id}"))),
                       ("dog", (smp.dog_id, dogs.get(smp.dog_id, "未关联")) if smp.dog_id else (None, "未关联")),
                       ("hz", f"{nominal_hz(hz)}Hz"),
                       ("date", smp.session_date.isoformat() if smp.session_date else "未知日期")):
            by[k][key][0] += 1
            by[k][key][1] += sec

    def fmt(d):
        def one(k, v):
            if isinstance(k, tuple):
                return {"id": k[0], "name": k[1], "n": v[0], "hours": round(v[1] / 3600, 3)}
            return {"name": k, "n": v[0], "hours": round(v[1] / 3600, 3)}
        return sorted((one(k, v) for k, v in d.items()), key=lambda x: -x["n"])

    return {"n": n, "hours": round(sec_total / 3600, 3), "n_manual": n_manual, "n_approved": n - n_manual,
            **{f"by_{k}": fmt(v) for k, v in by.items()},
            "tree": sorted(({"name": k, "parent": v[2], "n": v[0], "hours": round(v[1] / 3600, 3)} for k, v in tree.items()),
                           key=lambda x: -x["n"])}


ADD_SOURCES = ("reviewed", "approved_tasks", "submitted", "all")


async def add(db: AsyncSession, source: str, f: PoolFilter) -> int:
    """整批手动加入。source：
      reviewed       人确认过 / 改过 / 人工加的片段（没人看过的纯 AI 片段不加）
      approved_tasks 审核通过的任务里的全部片段
      submitted      已提交 / 审核通过的任务里的全部片段（标注员交了、你看过觉得行）
      all            全部片段（一般配 task_ids：这个任务我看过，整份认）
    返回新进池的条数。"""
    if source not in ADD_SOURCES:
        raise ValueError(f"source 只能是 {' / '.join(ADD_SOURCES)}")
    it = AnnotationLabelItem
    q = (await _query(db, f)).where(~in_pool_cond())
    if source == "approved_tasks":
        q = q.where(Task.status == TaskStatus.APPROVED)
    elif source == "submitted":
        q = q.where(Task.status.in_([TaskStatus.SUBMITTED, TaskStatus.APPROVED]))
    elif source == "reviewed":
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


async def remove(db: AsyncSession, f: PoolFilter, item_ids: list[int] | None = None) -> int:
    """手动移出（标成 out）。给了 item_ids 就只动这几条（再叠加条件），否则按条件整批。返回移出的条数"""
    q = (await _query(db, f)).where(in_pool_cond())
    if item_ids:
        q = q.where(AnnotationLabelItem.id.in_(item_ids))
    items = [row[0] for row in (await db.execute(q)).all()]
    for x in items:
        x.pool_state = "out"
    if items:
        await db.commit()
    return len(items)


async def list_items(db: AsyncSession, f: PoolFilter, sort: str = "long", page: int = 1, page_size: int = 50) -> dict:
    """池里一条一条的片段。sort：long = 最长的先 / short / new = 最近日期先 / time = 按任务、时间"""
    it = AnnotationLabelItem
    q = (await _query(db, f)).where(in_pool_cond())
    total = (await db.execute(select(func.count()).select_from(q.with_only_columns(it.id).subquery()))).scalar_one()
    order = {
        "long": (_DUR.desc(), it.id),
        "short": (_DUR.asc(), it.id),
        "new": (Sample.session_date.desc(), Task.id.desc(), it.start_time_ms),
    }.get(sort, (Task.id, it.start_time_ms))
    page_size = max(1, min(page_size, 500))
    rows = (await db.execute(q.order_by(*order).offset((max(1, page) - 1) * page_size).limit(page_size))).all()
    labels = {l.id: l.display_name for l in (await db.execute(select(LabelDefinition))).scalars().all()}
    projects = {p.id: p.name for p in (await db.execute(select(Project))).scalars().all()}
    dog_ids = {smp.dog_id for _, _, smp in rows if smp.dog_id}
    dogs = ({d.id: (d.name or d.dog_code) for d in (await db.execute(select(Dog).where(Dog.id.in_(dog_ids)))).scalars()}
            if dog_ids else {})
    return {"total": int(total), "items": [{
        "id": x.id,
        "task_id": t.id,
        "project_id": t.project_id,
        "project_name": projects.get(t.project_id, f"#{t.project_id}"),
        "sample_code": smp.sample_code,
        "session_date": smp.session_date.isoformat() if smp.session_date else None,
        "dog_name": dogs.get(smp.dog_id) if smp.dog_id else None,
        "hz": _hz_of(smp),
        "label_id": x.label_id,
        "label_name": labels.get(x.label_id, f"#{x.label_id}"),
        "start_time_ms": x.start_time_ms,
        "end_time_ms": x.end_time_ms,
        # manual = 手动加入的；approved = 片段审核通过进来的
        "via": "manual" if x.pool_state == "in" else "approved",
    } for x, t, smp in rows]}
