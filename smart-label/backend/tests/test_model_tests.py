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
from app.models.task import Task, TaskStatus
from app.services import model_test_service as mts
from app.services import task_service
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
    # 窗口远在样本外：只挖那一段 ±60 秒，任务照常导出，片段一条不少
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=50_000_000, end_ms=50_060_000)]), db, w.admin))
    assert r["data"]["added"] == 1
    excl, tasks = run(mts.test_exclusion(db))
    # 挂在原任务（整段样本）上：原任务照常导出，只挖窗口；专门建的短任务才整份不导出
    assert excl == {t.sample_id: [(50_000_000 - 60_000, 50_060_000 + 60_000)]} and tasks == set()
    out = run(te.export_dataset(db, "after", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_tasks"] == 1 and out["n_test_holed"] == 1

    # 重复加跳过；起止不对跳过
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=50_000_000, end_ms=50_060_000),
                                                     api.ItemIn(task_id=t.id, start_ms=5, end_ms=None)]), db, w.admin))
    assert r["data"]["added"] == 0 and len(r["data"]["skipped"]) == 2

    # 删掉之后又能导出
    item_id = run(api.get_items(s["id"], db))["data"]["items"][0]["id"]
    run(api.delete_item(item_id, db))
    out = run(te.export_dataset(db, "again", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_tasks"] == 1


def test_别的项目里同一个样本_窗口挖洞_整任务整份不要(db, run, tmp_path, monkeypatch):
    from app.models.task import TaskStatus, TaskType
    w = _world(db, run)
    _prep_export(db, run, tmp_path, monkeypatch, w)
    t = run(db.execute(select(Task))).scalars().first()
    before = run(te.export_dataset(db, "b", project_ids=[w.p.id], scope="pool", dry_run=True))
    # 测试用的短任务建在别的项目里（同一个样本），窗口盖住整个时间轴
    t2 = Task(project_id=w.p.id, sample_id=t.sample_id, task_type=TaskType.from_scratch, status=TaskStatus.PENDING_ASSIGN,
              segment_start_ms=0, segment_end_ms=100_000_000, created_by=w.admin.id)
    db.add(t2)
    run(db.commit())
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t2.id)]), db, w.admin))
    excl, _ = run(mts.test_exclusion(db))
    assert excl[t.sample_id] == [(0, 100_000_000 + 60_000)]
    # 原任务还导出，但片段全被挖掉
    try:
        out = run(te.export_dataset(db, "a", project_ids=[w.p.id], scope="pool", dry_run=True))
        assert out["n_segments"] < before["n_segments"] and out["n_test_holed"] == 1
    except te.TrainingExportError:
        pass   # 全挖光了没东西可导，也对


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


def test_测试集纠偏审核入池并剥离(db, run, tmp_path, monkeypatch):
    w = _world(db, run)
    _prep_export(db, run, tmp_path, monkeypatch, w)
    # _prep_export 会整项目入池；把 items[1] 还原成「未审核且未入池」，验证纠偏后的入池与剥离效果
    w.items[1].pool_state = None
    w.items[1].pool_at = None
    w.items[1].pool_review = None
    # 模拟原任务本是已通过，管理员通过「继续编辑」临时解锁修改
    w.t.status = TaskStatus.APPROVED
    run(db.commit())
    run(task_service.edit_again(db, w.t.id, w.admin))
    assert w.t.status == TaskStatus.IN_PROGRESS and w.t.locked_by == w.admin.id

    s = run(api.create_set(api.SetIn(name="纠偏测试集"), db, w.admin))["data"]
    run(api.add_items(s["id"], api.ItemsIn(items=[
        api.ItemIn(task_id=w.t.id, start_ms=10000, end_ms=15000),
    ]), db, w.admin))
    item_id = run(api.get_items(s["id"], db))["data"]["items"][0]["id"]

    # 剥离并入池前：items[1] 尚未审核入池，且该测试窗口(±60s余量)会被训练导出排除
    assert w.items[1].seg_status is None and w.items[1].pool_state is None
    out_before = run(te.export_dataset(db, "before_promote", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out_before["n_test_holed"] == 1 and out_before["n_segments"] == 0

    res = run(api.promote_item_to_pool(item_id, api.PromoteIn(restore_approved=True), db, w.admin))["data"]
    assert res["n_pooled"] == 1 and res["removed"] == 1 and res["still_in_other_sets"] == []

    # 窗口内片段已审核通过并入数据池；测试集里已剥离；原任务恢复 APPROVED 且清锁
    run(db.refresh(w.items[1]))
    run(db.refresh(w.t))
    assert w.items[1].seg_status == "approved"
    assert w.items[1].pool_state == "in"
    assert w.items[1].pool_review == "in"
    assert w.items[1].seg_reviewed_by == w.admin.id
    assert w.t.status == TaskStatus.APPROVED and w.t.locked_by is None
    assert run(api.get_items(s["id"], db))["data"]["items"] == []

    # 训练导出不再被该测试窗口挖洞，且能导出刚刚入池的 items[1]
    out = run(te.export_dataset(db, "after_promote", project_ids=[w.p.id], scope="pool", dry_run=True))
    assert out["n_test_holed"] == 0 and out["n_segments"] >= 4

    # 冻结后的测试集不能剥离
    run(api.add_items(s["id"], api.ItemsIn(items=[
        api.ItemIn(task_id=w.t.id, start_ms=20000, end_ms=25000),
    ]), db, w.admin))
    frozen_item_id = run(api.get_items(s["id"], db))["data"]["items"][0]["id"]
    run(api.freeze_set(s["id"], db))
    with pytest.raises(HTTPException) as exc:
        run(api.promote_item_to_pool(frozen_item_id, api.PromoteIn(restore_approved=False), db, w.admin))
    assert exc.value.status_code == 400
