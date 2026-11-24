"""模型测试集：加进去的样本训练导出不要；冻结后不能增删；复制成新版本；窗口里标了什么、体型配额表。"""

from __future__ import annotations

import json
from datetime import date, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import data_pool as pool_api
from app.api.v1 import model_tests as api
from app.api.v1 import segment_review as seg_api
from app.models.sample import Sample
from app.models.task import Task
from app.services import model_test_service as mts
from app.services import training_export_service as te

from tests.test_segment_review import _world


def _prep_export(db, run, tmp_path, monkeypatch, w):
    smp = run(db.execute(select(Sample))).scalar_one()
    smp.session_date, smp.sample_hz = date(2026, 9, 1), 50.0
    run(db.commit())
    run(seg_api.decide(w.items[0].id, seg_api.DecideIn(decision="approved"), db, w.rev))
    run(pool_api.post_add(pool_api.PoolAddIn(project_ids=[w.p.id]), db, w.rev))

    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(te, "_csv_start_of", csv_start)
    monkeypatch.setattr(te, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(te.settings, "nas_root", str(tmp_path))
    return smp


def test_测试集里的样本不进训练导出(db, run, tmp_path, monkeypatch):
    w = _world(db, run)
    _prep_export(db, run, tmp_path, monkeypatch, w)
    out = run(te.export_dataset(db, "before", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_tasks"] == 1 and out["n_skipped_test"] == 0

    s = run(api.create_set(api.SetIn(name="测试集v1"), db, w.admin))["data"]
    t = run(db.execute(select(Task))).scalars().first()
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=0, end_ms=60000)]), db, w.admin))
    assert r["data"]["added"] == 1
    # 只挑了 1 分钟的窗口，整个样本也不进训练（防相邻几秒漏进去）
    with pytest.raises(te.TrainingExportError):
        run(te.export_dataset(db, "after", project_ids=[w.p.id], scope="pool", dry_run=True))

    # 重复加跳过；起止不对跳过
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=0, end_ms=60000),
                                                     api.ItemIn(task_id=t.id, start_ms=5, end_ms=None)]), db, w.admin))
    assert r["data"]["added"] == 0 and len(r["data"]["skipped"]) == 2

    # 删掉之后又能导出
    item_id = run(api.get_items(s["id"], db))["data"]["items"][0]["id"]
    run(api.delete_item(item_id, db))
    out = run(te.export_dataset(db, "again", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_tasks"] == 1


def test_冻结后不能增删_复制成新版本(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id)]), db, w.admin))
    run(api.freeze_set(s["id"], db))
    with pytest.raises(HTTPException):
        run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=0, end_ms=1000)]), db, w.admin))
    item_id = run(api.get_items(s["id"], db))["data"]["items"][0]["id"]
    with pytest.raises(HTTPException):
        run(api.delete_item(item_id, db))
    with pytest.raises(HTTPException):
        run(api.create_set(api.SetIn(name="v1"), db, w.admin))
    v2 = run(api.copy_set(s["id"], api.SetIn(name="v2"), db, w.admin))["data"]
    assert not v2["frozen"]
    got = run(api.get_items(v2["id"], db))["data"]
    assert got["set"]["n_items"] == 1
    r = run(api.add_items(v2["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=0, end_ms=1000)]), db, w.admin))
    assert r["data"]["added"] == 1
    sets = run(api.list_sets(db))["data"]
    assert sets["n_excluded_samples"] == 1 and len(sets["sets"]) == 2


def test_窗口里标了什么_配额表(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=0, end_ms=600000)]), db, w.admin))
    d = run(api.get_items(s["id"], db))["data"]
    row = d["items"][0]
    assert row["kind"] == "长片段" and row["dur_sec"] == 600
    assert "抓挠" in row["labels"] and row["labels"]["抓挠"]["n"] >= 1
    cov = d["coverage"]
    assert cov["n_items"] == 1 and cov["kinds"] == {"长片段": 1}
    assert "未知" in cov["matrix"]          # 测试数据没关联狗 → 体型未知那行出现


def test_模型见过没见过按训练数据集算(tmp_path, monkeypatch):
    spec = json.dumps({"date": "pool_a", "extra_date": ["pool_b"],
                       "extra_datasets": [{"date": "ds_old", "export_json": "x"}]})
    assert mts.datasets_of_spec(spec) == ["pool_a", "pool_b", "ds_old"]
    assert mts.datasets_of_spec("坏的") == []
    monkeypatch.setattr(te.settings, "nas_root", str(tmp_path))
    d = tmp_path / te.TRAIN_DIR / "pool_a"
    d.mkdir(parents=True)
    (d / "merged_tmp.json").write_text(json.dumps([{"id": 1, "data": {"sample_code": "s1"}}]), encoding="utf-8")
    assert mts.dataset_sample_codes("pool_a") == frozenset({"s1"})
    assert mts.dataset_sample_codes("pool_b") is None
