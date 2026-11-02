"""数据池：审核通过的自动在池；整批手动加入 / 移出；改过的离开池子；按池导出只要池里的。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import data_pool as pool_api
from app.api.v1 import segment_review as seg_api
from app.models.annotation import AnnotationLabelItem
from app.services import data_pool
from app.services.task_service import save_draft  # noqa: F401  （确认存在）

from tests.test_segment_review import _world


def _ids_in_pool(run, db):
    rows = run(db.execute(select(AnnotationLabelItem)))
    return sorted(i.id for i in rows.scalars().all() if data_pool.in_pool(i.seg_status, i.pool_state))


def test_审核通过自动进池_手动加入移出(db, run):
    w = _world(db, run)
    assert _ids_in_pool(run, db) == []
    run(seg_api.decide(w.items[0].id, seg_api.DecideIn(decision="approved"), db, w.rev))
    assert _ids_in_pool(run, db) == [w.items[0].id]

    s = run(data_pool.summary(db))
    assert s["n"] == 1 and s["n_approved"] == 1 and s["by_root"][0]["name"] == "抓挠"

    # 标注员不能动池子；整批加入要给条件
    with pytest.raises(HTTPException):
        run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id]), db, w.ann))
    with pytest.raises(HTTPException):
        run(pool_api.post_add(pool_api.PoolAddIn(), db, w.rev))
    r = run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id], source="reviewed"), db, w.rev))
    # 人加的 3 条里 1 条已在池 → 新加 2 条；「活动」那条也是人加的 → +1；没人看过的 AI 片段不加
    assert r["data"]["added"] == 3
    s = run(data_pool.summary(db))
    assert s["n"] == 4 and s["n_manual"] == 3

    # 按条件移出「活动」
    r = run(pool_api.post_remove(pool_api.PoolRemoveIn(label_names=[w.other.display_name]), db, w.rev))
    assert r["data"]["removed"] == 1 and run(data_pool.summary(db))["n"] == 3

    # 审核通过的被移出后再「通过」一次：重新认可，回到池里
    run(pool_api.post_remove(pool_api.PoolRemoveIn(item_ids=[w.items[0].id]), db, w.rev))
    assert w.items[0].id not in _ids_in_pool(run, db)
    run(seg_api.decide(w.items[0].id, seg_api.DecideIn(decision="approved"), db, w.rev))
    assert w.items[0].id in _ids_in_pool(run, db)


def test_改过的离开池子(db, run):
    w = _world(db, run)
    run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id]), db, w.admin))
    it = w.items[1]
    assert it.id in _ids_in_pool(run, db)
    # 标注员在片段接口里改了起止：手动加入的失效
    w.t.assigned_to = w.ann.id
    run(db.commit())
    run(seg_api.edit(it.id, seg_api.EditIn(start_time_ms=10500, end_time_ms=13000), db, w.ann))
    assert it.id not in _ids_in_pool(run, db)


def test_从池里挑一批导出(db, run, tmp_path, monkeypatch):
    """scope=pool：只要池里的；还能只挑某几个类别、某种原始采样率"""
    from datetime import date, datetime

    from app.models.sample import Sample
    from app.services import training_export_service as svc

    w = _world(db, run)
    smp = run(db.execute(select(Sample))).scalar_one()
    smp.session_date, smp.sample_hz = date(2026, 9, 1), 50.0
    run(db.commit())
    run(seg_api.decide(w.items[0].id, seg_api.DecideIn(decision="approved"), db, w.rev))
    run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id]), db, w.rev))   # 再手动加：3 条抓挠 + 1 条活动

    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_of", csv_start)
    monkeypatch.setattr(svc, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    out = run(svc.export_dataset(db, "pool_all", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_segments"] == 4 and out["pool_filters"]["n_skipped_not_pool"] == 1   # 没人看过的 AI 片段不在池
    out = run(svc.export_dataset(db, "pool_scr", project_ids=[w.p.id], scope="pool", dry_run=True,
                                 only_labels=["抓挠"]))
    assert out["n_segments"] == 3                      # 「抓挠」含细类「抓挠-头颈耳」
    with pytest.raises(svc.TrainingExportError):
        run(svc.export_dataset(db, "pool_16", project_ids=[w.p.id], scope="pool", dry_run=True, sample_hz=[16]))
    out = run(svc.export_dataset(db, "pool_50", project_ids=[w.p.id], scope="pool", dry_run=True, sample_hz=[50]))
    assert out["n_segments"] == 4
    # 只要长片段：3 秒的抓挠都不要，10 秒的活动留下
    out = run(svc.export_dataset(db, "pool_long", project_ids=[w.p.id], scope="pool", dry_run=True, min_seg_sec=5))
    assert out["n_segments"] == 1 and out["n_skipped_short"] == 3
    s = run(data_pool.summary(db, min_sec=5))
    assert s["n"] == 1 and s["by_root"][0]["name"] == "活动"
