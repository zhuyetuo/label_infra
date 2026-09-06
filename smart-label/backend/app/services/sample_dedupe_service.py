"""
合并多 IMU 扫描 bug 留下的重复样本。

早期扫描器给"一个会话只看见 1 个 IMU"的情况生成不带 _imu{N} 后缀的样本编号
（multicam_20260820_230000996），后来同一会话又按 imu 编号各生成了一份带后缀的
（..._imu1/2/3/4），于是同一份 CSV 在 samples 表里出现两行。迁移 c7e2f1a9b3d4 只
把"改名后不撞名"的旧样本改了名，撞名的（也就是真重复的）留了下来。

这里把旧行并到带后缀的那一行上：
- 旧样本上的任务，如果那个项目在新样本上还没有任务 -> 整个挪过去（标注/审核记录挂在任务上，跟着走）
- 项目在新样本上已经有任务了 -> 两边都有活儿，不自动合并，报出来留给人工，这一行不删
- 切片记录（clip_jobs）同样挪过去；dog_id / 敏感标记 新行没有的从旧行补上
- 然后删掉旧样本行。NAS 上的文件一个都不碰（两行本来就指向同一份文件）

每次扫描结束都会自动跑一遍（幂等，没重复就什么都不做），也可以用
scripts/dedupe_samples.py 手动跑 / 只看不动。
"""

import re
from collections.abc import Callable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.clip import ClipJob
from app.models.sample import Sample
from app.models.task import Task

_SUFFIX_RE = re.compile(r"_imu\d+$", re.IGNORECASE)


async def merge_duplicate_samples(
    db: AsyncSession, apply: bool = True, log: Callable[[str], None] = print
) -> tuple[int, int]:
    """返回 (合并删除的旧样本数, 因两边都有任务而保留的旧样本数)。apply=False 只报告。"""
    tag = "[做]" if apply else "[将]"
    samples = (await db.execute(select(Sample))).scalars().all()
    by_csv: dict[str, list[Sample]] = {}
    for s in samples:
        by_csv.setdefault(s.imu_csv_path, []).append(s)

    merged = kept = 0
    for csv_path, group in sorted(by_csv.items()):
        if len(group) < 2:
            continue
        canon = [s for s in group if _SUFFIX_RE.search(s.sample_code)]
        dups = [s for s in group if not _SUFFIX_RE.search(s.sample_code)]
        if len(canon) != 1 or not dups:
            log(f"[跳过] {csv_path}：{[s.sample_code for s in group]} 形态不认识，人工看看")
            continue
        target = canon[0]
        for dup in dups:
            log(f"重复样本 {dup.sample_code} (#{dup.id}) -> {target.sample_code} (#{target.id})")
            dup_tasks = (await db.execute(select(Task).where(Task.sample_id == dup.id))).scalars().all()
            target_projects = set(
                (await db.execute(select(Task.project_id).where(Task.sample_id == target.id))).scalars().all()
            )
            blocked = [t for t in dup_tasks if t.project_id in target_projects]
            movable = [t for t in dup_tasks if t.project_id not in target_projects]
            for t in movable:
                log(f"  {tag} 任务 #{t.id}（项目 {t.project_id}，{t.status.value}）挪到新样本")
            for t in blocked:
                log(f"  [留] 任务 #{t.id}（项目 {t.project_id}，{t.status.value}）：新样本在同一项目已有任务，两边都有活儿，请人工处理")
            clips = (await db.execute(select(ClipJob.id).where(ClipJob.sample_id == dup.id))).scalars().all()
            if clips:
                log(f"  {tag} {len(clips)} 条切片记录挪到新样本")
            if blocked:
                log(f"  [留] 旧样本 #{dup.id} 不删（还挂着上面留下的任务）")
                kept += 1
                continue
            log(f"  {tag} 删除旧样本 #{dup.id}")
            merged += 1
            if not apply:
                continue
            if movable:
                await db.execute(update(Task).where(Task.id.in_([t.id for t in movable])).values(sample_id=target.id))
            if clips:
                await db.execute(update(ClipJob).where(ClipJob.id.in_(clips)).values(sample_id=target.id))
            if target.dog_id is None and dup.dog_id is not None:
                target.dog_id = dup.dog_id
            if not target.is_sensitive and dup.is_sensitive:
                target.is_sensitive = True
                target.sensitive_note = dup.sensitive_note
            await db.delete(dup)
    if apply:
        await db.commit()
    return merged, kept
