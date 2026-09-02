import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, SmallInteger, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BackgroundJobType(str, enum.Enum):
    imu_ingest = "imu_ingest"  # CSV -> Parquet 缓存 + 降采样概览生成


class BackgroundJobStatus(str, enum.Enum):
    queued = "queued"
    processing = "processing"
    done = "done"
    failed = "failed"


class BackgroundJob(Base):
    """
    通用后台任务队列（决策⑨：除 clip_jobs 外的异步工作统一到这一张表，job_type 区分）。
    任务超时回收不用这张表——它是定时对 tasks 表做批量扫描，不是"逐条排队"的工作。
    """

    __tablename__ = "background_jobs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    job_type: Mapped[BackgroundJobType] = mapped_column(Enum(BackgroundJobType), nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False, comment="JSON字符串，如 {\"sample_id\": 123}")
    status: Mapped[BackgroundJobStatus] = mapped_column(
        Enum(BackgroundJobStatus), nullable=False, default=BackgroundJobStatus.queued
    )
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
