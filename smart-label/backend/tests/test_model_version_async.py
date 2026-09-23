"""训练记录列表在真的异步会话里不能 500。

2026-09-23：列表接口顺手同步状态、commit，然后再序列化——读 updated_at 时
MissingGreenlet，整个接口 500。界面上是一个「ValidationError」弹窗，列表停在
旧状态，删除按钮一直灰着，失败的那几版怎么都删不掉。

updated_at 是 onupdate=func.now()，值在数据库那边算：更新过的行一 flush，
这个字段就被标成"得回库里重读"。同步会话里隐式重读是合法的，所以其它测试
（用的同步夹具）都过了；只有真的异步会话测得出来。
"""

import asyncio

import pytest

pytest.importorskip("aiosqlite")

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.api.v1 import model_versions as mv  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.models.model_version import ModelTrainStatus, ModelVersion  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402
from app.services import algo_client  # noqa: E402


def test_同步了状态之后列表照样能序列化(tmp_path, monkeypatch):
    async def poll(_jid):
        return {"status": "failed", "error": "步骤0 挂了"}

    monkeypatch.setattr(algo_client, "poll_train", poll)

    async def go():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'a.db'}")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        # 跟生产一样的会话配置
        maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        async with maker() as db:
            u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
            db.add(u)
            await db.flush()
            db.add(ModelVersion(algo_job_id=1, status=ModelTrainStatus.running, model_type="rf",
                                dataset_spec="{}", created_by=u.id))
            await db.commit()
        async with maker() as db:
            out = await mv.list_model_versions(db)
        await engine.dispose()
        return out

    out = asyncio.run(go())
    assert out["data"][0]["status"] == "failed"


def test_导出到端侧把端侧F1并进metrics(tmp_path, monkeypatch):
    from app.services import edge_client

    async def export_edge(_jid):
        return {"tag": "train1", "spec": "edge:train1",
                "edge": {"macro_f1": 0.61, "accuracy": 0.8, "n_windows": 10, "per_class": {}}}

    async def reload():
        return {"ok": True}

    monkeypatch.setattr(algo_client, "export_edge", export_edge)
    monkeypatch.setattr(edge_client, "enabled", lambda: True)
    monkeypatch.setattr(edge_client, "reload", reload)

    async def go():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'b.db'}")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        async with maker() as db:
            u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
            db.add(u)
            await db.flush()
            db.add(ModelVersion(algo_job_id=1, status=ModelTrainStatus.done, model_type="rf",
                                model_path="/m/ml_rf.pkl", metrics='{"macro_f1": 0.7}',
                                dataset_spec="{}", created_by=u.id))
            await db.commit()
        async with maker() as db:
            out = await mv.export_edge(1, db)
            row = await db.get(ModelVersion, 1)
            metrics = row.metrics
        await engine.dispose()
        return out, metrics

    out, metrics = asyncio.run(go())
    assert out["data"]["reloaded"] is True and out["data"]["edge"]["macro_f1"] == 0.61
    import json as _j
    m = _j.loads(metrics)
    assert m["macro_f1"] == 0.7 and m["edge"]["macro_f1"] == 0.61 and m["edge_tag"] == "train1"
