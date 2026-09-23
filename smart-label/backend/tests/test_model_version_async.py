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
