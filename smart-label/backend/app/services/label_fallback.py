"""项目一个标签都没有时，自动从别的项目克隆一套。

为什么要有：建项目时「标签模板」是可选的，没选就是空项目。空项目跑 AI 预标注，
模型输出的类别在项目里找不到同名标签，片段全被丢掉——任务里什么都没有，看上去像模型坏了
（2026-11-06：同一天的数据换模型另建了两个项目，都没套模板）。人工标注也一样没得选。

从哪克隆：
  1. 同源项目：名字去掉「 · 模型名」「-2」「 (2)」这类衍生后缀之后同名的那个
     （同一份数据换个模型再建一个项目，就该跟原来那个用同一套标签）；
  2. 否则：最近建的、有标签的项目。
"""
from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.label import LabelDefinition
from app.models.project import Project


def base_name(name: str) -> str:
    n = (name or "").strip()
    n = re.sub(r"\s*\(\d+\)$", "", n)
    n = n.split(" · ")[0].strip()
    # 日期名（2026-11-05）本身以 -05 结尾，只去掉日期后面再接的 -2
    m = re.match(r"^(.*?\d{4}-\d{1,2}-\d{1,2})(-\d+)?$", n)
    if m:
        return m.group(1)
    return re.sub(r"-\d+$", "", n)


async def _n_labels(db: AsyncSession, project_id: int) -> int:
    return int((await db.execute(
        select(func.count()).select_from(LabelDefinition).where(
            LabelDefinition.project_id == project_id, LabelDefinition.is_active.is_(True))
    )).scalar() or 0)


async def ensure_project_labels(db: AsyncSession, project: Project) -> str | None:
    """项目有标签就什么都不做，返回 None；没有就克隆一套，返回来源项目名。找不到可克隆的也返回 None"""
    from app.services.project_split_service import clone_labels

    if await _n_labels(db, project.id):
        return None
    base = base_name(project.name)
    src: Project | None = None
    if base and base != project.name:
        for p in (await db.execute(select(Project).where(Project.name == base, Project.id != project.id))).scalars():
            if await _n_labels(db, p.id):
                src = p
                break
    if src is None:
        for p in (await db.execute(
            select(Project).where(Project.id != project.id).order_by(Project.created_at.desc(), Project.id.desc()).limit(50)
        )).scalars():
            if await _n_labels(db, p.id):
                src = p
                break
    if src is None:
        return None
    await clone_labels(db, src.id, project.id, project.created_by)
    await db.flush()
    return src.name
