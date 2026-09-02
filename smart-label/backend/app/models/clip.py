import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ClipSource(str, enum.Enum):
    ai = "ai"  # 落盘到 clip_cache/ai_clip_segments
    human = "human"  # 落盘到 clip_cache/human_clip_segments


class ClipJobStatus(str, enum.Enum):
    queued = "queued"
    processing = "processing"
    done = "done"
    failed = "failed"


class ClipJob(Base):
    """
    ffmpeg 切片异步队列。同一 (sample, clip_source, camera_channel, 时间段) 幂等去重，
    交互式框选(priority=10)优先于AI批量生成(priority=1)，独立 worker 用
    SELECT...FOR UPDATE SKIP LOCKED 按 (status, priority DESC) 抢占，完成后通过 SSE 通知前端。
    """

    __tablename__ = "clip_jobs"
    __table_args__ = (
        UniqueConstraint(
            "sample_id", "clip_source", "camera_channel", "start_time_ms", "end_time_ms",
            name="uq_clip_dedup",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("samples.id"), nullable=False)
    task_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=True)
    clip_source: Mapped[ClipSource] = mapped_column(Enum(ClipSource), nullable=False)

    start_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    camera_channel: Mapped[int] = mapped_column(SmallInteger, nullable=False, comment="1/2/3，三路各生成一条job")

    status: Mapped[ClipJobStatus] = mapped_column(Enum(ClipJobStatus), nullable=False, default=ClipJobStatus.queued)
    priority: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=5)

    clip_file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)

    requested_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
