"""按条件挑：从已有片段挑、凑窗口、挂在原任务上；核对标记；原任务不整份踢出训练、只挖窗口。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import model_tests as api
from app.models.task import Task
from app.services import model_test_service as mts

from tests.test_segment_review import _world


def test_按条件挑_预览跟加进去一样(db, run):
    w = _world(db, run)
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    body = api.ComposeIn(label_names=["抓挠"], per_group=5, max_total=50, pad_sec=60)
    pv = run(api.compose_preview(s["id"], body, db))["data"]
    assert pv["stats"]["n_picked"] >= 1 and pv["stats"]["n_found"] >= pv["stats"]["n_picked"]
    p0 = pv["picks"][0]
    assert p0["end_ms"] - p0["start_ms"] >= 60_000 and p0["label"].startswith("抓挠")
    r = run(api.compose_apply(s["id"], body, db, w.admin))["data"]
    assert r["added"] == pv["stats"]["n_picked"]
    # 再挑一次：跟已有窗口重叠的不再挑
    pv2 = run(api.compose_preview(s["id"], body, db))["data"]
    assert pv2["stats"]["n_picked"] < pv["stats"]["n_picked"] or pv2["stats"]["n_picked"] == 0
    # 挂在原任务上：原任务不整份踢出训练，只挖窗口
    excl, whole_tasks = run(mts.test_exclusion(db))
    t = run(db.execute(select(Task))).scalars().first()
    assert t.id not in whole_tasks and excl[t.sample_id]
    # 只要 AI 预标的：这批里人改过 / 人加的不算
    pv3 = run(api.compose_preview(s["id"], api.ComposeIn(label_names=["抓挠"], source="ai"), db))["data"]
    assert pv3["stats"].get("by_source", {}).get("人工标过", 0) == 0


def test_核对标记_冻结后不能改(db, run):
    w = _world(db, run)
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    run(api.compose_apply(s["id"], api.ComposeIn(label_names=["抓挠"]), db, w.admin))
    d = run(api.get_items(s["id"], db))["data"]
    iid = d["items"][0]["id"]
    assert d["items"][0]["checked"] is False and d["coverage"]["n_checked"] == 0
    run(api.check_item(iid, api.CheckIn(checked=True), db, w.admin))
    d = run(api.get_items(s["id"], db))["data"]
    assert d["items"][0]["checked"] is True and d["coverage"]["n_checked"] == 1
    run(api.freeze_set(s["id"], db))
    with pytest.raises(HTTPException):
        run(api.check_item(iid, api.CheckIn(checked=False), db, w.admin))
    with pytest.raises(HTTPException):
        run(api.compose_apply(s["id"], api.ComposeIn(label_names=["抓挠"]), db, w.admin))


def test_无这类窗口_每只狗上限(db, run):
    w = _world(db, run)
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    t = run(db.execute(select(Task))).scalars().first()
    scr = [x for x in run(mts.task_segments(db, t.id)) if x["top"] == "抓挠"]
    pv = run(api.compose_preview(s["id"], api.ComposeIn(label_names=["抓挠"], mode="negative", pad_sec=0), db))["data"]
    for p in pv["picks"]:
        assert p["label"] == "无抓挠" and p["anchor"] and not p["anchor"].startswith("抓挠")
        assert not any(x["start_ms"] < p["end_ms"] and x["end_ms"] > p["start_ms"] for x in scr)   # 窗口里一次抓挠都没有
    # 每只狗最多 1 段
    pv = run(api.compose_preview(s["id"], api.ComposeIn(label_names=["抓挠"], per_dog=1), db))["data"]
    assert pv["stats"]["n_picked"] <= 1
    # 指定的中心类别没有对应标签
    pv = run(api.compose_preview(s["id"], api.ComposeIn(label_names=["抓挠"], mode="negative", anchor_names=["不存在的类"]), db))["data"]
    assert pv["picks"] == [] and pv["warnings"]
    # 配额表按时长 × 有无抓挠
    run(api.compose_apply(s["id"], api.ComposeIn(label_names=["抓挠"], pad_sec=600), db, w.admin))
    cov = run(api.get_items(s["id"], db))["data"]["coverage"]
    assert cov["by_dur"].get("10 分钟", {}).get("有抓挠", 0) >= 1


def test_选样计划_预览生成_计划保存(db, run):
    from app.models.dog import Dog
    from app.models.sample import Sample
    w = _world(db, run)
    d = Dog(dog_code="d1", name="阿黄", site="公司影棚", size="中")
    db.add(d)
    run(db.flush())
    smp = run(db.execute(select(Sample))).scalar_one()
    smp.dog_id = d.id
    run(db.commit())
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    plan = api.PlanIn(target="抓挠", durations=[60], dogs=[api.PlanDogIn(dog_id=d.id, q={"60": [1, 1]})])
    av = run(api.plan_availability(plan, db))["data"]
    assert sum(av["by_dog"][str(d.id)].values()) >= 1
    pv = run(api.plan_preview(s["id"], plan, db))["data"]
    rep = pv["report"][str(d.id)]["q"]["60"]
    assert rep[0] == 1 and pv["n_picked"] == rep[0] + rep[1]
    r = run(api.plan_apply(s["id"], plan, db, w.admin))["data"]
    assert r["added"] == pv["n_picked"]
    got = run(api.get_items(s["id"], db))["data"]
    assert got["set"]["plan"]["dogs"][0]["dog_id"] == d.id
    assert any((it["note"] or "").startswith("选样·1分钟·有抓挠") for it in got["items"])
    # 有的窗口里没有抓挠
    for it in got["items"]:
        if "无抓挠" in (it["note"] or ""):
            assert "抓挠" not in it["labels"]


def test_删测试集_任务和标注不动(db, run):
    from app.models.annotation import AnnotationLabelItem
    w = _world(db, run)
    n_items_before = len(run(db.execute(select(AnnotationLabelItem))).scalars().all())
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    run(api.compose_apply(s["id"], api.ComposeIn(label_names=["抓挠"]), db, w.admin))
    assert run(api.get_items(s["id"], db))["data"]["colors"] is not None
    r = run(api.delete_set(s["id"], db))["data"]
    assert r["deleted_items"] >= 1
    assert run(api.list_sets(db))["data"]["sets"] == []
    assert run(mts.test_exclusion(db)) == ({}, set())                         # 不再挡训练导出
    assert len(run(db.execute(select(AnnotationLabelItem))).scalars().all()) == n_items_before
    assert run(db.execute(select(Task))).scalars().first() is not None
    with pytest.raises(HTTPException):
        run(api.delete_set(s["id"], db))
