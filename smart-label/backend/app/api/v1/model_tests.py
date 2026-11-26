"""模型测试集接口（管理员）。说明见 services/model_test_service.py。"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.audit_log import AuditLog
from app.models.model_test import ModelTestItem, ModelTestSet
from app.models.model_version import ModelTrainStatus, ModelVersion
from app.models.task import Task, TaskStatus
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
    # positive = 有这类（以这类片段为中心）；negative = 无这类（整个窗口里这类一次都没有）
    mode: Literal["positive", "negative"] = "positive"
    # 无这类时以哪类片段为中心（比如相似动作 舔 / 甩头，或 活动 / 休息）；不给 = 任何别的类别
    anchor_names: list[str] | None = None
    per_dog: int | None = Field(default=None, ge=1, le=3000)   # 每只狗最多几段
    exclude_unclear: bool = True   # 自动过滤画面看不清/遮挡（备忘=unclear 或待定）


class CheckIn(BaseModel):
    checked: bool = True


class PlanDogIn(BaseModel):
    dog_id: int
    q: dict[str, list[int]] = {}          # {"60": [有, 无], "600": [有, 无]}
    p: dict[str, int] = {}                # {部位: 段数}（有这类各时长合计）


class NegCatIn(BaseModel):
    """「无这类」窗口的一个分类：以哪些片段为中心、占多少比例"""
    name: str
    anchors: list[str]
    ratio: float = Field(default=1, ge=0)
    # 分类内各中心动作的比例（如 舔 40 / 啃 20 / 蹭 20 / 甩头 20）；不填 = 不分，几类混着挑
    anchor_ratios: dict[str, float] | None = None


class PlanIn(BaseModel):
    """选样计划：每只狗 × 时长 × 有/无 × 部位；「无」再按分类摊"""
    target: str = "抓挠"
    durations: list[int] = [60, 120, 180]
    parts: list[str] = []
    anchor_names: list[str] | None = None
    neg_cats: list[NegCatIn] | None = None
    # 按比例自动配用的比例（前端用，后端只存）
    alloc: dict | None = None
    dogs: list[PlanDogIn] = []
    date_from: date | None = None
    date_to: date | None = None
    source: Literal["any", "human", "ai"] = "any"
    seen_mode: Literal["any", "unseen", "seen"] = "any"
    model_ids: list[int] | None = None
    seed: int = 1
    exclude_unclear: bool = True   # 自动过滤画面看不清/遮挡（备忘=unclear 或待定）


async def _set_or_404(db: AsyncSession, set_id: int) -> ModelTestSet:
    s = await db.get(ModelTestSet, set_id)
    if s is None:
        raise HTTPException(404, "测试集不存在")
    return s


def _is_demo_set(s: ModelTestSet) -> bool:
    note = s.note or ""
    return s.name == "测试集 v1" or s.name.startswith("测试集·") or "片段备注里【训练用过】" in note


def _set_out(
    s: ModelTestSet,
    n_items: int = 0,
    n_samples: int = 0,
    *,
    n_checked: int = 0,
    creator_name: str | None = None,
    n_seen: int = 0,
    n_unseen: int = 0,
    seen_ref: str | None = None,
) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "note": s.note,
        "frozen": s.frozen_at is not None,
        "frozen_at": s.frozen_at.isoformat() if s.frozen_at else None,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "created_by": s.created_by,
        "creator_name": creator_name,
        "is_demo": _is_demo_set(s),
        "n_items": n_items,
        "n_samples": n_samples,
        "n_checked": n_checked,
        "n_seen": n_seen,
        "n_unseen": n_unseen,
        "seen_ref": seen_ref,
    }


@router.get("/sets")
async def list_sets(db: AsyncSession = Depends(get_db)):
    import asyncio
    from sqlalchemy import case
    from app.models.model_version import ModelVersion
    from app.models.sample import Sample

    sets = (await db.execute(select(ModelTestSet).order_by(ModelTestSet.id.desc()))).scalars().all()
    cnt = {
        sid: (int(n), int(m), int(chk or 0))
        for sid, n, m, chk in (await db.execute(
            select(
                ModelTestItem.set_id,
                func.count(ModelTestItem.id),
                func.count(func.distinct(ModelTestItem.sample_id)),
                func.sum(case((ModelTestItem.checked_at.is_not(None), 1), else_=0)),
            ).group_by(ModelTestItem.set_id)
        )).all()
    }
    uids = {s.created_by for s in sets if s.created_by is not None}
    users = {
        uid: (dn or un)
        for uid, un, dn in (await db.execute(
            select(User.id, User.username, User.display_name).where(User.id.in_(uids))
        )).all()
    } if uids else {}

    # 相对最新一条带数据集的训练模型，快速统计每个测试集「见过 / 没见过」条数（dataset_sample_codes 已有内存 mtime 缓存）
    seen_ref: str | None = None
    ref_codes: frozenset[str] = frozenset()
    mvs = (await db.execute(
        select(ModelVersion).where(ModelVersion.dataset_spec.is_not(None)).order_by(ModelVersion.id.desc()).limit(20)
    )).scalars().all()
    for mv in mvs:
        ds_names = svc.datasets_of_spec(mv.dataset_spec)
        if not ds_names:
            continue
        merged: set[str] = set()
        for dn in ds_names:
            c = await asyncio.to_thread(svc.dataset_sample_codes, dn)
            if c:
                merged |= c
        if merged:
            ref_codes = frozenset(merged)
            seen_ref = f"#{mv.id}"
            break

    seen_by_set: dict[int, tuple[int, int]] = {}
    if seen_ref and sets:
        item_rows = (await db.execute(
            select(ModelTestItem.set_id, Sample.sample_code)
            .join(Sample, Sample.id == ModelTestItem.sample_id)
        )).all()
        tmp: dict[int, list[int]] = {}
        for sid, scode in item_rows:
            pair = tmp.setdefault(sid, [0, 0])
            if scode and scode in ref_codes:
                pair[0] += 1
            else:
                pair[1] += 1
        seen_by_set = {sid: (a, b) for sid, (a, b) in tmp.items()}

    excluded = len(await svc.test_sample_ids(db))
    out_sets = []
    for s in sets:
        n_it, n_sm, n_chk = cnt.get(s.id, (0, 0, 0))
        n_s, n_u = seen_by_set.get(s.id, (0, n_it if seen_ref else 0))
        out_sets.append(_set_out(
            s, n_it, n_sm,
            n_checked=n_chk,
            creator_name=users.get(s.created_by) if s.created_by is not None else None,
            n_seen=n_s,
            n_unseen=n_u,
            seen_ref=seen_ref,
        ))
    return ok({"sets": out_sets, "n_excluded_samples": excluded})


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


class SetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    note: str | None = Field(default=None, max_length=500)


@router.patch("/sets/{set_id}")
async def update_set(set_id: int, body: SetPatch, db: AsyncSession = Depends(get_db)):
    """改名字 / 备注（冻结了也能改：不影响里面的片段）"""
    s = await _set_or_404(db, set_id)
    if body.name is not None:
        name = body.name.strip()
        if name != s.name and (await db.execute(select(ModelTestSet.id).where(ModelTestSet.name == name))).first():
            raise HTTPException(400, "已经有同名的测试集")
        s.name = name
    if body.note is not None:
        s.note = body.note.strip() or None
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
    dst = ModelTestSet(name=name, note=body.note or f"从「{src.name}」复制", created_by=user.id, plan=src.plan)
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
    import json
    try:
        plan = json.loads(s.plan) if s.plan else None
    except ValueError:
        plan = None
    return ok({"set": {**_set_out(s, len(items), len({i.sample_id for i in items})), "plan": plan},
               "items": rows, "coverage": svc.coverage(rows), "colors": await svc.label_colors(db)})


@router.delete("/sets/{set_id}")
async def delete_set(set_id: int, db: AsyncSession = Depends(get_db)):
    """删测试集：只删测试集和它的条目，任务、标注、疑似片段都不动。删了以后这些窗口不再挡训练导出"""
    from app.services.model_eval_service import remove_test_set_run
    s = await _set_or_404(db, set_id)
    items = (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == set_id))).scalars().all()
    for it in items:
        await db.delete(it)
    await db.flush()
    await db.delete(s)
    await db.commit()
    await remove_test_set_run(db, set_id)
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
    added_items: list[ModelTestItem] = []
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
        item = ModelTestItem(set_id=set_id, task_id=t.id, sample_id=t.sample_id, start_ms=x.start_ms,
                             end_ms=x.end_ms, note=x.note, added_by=user.id)
        db.add(item)
        added_items.append(item)
        have.add((x.task_id, x.start_ms))
        added += 1
    if added_items:
        from app.services import test_pool
        await test_pool.inherit_checked_from_pool(db, added_items)
        for it in added_items:
            await test_pool.sync_window_to_test_pool(
                db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
                user_id=user.id, checked=None, checked_by=it.checked_by, checked_at=it.checked_at,
                note=it.note, source_set_id=set_id,
            )
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
    created: list[ModelTestItem] = []
    for p in r["picks"]:
        it = ModelTestItem(set_id=set_id, task_id=p["task_id"], sample_id=p["sample_id"], start_ms=p["start_ms"],
                           end_ms=p["end_ms"], added_by=user.id,
                           note=(f"按条件挑·{p['label']}" + (f"（以{p['anchor']}为中心）" if p.get("anchor") else "")
                                 + f"·{round((p['end_ms'] - p['start_ms']) / 60000, 1)}分钟·{'人工标过' if p['human'] else 'AI 预标'}")[:300])
        db.add(it)
        created.append(it)
    if created:
        from app.services import test_pool
        await test_pool.inherit_checked_from_pool(db, created)
        for it in created:
            await test_pool.sync_window_to_test_pool(
                db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
                user_id=user.id, checked=None, checked_by=it.checked_by, checked_at=it.checked_at,
                note=it.note, source_set_id=set_id,
            )
    await db.commit()
    return ok({"added": len(r["picks"]), "stats": r["stats"], "warnings": r["warnings"]})


@router.post("/plan/availability")
async def plan_availability(body: PlanIn, db: AsyncSession = Depends(get_db)):
    """每只狗在条件范围里有多少这类片段（按细类）"""
    return ok(await svc.plan_availability(db, body.model_dump()))


def _plan_summary(r: dict) -> dict:
    return {k: v for k, v in r.items() if k != "picks"}


@router.post("/sets/{set_id}/plan/preview")
async def plan_preview(set_id: int, body: PlanIn, db: AsyncSession = Depends(get_db)):
    """按计划试挑：每只狗每格能挑到几段（不写库）"""
    await _set_or_404(db, set_id)
    # 生成是「删掉原有的重新挑」，所以检查时也不避开这个测试集已有的窗口
    return ok(_plan_summary(await svc.plan_run(db, None, body.model_dump())))


@router.post("/sets/{set_id}/plan/save")
async def plan_save(set_id: int, body: PlanIn, db: AsyncSession = Depends(get_db)):
    """只存计划，不挑"""
    import json
    s = await _set_or_404(db, set_id)
    s.plan = json.dumps(body.model_dump(mode="json"), ensure_ascii=False)
    await db.commit()
    return ok({"saved": True})


@router.post("/sets/{set_id}/plan/apply")
async def plan_apply(set_id: int, body: PlanIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """按计划挑，加进测试集，并存下计划"""
    import json
    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能再加；要补数据请先复制成新版本")
    # 重新生成：先同步原条目到测试数据池（保留已核对记录），再删掉本测试集原有条目，最后按配比重新挑
    from app.services import test_pool
    old = (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == set_id))).scalars().all()
    for it in old:
        await test_pool.sync_window_to_test_pool(
            db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
            user_id=user.id, checked=(it.checked_at is not None), checked_by=it.checked_by, checked_at=it.checked_at,
            note=it.note, source_set_id=set_id,
        )
        await db.delete(it)
    await db.flush()
    r = await svc.plan_run(db, set_id, body.model_dump())
    created: list[ModelTestItem] = []
    for p in r["picks"]:
        c = p["cell"]
        note = f"选样·{round(c['dur'] / 60, 1):g}分钟·{c['kind']}{body.target}" + (f"·{c['part']}" if c.get("part") else "") \
            + (f"·{c['cat']}" if c.get("cat") else "") \
            + (f"·以{p['anchor']}为中心" if p.get("anchor") else "") + f"·{'人工标过' if p['human'] else 'AI 预标'}"
        it = ModelTestItem(set_id=set_id, task_id=p["task_id"], sample_id=p["sample_id"], start_ms=p["start_ms"],
                           end_ms=p["end_ms"], added_by=user.id, note=note[:300])
        db.add(it)
        created.append(it)
    if created:
        from app.services import test_pool
        await test_pool.inherit_checked_from_pool(db, created)
        for it in created:
            await test_pool.sync_window_to_test_pool(
                db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
                user_id=user.id, checked=None, checked_by=it.checked_by, checked_at=it.checked_at,
                note=it.note, source_set_id=set_id,
            )
    s.plan = json.dumps(body.model_dump(mode="json"), ensure_ascii=False)
    await db.commit()
    return ok({"added": len(r["picks"]), "removed": len(old), **_plan_summary(r)})


@router.post("/items/{item_id}/check")
async def check_item(item_id: int, body: CheckIn, db: AsyncSession = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """人工核对过这一段（看了窗口里的片段，该调的调了）/ 取消；同步沉淀进测试数据池"""
    from app.services import test_pool

    it = await db.get(ModelTestItem, item_id)
    if it is None:
        raise HTTPException(404, "不存在")
    if (await _set_or_404(db, it.set_id)).frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，核对状态不能再改")
    now = datetime.now()
    it.checked_by, it.checked_at = (user.id, now) if body.checked else (None, None)
    await test_pool.sync_window_to_test_pool(
        db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
        user_id=user.id, checked=body.checked, checked_by=it.checked_by, checked_at=it.checked_at,
        note=it.note, source_set_id=it.set_id,
    )
    await db.commit()
    return ok({"checked": body.checked})


@router.post("/sets/{set_id}/check-all")
async def check_all_items(set_id: int, body: CheckIn, db: AsyncSession = Depends(get_db),
                          user: User = Depends(get_current_user)):
    """一键全部核对通过 / 取消全部核对（只改测试集核对状态，同步沉淀进测试数据池）"""
    from app.services import test_pool

    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，核对状态不能再改")
    items = (await db.execute(select(ModelTestItem).where(ModelTestItem.set_id == set_id))).scalars().all()
    now = datetime.now()
    for it in items:
        it.checked_by, it.checked_at = (user.id, now) if body.checked else (None, None)
        await test_pool.sync_window_to_test_pool(
            db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
            user_id=user.id, checked=body.checked, checked_by=it.checked_by, checked_at=it.checked_at,
            note=it.note, source_set_id=set_id,
        )
    await db.commit()
    return ok({"updated": len(items), "checked": body.checked})


@router.get("/task-segments")
async def get_task_segments(task_id: int, db: AsyncSession = Depends(get_db)):
    """挑事件：任务当前轮的标注片段"""
    if await db.get(Task, task_id) is None:
        raise HTTPException(404, "任务不存在")
    return ok(await svc.task_segments(db, task_id))


@router.delete("/items/{item_id}")
async def delete_item(item_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """从测试集移出单条窗口：先沉淀到测试数据池（保留已核对与原任务标注），方便后续其他测试集直接续用。"""
    from app.services import test_pool

    it = await db.get(ModelTestItem, item_id)
    if it is None:
        raise HTTPException(404, "不存在")
    s = await _set_or_404(db, it.set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能删")
    await test_pool.sync_window_to_test_pool(
        db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
        user_id=getattr(user, "id", None), checked=(it.checked_at is not None), checked_by=it.checked_by, checked_at=it.checked_at,
        note=it.note, source_set_id=it.set_id,
    )
    await db.delete(it)
    await db.commit()
    return ok({"deleted": 1, "preserved_in_pool": 1})


class BatchRemoveIn(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=2000)


@router.post("/sets/{set_id}/items/remove")
async def batch_remove_items(
    set_id: int,
    body: BatchRemoveIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """批量从测试集移出窗口（如剔除整个场地），同时把这些窗口（含已核对状态与原标注）保留在测试数据池，后续其他测试集复用可继续续上。"""
    from app.services import test_pool

    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能移出")
    items = (await db.execute(
        select(ModelTestItem).where(ModelTestItem.set_id == set_id, ModelTestItem.id.in_(body.item_ids))
    )).scalars().all()
    if not items:
        return ok({"removed": 0, "preserved_in_pool": 0})
    for it in items:
        await test_pool.sync_window_to_test_pool(
            db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
            user_id=user.id, checked=(it.checked_at is not None), checked_by=it.checked_by, checked_at=it.checked_at,
            note=it.note, source_set_id=set_id,
        )
        await db.delete(it)
    await db.commit()
    return ok({"removed": len(items), "preserved_in_pool": len(items)})


class SetCleanIn(BaseModel):
    item_ids: list[int] | None = None
    max_gap_ms: int = Field(default=1500, ge=0, le=10000)


@router.post("/sets/{set_id}/dedupe")
async def dedupe_test_set(
    set_id: int,
    body: SetCleanIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """对整个测试集（或勾选/单个片段）一键去重：同类重叠合并、父子细类压粗类、行为/活动挖空静止。"""
    from app.api.v1.segment_review import _dedupe_task

    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能修改")
    q = select(ModelTestItem).where(ModelTestItem.set_id == set_id)
    if body.item_ids:
        q = q.where(ModelTestItem.id.in_(body.item_ids))
    items = (await db.execute(q)).scalars().all()
    if not items:
        return ok({"tasks_cleaned": 0, "removed": 0, "carved": 0, "conflicts": 0})
    tids = list(dict.fromkeys(it.task_id for it in items))
    tasks = {t.id: t for t in (await db.execute(select(Task).where(Task.id.in_(tids)))).scalars().all()}
    total_removed = 0
    total_carved = 0
    total_conflicts = 0
    tasks_cleaned = 0
    for tid in tids:
        t = tasks.get(tid)
        if t is None:
            continue
        r = await _dedupe_task(db, t, user, approve=False)
        rem = int(r.get("removed", 0))
        crv = int(r.get("carved", 0))
        if rem or crv:
            tasks_cleaned += 1
        total_removed += rem
        total_carved += crv
        total_conflicts += int(r.get("conflicts", 0))
    await db.commit()
    return ok({
        "tasks_cleaned": tasks_cleaned,
        "removed": total_removed,
        "carved": total_carved,
        "conflicts": total_conflicts,
    })


@router.post("/sets/{set_id}/merge-adjacent")
async def merge_adjacent_test_set(
    set_id: int,
    body: SetCleanIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """对整个测试集（或勾选/单个窗口）一键合并窗口内相邻同类片段（间隔 ≤ max_gap_ms）。"""
    from collections import defaultdict
    from app.models.ai_candidate import AiCandidate, CandidateStatus
    from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
    from app.models.label import LabelDefinition
    from app.services.label_tracks import track_of as _track_of
    from app.services.task_service import _append_boundary_edit

    s = await _set_or_404(db, set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，不能修改")
    q = select(ModelTestItem).where(ModelTestItem.set_id == set_id)
    if body.item_ids:
        q = q.where(ModelTestItem.id.in_(body.item_ids))
    items = (await db.execute(q)).scalars().all()
    if not items:
        return ok({"groups_merged": 0, "removed": 0, "windows_cleaned": 0})

    lrows = (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name, LabelDefinition.parent_id, LabelDefinition.track))).all()
    lname = {i: n for i, n, _p, _tr in lrows}
    parent = {i: p for i, _n, p, _tr in lrows}
    own_track = {i: tr for i, _n, _p, tr in lrows}
    ltrack = {i: _track_of(parent, own_track, i, lname) for i, _n, _p, _tr in lrows}

    tids = list(dict.fromkeys(it.task_id for it in items))
    segs_all = (await db.execute(
        select(AnnotationRecord.task_id, AnnotationLabelItem)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(tids), AnnotationRecord.round_no == Task.round_no)
    )).all()
    segs_by_task: dict[int, list[AnnotationLabelItem]] = defaultdict(list)
    for tid, seg in segs_all:
        segs_by_task[tid].append(seg)

    def rank(x: AnnotationLabelItem):
        human = bool(x.ai_confirmed or x.is_modified or x.source_type == LabelItemSource.human_added)
        return (x.seg_status == "approved", human, x.end_time_ms - x.start_time_ms, -x.id)

    now = datetime.now()
    deleted_ids: set[int] = set()
    cand_to_reject: set[int] = set()
    groups_merged = 0
    removed = 0
    windows_cleaned = 0

    for it in items:
        ws = it.start_ms if it.start_ms is not None else 0
        we = it.end_ms if it.end_ms is not None else 10 ** 12
        win_segs = [
            seg for seg in segs_by_task.get(it.task_id, [])
            if seg.id not in deleted_ids and not seg.uncertain and seg.end_time_ms > ws and seg.start_time_ms < we
        ]
        by_lid: dict[int, list[AnnotationLabelItem]] = defaultdict(list)
        for seg in win_segs:
            by_lid[seg.label_id].append(seg)

        def _blocks_merge(my_lid: int, my_tr: str | None, gap_lo: int, gap_hi: int) -> bool:
            if gap_hi <= gap_lo:
                return False
            for o in win_segs:
                if o.id in deleted_ids or o.label_id == my_lid:
                    continue
                if min(o.end_time_ms, gap_hi) <= max(o.start_time_ms, gap_lo):
                    continue
                o_tr = ltrack.get(o.label_id)
                if (my_tr is not None and o_tr == my_tr) or (my_tr == "motion" and o_tr == "behavior") or (my_tr == "behavior" and o_tr == "motion"):
                    return True
            return False

        win_merged = 0
        for lid, arr in by_lid.items():
            if len(arr) < 2:
                continue
            arr.sort(key=lambda x: (x.start_time_ms, x.end_time_ms))
            my_tr = ltrack.get(lid)
            cur_grp = [arr[0]]
            groups: list[list[AnnotationLabelItem]] = []
            for nxt in arr[1:]:
                gap_lo, gap_hi = cur_grp[-1].end_time_ms, nxt.start_time_ms
                gap = gap_hi - gap_lo
                if 0 <= gap <= body.max_gap_ms and not _blocks_merge(lid, my_tr, gap_lo, gap_hi):
                    cur_grp.append(nxt)
                else:
                    if len(cur_grp) >= 2:
                        groups.append(cur_grp)
                    cur_grp = [nxt]
            if len(cur_grp) >= 2:
                groups.append(cur_grp)

            for grp in groups:
                keeper = max(grp, key=rank)
                old = (keeper.start_time_ms, keeper.end_time_ms)
                keeper.start_time_ms = min(x.start_time_ms for x in grp)
                keeper.end_time_ms = max(x.end_time_ms for x in grp)
                if all(x.seg_status == "approved" for x in grp):
                    keeper.seg_status = "approved"
                if (keeper.start_time_ms, keeper.end_time_ms) != old:
                    keeper.boundary_edits = _append_boundary_edit(
                        keeper.boundary_edits, old, (keeper.start_time_ms, keeper.end_time_ms), user
                    )
                    if keeper.source_type == LabelItemSource.ai_generated:
                        keeper.is_modified = True
                    keeper.touched_at, keeper.touched_by = now, user.id
                for x in grp:
                    if x is keeper:
                        continue
                    deleted_ids.add(x.id)
                    await db.delete(x)
                    removed += 1
                    if x.from_candidate_id is not None:
                        if keeper.from_candidate_id is None:
                            keeper.from_candidate_id = x.from_candidate_id
                        else:
                            cand_to_reject.add(x.from_candidate_id)
                groups_merged += 1
                win_merged += 1
        if win_merged:
            windows_cleaned += 1

    for cid in cand_to_reject:
        cand = await db.get(AiCandidate, cid)
        if cand is not None and cand.status == CandidateStatus.confirmed:
            cand.status = CandidateStatus.rejected
            cand.decided_by, cand.decided_at = user.id, now
    await db.commit()
    return ok({"groups_merged": groups_merged, "removed": removed, "windows_cleaned": windows_cleaned})


class PromoteIn(BaseModel):
    # 如果打开前原任务本身是 APPROVED、管理员点「继续编辑」临时解锁修改，完成后恢复回 APPROVED
    restore_approved: bool = False


@router.post("/items/{item_id}/promote-to-pool")
async def promote_item_to_pool(
    item_id: int,
    body: PromoteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """纠偏完成后：将本测试窗口内标注视为人工审核通过并直接入数据池，同时从当前测试集剥离"""
    it = await db.get(ModelTestItem, item_id)
    if it is None:
        raise HTTPException(404, "测试集片段不存在")
    s = await _set_or_404(db, it.set_id)
    if s.frozen_at is not None:
        raise HTTPException(400, "这一版已冻结，无法剥离片段；请先复制成新版本再操作")

    task = await db.get(Task, it.task_id)
    now = datetime.now()
    segs: list[AnnotationLabelItem] = []
    if task is not None:
        rec = (await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task.id,
                AnnotationRecord.round_no == task.round_no,
            )
        )).scalar_one_or_none()
        if rec is not None:
            q = select(AnnotationLabelItem).where(
                AnnotationLabelItem.annotation_record_id == rec.id,
                AnnotationLabelItem.uncertain.is_(False),
            )
            if it.start_ms is not None and it.end_ms is not None:
                q = q.where(
                    AnnotationLabelItem.start_time_ms < it.end_ms,
                    AnnotationLabelItem.end_time_ms > it.start_ms,
                )
            segs = list((await db.execute(q)).scalars().all())
            for seg in segs:
                seg.seg_status = "approved"
                seg.seg_reviewed_by = user.id
                seg.seg_reviewed_at = now
                seg.review_note = seg.review_flag_by = seg.review_flag_at = None
                seg.seg_claimed_by = seg.seg_claim_expires_at = None
                if seg.source_type == LabelItemSource.ai_generated and not seg.is_modified:
                    seg.ai_confirmed = True
                seg.pool_state = "in"
                seg.pool_at = now
                seg.pool_review = "in"
                seg.pool_review_by = user.id
                seg.pool_review_at = now
                seg.touched_at = now
                seg.touched_by = user.id
        if body.restore_approved and task.status == TaskStatus.IN_PROGRESS:
            task.status = TaskStatus.APPROVED
            task.locked_by = None
            task.lock_expires_at = None

    sample_id, task_id, start_ms, end_ms, set_id = it.sample_id, it.task_id, it.start_ms, it.end_ms, it.set_id
    # 同步把测试数据池里对应窗口标记为 moved_to_train（解除测试隔离）
    from app.services import test_pool
    w = await test_pool.sync_window_to_test_pool(
        db, task_id=task_id, sample_id=sample_id, start_ms=start_ms, end_ms=end_ms,
        user_id=user.id, checked=True, note=it.note, source_set_id=set_id,
    )
    w.status = "moved_to_train"
    w.moved_by = user.id
    w.moved_at = now
    await db.delete(it)
    await db.flush()

    # 检查其他测试集是否仍包含同一/重叠时段（训练导出会排除所有测试集的窗口，需如实告知用户）
    other_rows = (await db.execute(
        select(ModelTestSet.name, ModelTestItem.start_ms, ModelTestItem.end_ms)
        .join(ModelTestSet, ModelTestSet.id == ModelTestItem.set_id)
        .where(ModelTestItem.sample_id == sample_id, ModelTestItem.set_id != set_id)
    )).all()
    still_in_other_sets: list[str] = []
    for sname, os_ms, oe_ms in other_rows:
        overlaps = (
            start_ms is None or end_ms is None or os_ms is None or oe_ms is None
            or (os_ms < end_ms and oe_ms > start_ms)
        )
        if overlaps and sname not in still_in_other_sets:
            still_in_other_sets.append(sname)

    db.add(AuditLog(
        user_id=user.id,
        action="model_test.promote_to_pool",
        target_type="model_test_set",
        target_id=set_id,
        detail=json.dumps({
            "item_id": item_id,
            "task_id": task_id,
            "sample_id": sample_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "n_pooled": len(segs),
            "restore_approved": body.restore_approved,
        }, ensure_ascii=False),
    ))
    await db.commit()
    return ok({"n_pooled": len(segs), "removed": 1, "still_in_other_sets": still_in_other_sets})


class BatchPromoteIn(BaseModel):
    item_ids: list[int]


@router.post("/items/batch-promote")
async def batch_promote_items_to_pool(
    body: BatchPromoteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """批量把测试集里勾选的窗口拨到训练数据池（同时从所有未冻结测试集移出并解除测试隔离）"""
    from app.services import test_pool

    if not body.item_ids:
        raise HTTPException(422, "请先勾选要拨到训练数据池的片段")
    items = (await db.execute(select(ModelTestItem).where(ModelTestItem.id.in_(body.item_ids)))).scalars().all()
    if not items:
        return ok({"moved_windows": 0, "pooled_segments": 0, "removed_from_sets": 0})
    w_ids: list[int] = []
    for it in items:
        w = await test_pool.sync_window_to_test_pool(
            db, task_id=it.task_id, sample_id=it.sample_id, start_ms=it.start_ms, end_ms=it.end_ms,
            user_id=user.id, checked=True if it.checked_at else None,
            checked_by=it.checked_by, checked_at=it.checked_at, note=it.note, source_set_id=it.set_id,
        )
        w_ids.append(w.id)
    res = await test_pool.move_windows_to_train(db, w_ids, user.id)
    return ok(res)


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
