"""训练记录：状态自己同步、能看日志、能删。

2026-09-23 第一次在网页上提交训练：步骤 0 就挂了，界面上却一直挂着「排队中」
——列表只读这边的库，那一行只有手动点「刷新」才会去问算法机。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import model_versions as mv
from app.models.model_version import ModelTrainStatus, ModelVersion
from app.models.user import User, UserRole
from app.services import algo_client


def _row(db, run, status=ModelTrainStatus.queued, algo_job_id=1):
    u = User(username=f"u{algo_job_id}", password_hash="x", display_name="u", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    r = ModelVersion(algo_job_id=algo_job_id, status=status, model_type="rf",
                     dataset_spec='{"date": "ds_a"}', created_by=u.id)
    db.add(r)
    run(db.commit())
    return r


# ── 列表自己同步状态 ─────────────────────────────────────────────────────


def test_列表会顺手把排队中的同步成最新状态(db, run, monkeypatch):
    row = _row(db, run)

    async def poll(_jid):
        return {"status": "failed", "error": "步骤0 没有 project-*.json"}

    monkeypatch.setattr(algo_client, "poll_train", poll)
    out = run(mv.list_model_versions(db))
    assert out["data"][0]["status"] == "failed", "算法机早就挂了，列表里还挂着排队中"
    assert "project-" in out["data"][0]["error"]


def test_算法机问不到_列表照样给(db, run, monkeypatch):
    _row(db, run)

    async def poll(_jid):
        raise algo_client.AlgoServiceError("连不上")

    monkeypatch.setattr(algo_client, "poll_train", poll)
    out = run(mv.list_model_versions(db))
    assert out["data"][0]["status"] == "queued"


def test_结束了的不再去问(db, run, monkeypatch):
    """跑完的每次列表都去问一遍，十几版就是十几个请求，白白拖慢列表。"""
    _row(db, run, status=ModelTrainStatus.done)
    called = []

    async def poll(jid):
        called.append(jid)
        return {"status": "done"}

    monkeypatch.setattr(algo_client, "poll_train", poll)
    run(mv.list_model_versions(db))
    assert called == []


# ── 删除：先删算法机，成功了才删记录 ─────────────────────────────────────


def test_删除_先删算法机再删记录(db, run, monkeypatch):
    row = _row(db, run, status=ModelTrainStatus.done)
    order = []

    async def delete_train(jid):
        order.append("algo")
        return {"deleted": ["results/processed_ds_a__job1_x"]}

    monkeypatch.setattr(algo_client, "delete_train", delete_train)
    out = run(mv.delete_model_version(row.id, db))
    assert order == ["algo"]
    assert out["data"]["deleted"]
    assert run(db.get(ModelVersion, row.id)) is None


def test_算法机没删成_记录要留着(db, run, monkeypatch):
    """反过来的话，记录没了、文件还躺在算法机上——界面上再也找不到它，
    那些文件就成了没人管的孤儿。"""
    row = _row(db, run, status=ModelTrainStatus.done)

    async def delete_train(jid):
        raise algo_client.AlgoServiceError("连不上")

    monkeypatch.setattr(algo_client, "delete_train", delete_train)
    with pytest.raises(HTTPException) as e:
        run(mv.delete_model_version(row.id, db))
    assert e.value.status_code == 502
    assert run(db.get(ModelVersion, row.id)) is not None


def test_正在用或者还在跑的_原因原样给人看(db, run, monkeypatch):
    row = _row(db, run, status=ModelTrainStatus.done)

    async def delete_train(jid):
        raise algo_client.AlgoConflict("训练任务 #1 的模型正是现在推理在用的那个，先切到别的模型再删")

    monkeypatch.setattr(algo_client, "delete_train", delete_train)
    with pytest.raises(HTTPException) as e:
        run(mv.delete_model_version(row.id, db))
    assert e.value.status_code == 409
    assert "正在用" in e.value.detail or "在用" in e.value.detail
    assert run(db.get(ModelVersion, row.id)) is not None


# ── 日志：顺带同步状态 ───────────────────────────────────────────────────


def test_日志里看到结束了_表格那一行也跟着变(db, run, monkeypatch):
    """日志里已经写着训练结束，表格还挂着「训练中」、得人再去点刷新——那不叫实时。"""
    row = _row(db, run, status=ModelTrainStatus.running)

    async def train_log(jid, offset):
        return {"status": "done", "offset": 10, "size": 10, "text": "完成\n", "stage": "训练完成"}

    async def poll(jid):
        return {"status": "done", "model_path": "/x/ml_rf.pkl", "metrics": {"macro_f1": 0.8}}

    monkeypatch.setattr(algo_client, "train_log", train_log)
    monkeypatch.setattr(algo_client, "poll_train", poll)
    out = run(mv.model_version_log(row.id, 0, db))
    assert out["data"]["text"] == "完成\n"
    got = run(db.get(ModelVersion, row.id))
    assert got.status == ModelTrainStatus.done and got.model_path == "/x/ml_rf.pkl"
