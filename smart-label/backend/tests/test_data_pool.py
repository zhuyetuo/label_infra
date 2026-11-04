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

    s = run(data_pool.summary(db, data_pool.PoolFilter()))
    assert s["n"] == 1 and s["n_approved"] == 1 and s["by_root"][0]["name"] == "抓挠"
    tree = {x["name"]: x for x in s["tree"]}
    assert tree["抓挠"]["parent"] is None and tree["抓挠"]["n"] == 1
    assert tree["抓挠-头颈耳"]["parent"] == "抓挠" and tree["抓挠-头颈耳"]["n"] == 1
    # 筛选下拉只列池里有的：项目带 id、日期按采集日
    assert s["by_project"] == [{"id": w.p.id, "name": w.p.name, "n": 1, "hours": s["by_project"][0]["hours"]}]
    assert s["by_dog"][0]["id"] is None and s["by_dog"][0]["name"] == "未关联"
    assert len(s["by_date"]) == 1

    # 标注员不能动池子；整批加入要给条件
    with pytest.raises(HTTPException):
        run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id]), db, w.ann))
    with pytest.raises(HTTPException):
        run(pool_api.post_add(pool_api.PoolAddIn(), db, w.rev))
    r = run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id], source="reviewed"), db, w.rev))
    # 人加的 3 条里 1 条已在池 → 新加 2 条；「活动」那条也是人加的 → +1；没人看过的 AI 片段不加
    assert r["data"]["added"] == 3
    s = run(data_pool.summary(db, data_pool.PoolFilter()))
    assert s["n"] == 4 and s["n_manual"] == 3

    # 按条件移出「活动」
    r = run(pool_api.post_remove(pool_api.PoolRemoveIn(label_names=[w.other.display_name]), db, w.rev))
    assert r["data"]["removed"] == 1 and run(data_pool.summary(db, data_pool.PoolFilter()))["n"] == 3

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
    s = run(data_pool.summary(db, data_pool.PoolFilter(min_sec=5)))
    assert s["n"] == 1 and s["by_root"][0]["name"] == "活动"


def test_按任务整份加入_列表(db, run):
    w = _world(db, run)
    w.items[1].end_time_ms = w.items[1].start_time_ms + 8000
    run(db.commit())
    # 看过这个任务觉得行：整份加入，没人看过的 AI 片段也算
    r = run(pool_api.post_add(pool_api.PoolAddIn(task_ids=[w.t.id], source="all"), db, w.admin))
    assert r["data"]["added"] == 5
    d = run(data_pool.list_items(db, data_pool.PoolFilter(), sort="long", page_size=2))
    assert d["total"] == 5 and len(d["items"]) == 2
    assert d["items"][0]["label_name"] == "活动" and d["items"][1]["id"] == w.items[1].id   # 10 秒、8 秒
    assert d["items"][0]["via"] == "manual"
    d = run(data_pool.list_items(db, data_pool.PoolFilter(label_names=["抓挠"], min_sec=5)))
    assert [i["id"] for i in d["items"]] == [w.items[1].id]
    # 移出选中的
    run(pool_api.post_remove(pool_api.PoolRemoveIn(item_ids=[w.items[1].id]), db, w.admin))
    assert run(data_pool.list_items(db, data_pool.PoolFilter()))["total"] == 4


def test_采样率按名义档位归_51到66Hz都算50Hz():
    assert [data_pool.nominal_hz(h) for h in (0, 15.6, 16, 25, 31.25, 51, 57, 66)] == [0, 16, 16, 25, 31, 50, 50, 50]
