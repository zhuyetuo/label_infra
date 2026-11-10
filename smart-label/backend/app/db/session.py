from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(
    settings.mysql_dsn,
    pool_pre_ping=True,
    pool_recycle=3600,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    # 池子满了宁可让这个请求快点失败，也不要 30 秒后才报错——排队 30 秒的请求
    # 自己还占着上游资源，会把问题放大
    pool_timeout=settings.db_pool_timeout_sec,
    # 连不上数据库 5 秒就报错，不无限挂着（库卡死时请求一直挂着不返回，比报错更难查）
    connect_args={"connect_timeout": 5} if settings.mysql_dsn.startswith("mysql") else {},
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
