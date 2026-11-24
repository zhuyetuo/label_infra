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
