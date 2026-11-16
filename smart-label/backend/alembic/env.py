import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import settings
from app.db.base import Base
from app.models import *  # noqa: F401,F403  确保所有模型都被注册到 Base.metadata

config = context.config
config.set_main_option("sqlalchemy.url", settings.mysql_dsn)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    # 每个迁移单独一个事务、做完就记版本号：MySQL 的建表 / 改表会自动提交，几步放一个事务里时，
    # 中途断了就会出现「表建好了、版本号没记」，重跑又去建同一张表报 already exists
    context.configure(connection=connection, target_metadata=target_metadata, transaction_per_migration=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        # ALTER TABLE 要拿表的元数据锁（MDL）。表上有没结束的事务时它会一直等——而它排着队的时候，
        # 后面所有读这张表的普通查询也跟着排在它后面，全站卡死（MySQL 默认等一年）。
        # 这里最多等 15 秒，等不到就让迁移失败：up.sh 会停下、报错，线上照常用旧版本，挑空闲时再更新
        if connection.dialect.name == "mysql":
            await connection.exec_driver_sql("SET SESSION lock_wait_timeout = 15")
        await connection.run_sync(do_run_migrations)
        # MySQL 的 DDL 是隐式提交的，但「记版本号」那条 UPDATE 落在连接自己的隐式事务里，
        # 不显式提交的话连接一关就回滚——现象是表已经改好、alembic_version 永远停在旧
        # revision，每次部署都把已经跑过的迁移再跑一遍。这里补一次提交把它落盘。
        await connection.commit()
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
