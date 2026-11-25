"""测试数据池服务：与训练数据池双池隔离、自动沉淀测试集核对结果、支持一键拨入训练数据池与复用到新测试集。"""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.audit_log import AuditLog
from app.models.model_test import ModelTestItem, ModelTestSet, TestPoolWindow
from app.models.task import Task
from app.models.user import User


def _win_key(task_id: int, start_ms: int | None, end_ms: int | None) -> tuple[int, int | None, int | None]:
    return (int(task_id), start_ms, end_ms)


async def sync_window_to_test_pool(
    db: AsyncSession,
    *,
    task_id: int,
    sample_id: int,
    start_ms: int | None,
    end_ms: int | None,
    user_id: int | None,
    checked: bool | None = None,
    checked_by: int | None = None,
    checked_at: datetime | None = None,
    note: str | None = None,
    source_set_id: int | None = None,
) -> TestPoolWindow:
    """将测试窗口同步沉淀进测试数据池（幂等 upsert）。
    如果该窗口之前已被拨入训练池，不擅自改回 active，除非显式新加。"""
    q = select(TestPoolWindow).where(
        TestPoolWindow.task_id == task_id,
        TestPoolWindow.start_ms.is_(None) if start_ms is None else TestPoolWindow.start_ms == start_ms,
        TestPoolWindow.end_ms.is_(None) if end_ms is None else TestPoolWindow.end_ms == end_ms,
    )
    row = (await db.execute(q)).scalar_one_or_none()
    now = datetime.now()
    if row is None:
        row = TestPoolWindow(
            task_id=task_id,
            sample_id=sample_id,
            start_ms=start_ms,
            end_ms=end_ms,
            status="active",
            checked_by=checked_by if checked_by is not None else (user_id if checked else None),
            checked_at=checked_at if checked_at is not None else (now if checked else None),
            note=note,
            source_set_id=source_set_id,
            created_by=user_id,
        )
        db.add(row)
        await db.flush()
        return row

    if checked is True:
        row.checked_by = checked_by or user_id
        row.checked_at = checked_at or now
    elif checked is False:
        row.checked_by = None
        row.checked_at = None
    if note and not row.note:
        row.note = note
    if source_set_id and not row.source_set_id:
        row.source_set_id = source_set_id
    row.updated_at = now
    return row


async def backfill_from_test_items(db: AsyncSession) -> int:
    """把历史已有的 model_test_items 补录到 test_pool_windows（幂等，已存在的跳过或补齐已核对时间）。"""
    existing = (await db.execute(select(TestPoolWindow))).scalars().all()
    by_key = {_win_key(w.task_id, w.start_ms, w.end_ms): w for w in existing}

    items = (await db.execute(select(ModelTestItem).order_by(ModelTestItem.id))).scalars().all()
    added = 0
    for it in items:
        k = _win_key(it.task_id, it.start_ms, it.end_ms)
        w = by_key.get(k)
        if w is None:
            w = TestPoolWindow(
                task_id=it.task_id,
                sample_id=it.sample_id,
                start_ms=it.start_ms,
                end_ms=it.end_ms,
                status="active",
                checked_by=it.checked_by,
                checked_at=it.checked_at,
                note=it.note,
                source_set_id=it.set_id,
                created_by=it.added_by,
            )
            db.add(w)
            by_key[k] = w
            added += 1
        elif w.status == "active" and it.checked_at is not None and w.checked_at is None:
            w.checked_by = it.checked_by
            w.checked_at = it.checked_at
    if added:
        await db.flush()
    return added


async def inherit_checked_from_pool(db: AsyncSession, items: list[ModelTestItem]) -> int:
    """新加入测试集的窗口，若测试数据池里已有同窗口且已核对，自动继承 checked_by/checked_at，免重复人工审核。"""
    if not items:
        return 0
    tids = list({it.task_id for it in items})
    pool_rows = (await db.execute(
        select(TestPoolWindow).where(
            TestPoolWindow.task_id.in_(tids),
            TestPoolWindow.status == "active",
            TestPoolWindow.checked_at.is_not(None),
        )
    )).scalars().all()
    if not pool_rows:
        return 0
    by_task: dict[int, list[TestPoolWindow]] = {}
    for w in pool_rows:
        by_task.setdefault(w.task_id, []).append(w)

    inherited = 0
    for it in items:
        if it.checked_at is not None:
            continue
        for w in by_task.get(it.task_id, ()):
            # 完全相同，或测试池已核对的窗口完整覆盖了新窗口
            exact = (w.start_ms == it.start_ms and w.end_ms == it.end_ms)
            covers = (
                w.start_ms is None
                or (it.start_ms is not None and it.end_ms is not None
                    and w.end_ms is not None and w.start_ms <= it.start_ms and w.end_ms >= it.end_ms)
            )
            if exact or covers:
                it.checked_by = w.checked_by
                it.checked_at = w.checked_at
                inherited += 1
                break
    return inherited


async def moved_to_train_keys(db: AsyncSession) -> set[tuple[int, int | None, int | None]]:
    """已拨入训练数据池的窗口集合：test_exclusion 用来放行这些窗口进入训练（即使它们曾属于已冻结的历史测试集）。"""
    rows = (await db.execute(
        select(TestPoolWindow.task_id, TestPoolWindow.start_ms, TestPoolWindow.end_ms)
        .where(TestPoolWindow.status == "moved_to_train")
    )).all()
    return {_win_key(tid, s, e) for tid, s, e in rows}


async def list_test_pool(
    db: AsyncSession,
    *,
    status: str = "active",
    checked: str = "all",
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict:
    """测试数据池列表 + 汇总统计。"""
    from app.services.model_test_service import describe_items

    await backfill_from_test_items(db)
    await db.commit()

    all_rows = (await db.execute(
        select(TestPoolWindow).order_by(TestPoolWindow.updated_at.desc(), TestPoolWindow.id.desc())
    )).scalars().all()

    active_rows = [w for w in all_rows if w.status == "active"]
    moved_rows = [w for w in all_rows if w.status == "moved_to_train"]
    n_checked = sum(1 for w in active_rows if w.checked_at is not None)
    n_unchecked = len(active_rows) - n_checked

    # 按状态 & 核对状态筛选
    filtered = all_rows
    if status in ("active", "moved_to_train"):
        filtered = [w for w in filtered if w.status == status]
    if checked == "checked":
        filtered = [w for w in filtered if w.checked_at is not None]
    elif checked == "unchecked":
        filtered = [w for w in filtered if w.checked_at is None]

    # 借用 describe_items 给每个窗口补齐样本、狗、体型、场地、窗内标注类别
    # describe_items 只需要有 id / task_id / sample_id / start_ms / end_ms / note / checked_at 属性的对象
    described = await describe_items(db, filtered)  # type: ignore[arg-type]

    # 查每个窗口目前属于哪些测试集 + 核对人/拨出人名字
    set_rows = (await db.execute(
        select(ModelTestItem.task_id, ModelTestItem.start_ms, ModelTestItem.end_ms, ModelTestSet.id, ModelTestSet.name, ModelTestSet.frozen_at)
        .join(ModelTestSet, ModelTestSet.id == ModelTestItem.set_id)
    )).all()
    sets_by_key: dict[tuple[int, int | None, int | None], list[dict]] = {}
    for tid, s, e, sid, sname, frozen_at in set_rows:
        sets_by_key.setdefault(_win_key(tid, s, e), []).append({
            "id": sid, "name": sname, "frozen": frozen_at is not None,
        })

    uids = {u for w in filtered for u in (w.checked_by, w.moved_by) if u is not None}
    uname: dict[int, str] = {}
    if uids:
        for uid, name in (await db.execute(select(User.id, User.display_name).where(User.id.in_(uids)))).all():
            uname[uid] = name

    w_by_id = {w.id: w for w in filtered}
    enriched: list[dict] = []
    kw = (keyword or "").strip().lower()
    for d in described:
        w = w_by_id[d["id"]]
        k = _win_key(w.task_id, w.start_ms, w.end_ms)
        row = {
            **d,
            "status": w.status,
            "checked_by_name": uname.get(w.checked_by) if w.checked_by else None,
            "moved_by_name": uname.get(w.moved_by) if w.moved_by else None,
            "moved_at": w.moved_at.isoformat(sep=" ", timespec="minutes") if w.moved_at else None,
            "sets": sets_by_key.get(k, []),
        }
        if kw:
            hay = " ".join(str(row.get(f) or "") for f in ("sample_code", "dog_name", "site", "project_name", "note")).lower()
            if kw not in hay and not any(kw in lb.lower() for lb in (row.get("labels") or [])):
                continue
        enriched.append(row)

    total_sec = sum(float(r.get("dur_sec") or 0) for r in enriched if r["status"] == "active")
    n_dogs = len({r.get("dog_id") for r in enriched if r["status"] == "active" and r.get("dog_id") is not None})

    total = len(enriched)
    p = max(1, page)
    ps = max(1, min(200, page_size))
    page_items = enriched[(p - 1) * ps: p * ps]

    return {
        "summary": {
            "active": len(active_rows),
            "checked": n_checked,
            "unchecked": n_unchecked,
            "moved_to_train": len(moved_rows),
            "n_dogs": n_dogs,
            "total_sec": round(total_sec, 1),
        },
        "total": total,
        "page": p,
        "page_size": ps,
        "items": page_items,
    }


async def check_window(db: AsyncSession, window_id: int, checked: bool, user_id: int) -> TestPoolWindow | None:
    """在测试数据池里标记/取消已核对，并同步更新所有未冻结测试集里对应的窗口。"""
    w = await db.get(TestPoolWindow, window_id)
    if w is None:
        return None
    now = datetime.now()
    w.checked_by, w.checked_at = (user_id, now) if checked else (None, None)
    w.updated_at = now

    # 同步到所有未冻结测试集里相同的窗口
    q = (
        select(ModelTestItem)
        .join(ModelTestSet, ModelTestSet.id == ModelTestItem.set_id)
        .where(
            ModelTestSet.frozen_at.is_(None),
            ModelTestItem.task_id == w.task_id,
            ModelTestItem.start_ms.is_(None) if w.start_ms is None else ModelTestItem.start_ms == w.start_ms,
            ModelTestItem.end_ms.is_(None) if w.end_ms is None else ModelTestItem.end_ms == w.end_ms,
        )
    )
    for it in (await db.execute(q)).scalars().all():
        it.checked_by, it.checked_at = w.checked_by, w.checked_at
    await db.commit()
    return w


async def _approve_window_segments_to_train_pool(
    db: AsyncSession,
    *,
    task_id: int,
    start_ms: int | None,
    end_ms: int | None,
    user_id: int,
    now: datetime,
) -> int:
    """把窗口内所有非 uncertain 的标注片段直接标为审核通过并放入训练数据池。"""
    task = await db.get(Task, task_id)
    if task is None:
        return 0
    rec = (await db.execute(
        select(AnnotationRecord).where(
            AnnotationRecord.task_id == task.id,
            AnnotationRecord.round_no == task.round_no,
        )
    )).scalar_one_or_none()
    if rec is None:
        return 0
    q = select(AnnotationLabelItem).where(
        AnnotationLabelItem.annotation_record_id == rec.id,
        AnnotationLabelItem.uncertain.is_(False),
    )
    if start_ms is not None and end_ms is not None:
        q = q.where(
            AnnotationLabelItem.start_time_ms < end_ms,
            AnnotationLabelItem.end_time_ms > start_ms,
        )
    segs = list((await db.execute(q)).scalars().all())
    for seg in segs:
        seg.seg_status = "approved"
        seg.seg_reviewed_by = user_id
        seg.seg_reviewed_at = now
        seg.review_note = seg.review_flag_by = seg.review_flag_at = None
        seg.seg_claimed_by = seg.seg_claim_expires_at = None
        if seg.source_type == LabelItemSource.ai_generated and not seg.is_modified:
            seg.ai_confirmed = True
        seg.pool_state = "in"
        seg.pool_at = now
        seg.pool_review = "in"
        seg.pool_review_by = user_id
        seg.pool_review_at = now
        seg.touched_at = now
        seg.touched_by = user_id
    return len(segs)


async def move_windows_to_train(db: AsyncSession, window_ids: list[int], user_id: int) -> dict:
    """批量把测试数据池窗口拨到训练数据池：
      1. 窗口内所有已核对标注自动标通过并入训练数据池（pool_state='in'）
      2. 窗口状态标记为 moved_to_train（解除测试隔离，下次训练立刻可用）
      3. 从所有未冻结测试集里移除对应条目（已冻结的历史测试集保留快照不破坏报告）
    """
    ids = [int(x) for x in window_ids if x]
    if not ids:
        return {"moved_windows": 0, "pooled_segments": 0, "removed_from_sets": 0}
    windows = (await db.execute(
        select(TestPoolWindow).where(TestPoolWindow.id.in_(ids))
    )).scalars().all()
    now = datetime.now()
    moved = 0
    pooled = 0
    removed_from_sets = 0

    for w in windows:
        if w.status == "moved_to_train":
            continue
        pooled += await _approve_window_segments_to_train_pool(
            db, task_id=w.task_id, start_ms=w.start_ms, end_ms=w.end_ms, user_id=user_id, now=now,
        )
        w.status = "moved_to_train"
        w.moved_by = user_id
        w.moved_at = now
        w.updated_at = now
        moved += 1

        # 从未冻结测试集里移除
        q = (
            select(ModelTestItem)
            .join(ModelTestSet, ModelTestSet.id == ModelTestItem.set_id)
            .where(
                ModelTestSet.frozen_at.is_(None),
                ModelTestItem.task_id == w.task_id,
                ModelTestItem.start_ms.is_(None) if w.start_ms is None else ModelTestItem.start_ms == w.start_ms,
                ModelTestItem.end_ms.is_(None) if w.end_ms is None else ModelTestItem.end_ms == w.end_ms,
            )
        )
        for it in (await db.execute(q)).scalars().all():
            await db.delete(it)
            removed_from_sets += 1

    if moved:
        db.add(AuditLog(
            user_id=user_id,
            action="test_pool.move_to_train",
            target_type="test_pool",
            target_id=0,
            detail=json.dumps({
                "window_ids": [w.id for w in windows],
                "moved_windows": moved,
                "pooled_segments": pooled,
                "removed_from_sets": removed_from_sets,
            }, ensure_ascii=False),
        ))
        await db.commit()
    return {"moved_windows": moved, "pooled_segments": pooled, "removed_from_sets": removed_from_sets}


async def add_windows_to_test_set(db: AsyncSession, window_ids: list[int], set_id: int, user_id: int) -> dict:
    """把测试数据池里已核对的窗口批量加入某个未冻结测试集（直接继承已核对状态，免重复审核）。"""
    ts = await db.get(ModelTestSet, set_id)
    if ts is None:
        raise ValueError("测试集不存在")
    if ts.frozen_at is not None:
        raise ValueError("该测试集已冻结，请先复制成新版本再添加")

    ids = [int(x) for x in window_ids if x]
    windows = (await db.execute(
        select(TestPoolWindow).where(
            TestPoolWindow.id.in_(ids),
            TestPoolWindow.status == "active",
        )
    )).scalars().all()

    existing = {
        (tid, s)
        for tid, s in (await db.execute(
            select(ModelTestItem.task_id, ModelTestItem.start_ms).where(ModelTestItem.set_id == set_id)
        )).all()
    }
    added = 0
    for w in windows:
        if (w.task_id, w.start_ms) in existing:
            continue
        db.add(ModelTestItem(
            set_id=set_id,
            task_id=w.task_id,
            sample_id=w.sample_id,
            start_ms=w.start_ms,
            end_ms=w.end_ms,
            note=w.note or "来自测试数据池",
            checked_by=w.checked_by,
            checked_at=w.checked_at,
            added_by=user_id,
        ))
        existing.add((w.task_id, w.start_ms))
        added += 1
    await db.commit()
    return {"added": added, "skipped": len(windows) - added}
