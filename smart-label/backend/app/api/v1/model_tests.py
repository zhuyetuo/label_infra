"""模型测试集接口（管理员）。说明见 services/model_test_service.py。"""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.model_test import ModelTestItem, ModelTestSet
from app.models.model_version import ModelTrainStatus, ModelVersion
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import model_test_service as svc

router = APIRouter(
    prefix="/model-tests",
    tags=["model-tests"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


class SetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    note: str | None = Field(default=None, max_length=500)


class ItemIn(BaseModel):
    task_id: int
    start_ms: int | None = None      # 都不给 = 整个任务
    end_ms: int | None = None
    note: str | None = Field(default=None, max_length=300)
    # 凑够多少秒：围绕起止前后各延长一半（碰到头尾往另一边补）。要先给起止
    pad_to_sec: float | None = Field(default=None, gt=0, le=3600)


class ItemsIn(BaseModel):
    items: list[ItemIn] = Field(min_length=1, max_length=2000)


class ComposeIn(BaseModel):
    """按条件挑：从已有的标注片段（人工标过的 / AI 预标的）里挑，凑窗口"""
    label_names: list[str] = Field(min_length=1)          # 类别（含细类：选「抓挠」就含抓挠-头颈耳…）
    sites: list[str] | None = None                        # 场地全称
    dog_ids: list[int] | None = None
    date_from: date | None = None
    date_to: date | None = None
    source: Literal["any", "human", "ai"] = "any"
    seen_mode: Literal["any", "unseen", "seen"] = "any"
    model_ids: list[int] | None = None
    per_group: int = Field(default=10, ge=1, le=500)      # 每只狗 × 每个细类最多几段
    max_total: int = Field(default=200, ge=1, le=3000)
    pad_sec: float = Field(default=60, ge=0, le=3600)
    min_sec: float = Field(default=0, ge=0, le=3600)      # 片段至少多长
    seed: int = 1


class CheckIn(BaseModel):
    checked: bool = True


async def _set_or_404(db: AsyncSession, set_id: int) -> ModelTestSet:
    s = await db.get(ModelTestSet, set_id)
    if s is None:
        raise HTTPException(404, "测试集不存在")
    return s


def _set_out(s: ModelTestSet, n_items: int = 0, n_samples: int = 0) -> dict:
    return {"id": s.id, "name": s.name, "note": s.note, "frozen": s.frozen_at is not None,
            "frozen_at": s.frozen_at.isoformat() if s.frozen_at else None,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "n_items": n_items, "n_samples": n_samples}


@router.get("/sets")
async def list_sets(db: AsyncSession = Depends(get_db)):
    sets = (await db.execute(select(ModelTestSet).order_by(ModelTestSet.id.desc()))).scalars().all()
    cnt = {sid: (n, m) for sid, n, m in (await db.execute(
        select(ModelTestItem.set_id, func.count(ModelTestItem.id), func.count(func.distinct(ModelTestItem.sample_id)))
        .group_by(ModelTestItem.set_id))).all()}
    excluded = len(await svc.test_sample_ids(db))
    return ok({"sets": [_set_out(s, *cnt.get(s.id, (0, 0))) for s in sets], "n_excluded_samples": excluded})


@router.post("/sets")
async def create_set(body: SetIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    name = body.name.strip()
    if (await db.execute(select(ModelTestSet.id).where(ModelTestSet.name == name))).first():
        raise HTTPException(400, "已经有同名的测试集")
    s = ModelTestSet(name=name, note=body.note, created_by=user.id)
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return ok(_set_out(s))


@router.post("/sets/{set_id}/freeze")
async def freeze_set(set_id: int, db: AsyncSession = Depends(get_db)):
    s = await _set_or_404(db, set_id)
    if s.frozen_at is None:
        s.frozen_at = datetime.now()
        await db.commit()
    return ok(_set_out(s))


@router.post("/sets/{set_id}/copy")
async def copy_set(set_id: int, body: SetIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """补数据：把一版（通常是冻结了的）原样复制成新的一版，在新版上继续加。"""
    src = await _set_or_404(db, set_id)
    name = body.name.strip()
    if (await db.execute(select(ModelTestSet.id).where(ModelTestSet.name == name))).first():
        raise HTTPException(400, "已经有同名的测试集")
    dst = ModelTestSet(name=name, note=body.note or f"从「{src.name}」复制", created_by=user.id)
    db.add(dst)
    await db.flush()
    for it in (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == src.id))).scalars().all():
        db.add(ModelTestItem(set_id=dst.id, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms,
                             end_ms=it.end_ms, note=it.note, added_by=user.id))
    await db.commit()
    await db.refresh(dst)
    return ok(_set_out(dst))


@router.get("/sets/{set_id}/items")
async def get_items(set_id: int, db: AsyncSession = Depends(get_db)):
    s = await _set_or_404(db, set_id)
    items = (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == set_id)
                              .order_by(ModelTestItem.id))).scalars().all()
    rows = await svc.describe_items(db, list(items))
    return ok({"set": _set_out(s, len(items), len({i.sample_id for i in items})),
               "items": rows, "coverage": svc.coverage(rows), "colors": await svc.label_colors(db)})


@router.delete("/sets/{set_id}")
async def delete_set(set_id: int, db: AsyncSession = Depends(get_db)):
    """删测试集：只删测试集和它的条目，任务、标注、疑似片段都不动。删了以后这些窗口不再挡训练导出"""
    s = await _set_or_404(db, set_id)
    items = (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == set_id))).scalars().all()
    for it in items:
        await db.delete(it)
    await db.flush()
    await db.delete(s)
    await db.commit()
    return ok({"deleted_items": len(items)})


@router.post("/sets/{set_id}/items")
async def add_items(set_id: int, body: ItemsIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能再加；要补数据请先复制成新版本")
    tasks = {t.id: t for t in (await db.execute(
        select(Task).where(Task.id.in_({x.task_id for x in body.items})))).scalars().all()}
    from app.models.sample import Sample
    dur_ms = {sid: (d or 0) * 1000 for sid, d in (await db.execute(
        select(Sample.id, Sample.video_duration_sec).where(Sample.id.in_({t.sample_id for t in tasks.values()})))).all()} if tasks else {}
    have = {(t, st) for t, st in (await db.execute(
        select(ModelTestItem.task_id, ModelTestItem.start_ms).where(ModelTestItem.set_id == set_id))).all()}
    added, skipped = 0, []
    for x in body.items:
        t = tasks.get(x.task_id)
        if t is None:
            skipped.append({"task_id": x.task_id, "reason": "任务不存在"})
            continue
        if (x.start_ms is None) != (x.end_ms is None) or (x.start_ms is not None and (x.start_ms < 0 or x.end_ms <= x.start_ms)):
            skipped.append({"task_id": x.task_id, "reason": "起止不对（要么都不给 = 整个任务，要么都给且结束晚于开始）"})
            continue
        if x.pad_to_sec:
            if x.start_ms is None:
                skipped.append({"task_id": x.task_id, "reason": "凑时长要先给起止"})
                continue
            lo = t.segment_start_ms or 0
            hi = t.segment_end_ms if t.segment_end_ms is not None else (dur_ms.get(t.sample_id) or None)
            x.start_ms, x.end_ms = svc.pad_window(x.start_ms, x.end_ms, int(x.pad_to_sec * 1000), lo, hi)
        if (x.task_id, x.start_ms) in have:
            skipped.append({"task_id": x.task_id, "reason": "已经在这个测试集里"})
            continue
        db.add(ModelTestItem(set_id=set_id, task_id=t.id, sample_id=t.sample_id, start_ms=x.start_ms,
                             end_ms=x.end_ms, note=x.note, added_by=user.id))
        have.add((x.task_id, x.start_ms))
        added += 1
    await db.commit()
    return ok({"added": added, "skipped": skipped})


@router.get("/label-tree")
async def get_label_tree(db: AsyncSession = Depends(get_db)):
    return ok(await svc.label_tree_names(db))


@router.post("/sets/{set_id}/compose/preview")
async def compose_preview(set_id: int, body: ComposeIn, db: AsyncSession = Depends(get_db)):
    """按条件挑：只看会挑出什么（配比），不写库"""
    await _set_or_404(db, set_id)
    r = await svc.compose(db, set_id=set_id, **body.model_dump())
    return ok({**r, "picks": r["picks"][:300]})


@router.post("/sets/{set_id}/compose")
async def compose_apply(set_id: int, body: ComposeIn, db: AsyncSession = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """按条件挑，加进测试集（挂在原任务上，窗口 = 片段凑够 N 秒）。同样的条件和种子，跟预览挑的一样"""
    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能再加；要补数据请先复制成新版本")
    r = await svc.compose(db, set_id=set_id, **body.model_dump())
    for p in r["picks"]:
        db.add(ModelTestItem(set_id=set_id, task_id=p["task_id"], sample_id=p["sample_id"], start_ms=p["start_ms"],
                             end_ms=p["end_ms"], added_by=user.id,
                             note=f"按条件挑·{p['label']}·{'人工标过' if p['human'] else 'AI 预标'}"))
    await db.commit()
    return ok({"added": len(r["picks"]), "stats": r["stats"], "warnings": r["warnings"]})


@router.post("/items/{item_id}/check")
async def check_item(item_id: int, body: CheckIn, db: AsyncSession = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """人工核对过这一段（看了窗口里的片段，该调的调了）/ 取消"""
    it = await db.get(ModelTestItem, item_id)
    if it is None:
        raise HTTPException(404, "不存在")
    if (await _set_or_404(db, it.set_id)).frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，核对状态不能再改")
    it.checked_by, it.checked_at = (user.id, datetime.now()) if body.checked else (None, None)
    await db.commit()
    return ok({"checked": body.checked})


@router.get("/task-segments")
async def get_task_segments(task_id: int, db: AsyncSession = Depends(get_db)):
    """挑事件：任务当前轮的标注片段"""
    if await db.get(Task, task_id) is None:
        raise HTTPException(404, "任务不存在")
    return ok(await svc.task_segments(db, task_id))


@router.delete("/items/{item_id}")
async def delete_item(item_id: int, db: AsyncSession = Depends(get_db)):
    it = await db.get(ModelTestItem, item_id)
    if it is None:
        raise HTTPException(404, "不存在")
    s = await _set_or_404(db, it.set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能删")
    await db.delete(it)
    await db.commit()
    return ok({"deleted": 1})


@router.get("/sets/{set_id}/seen")
async def seen(set_id: int, model_ids: str | None = None, db: AsyncSession = Depends(get_db)):
    """每个模型见没见过测试集里的每一段（样本在不在它的训练数据集导出里）。
    model_ids 逗号分隔；不给就列「上架的 + 最近 5 个训练完的」。"""
    await _set_or_404(db, set_id)
    q = select(ModelVersion).where(ModelVersion.status == ModelTrainStatus.done)
    if model_ids:
        ids = [int(x) for x in model_ids.split(",") if x.strip().isdigit()]
        mvs = (await db.execute(q.where(ModelVersion.id.in_(ids)).order_by(ModelVersion.id))).scalars().all()
    else:
        mvs = list((await db.execute(q.order_by(ModelVersion.id.desc()).limit(5))).scalars().all())
        mvs += [m for m in (await db.execute(q.where(ModelVersion.listed.is_(True)))).scalars().all()
                if m.id not in {x.id for x in mvs}]
        mvs.sort(key=lambda m: m.id)
    items = (await db.execute(
        select(ModelTestItem.id, ModelTestItem.sample_id).where(ModelTestItem.set_id == set_id))).all()
    from app.models.sample import Sample
    codes = dict((await db.execute(
        select(Sample.id, Sample.sample_code).where(Sample.id.in_({sid for _i, sid in items})))).all()) if items else {}
    out = []
    for m in mvs:
        names = svc.datasets_of_spec(m.dataset_spec)
        seen_codes: set[str] = set()
        missing = []
        for n in names:
            c = await asyncio.to_thread(svc.dataset_sample_codes, n)
            if c is None:
                missing.append(n)
            else:
                seen_codes |= c
        seen_ids = [iid for iid, sid in items if codes.get(sid) in seen_codes]
        out.append({"model_id": m.id, "algo_job_id": m.algo_job_id, "model_version": m.model_version, "listed": bool(m.listed),
                    "datasets": names, "missing_datasets": missing,
                    "n_seen": len(seen_ids), "n_unseen": len(items) - len(seen_ids), "seen_item_ids": seen_ids})
    return ok({"models": out, "n_items": len(items)})
