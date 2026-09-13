"""
测试用的数据库夹具。

这台开发机上装不了 aiosqlite（pip 出网被挡），而接口全是 async 的。所以这里给真的
sqlite 同步 Session 套一层 async 外壳：`await db.execute(...)` 之类照样能用，底下走的
是**真的数据库**，建表、约束、查询、事务一样不少。

为什么值得这么绕：不这么做就只能测纯函数，而"存进去能不能原样读回来"恰恰是最容易
错、也最该测的一段——字段拼错、JSON 存成了字符串的字符串、覆盖保存没删干净，
这些纯函数测试一个都发现不了。

跑在有 aiosqlite/aiomysql 的环境里时，这层外壳可以整个换掉，测试本身不用改。
"""

import asyncio

import pytest
from sqlalchemy import BigInteger, create_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base


# sqlite 只给 `INTEGER PRIMARY KEY` 自增，`BIGINT PRIMARY KEY` 不认，插入时会直接
# 报 NOT NULL constraint failed。全表主键都是 BigInteger（MySQL 上是对的），所以
# 在 sqlite 方言下把它编译成 INTEGER。纯测试侧的事，生产代码一个字不动。
@compiles(BigInteger, "sqlite")
def _bigint_as_integer_on_sqlite(type_, compiler, **kw):  # noqa: ARG001
    return "INTEGER"


class AsyncSessionShim:
    """把同步 Session 包成接口代码期望的 async 形状。

    只实现接口真正用到的几个方法——多包一个没用到的方法，就多一处会跟真实
    AsyncSession 行为不一致而没人发现的地方。
    """

    def __init__(self, sync_session: Session):
        self._s = sync_session

    async def execute(self, stmt):
        return self._s.execute(stmt)

    def add(self, obj):
        self._s.add(obj)

    async def commit(self):
        self._s.commit()

    async def flush(self):
        self._s.flush()

    async def refresh(self, obj):
        self._s.refresh(obj)

    async def rollback(self):
        self._s.rollback()

    async def get(self, model, pk):
        return self._s.get(model, pk)

    def close(self):
        self._s.close()


@pytest.fixture()
def db(tmp_path):
    """一个真的 sqlite 库，按模型定义建表。

    注意这里建表走的是 Base.metadata.create_all（模型定义），不是 alembic 迁移
    （迁移里的 server_default=now() 是 MySQL 写法）。迁移和模型的列是否一致，
    由 test_vision_api.py 里那个逐列比对的测试单独守。
    """
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine, expire_on_commit=False)
    sync = maker()
    shim = AsyncSessionShim(sync)
    yield shim
    shim.close()
    engine.dispose()


@pytest.fixture()
def run():
    """把 async 接口函数跑起来。每次新建 event loop，测试之间互不影响。"""

    def _run(coro):
        return asyncio.run(coro)

    return _run
