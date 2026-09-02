import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    SmallInteger,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TaskType(str, enum.Enum):
    from_scratch = "from_scratch"  # 从零标注 -> data_labeled_human_only
    ai_assisted = "ai_assisted"  # AI预标注+人工修改 -> data_labeled_ai_revised


class TaskStatus(str, enum.Enum):
    PENDING_ASSIGN = "PENDING_ASSIGN"
    IN_PROGRESS = "IN_PROGRESS"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class Task(Base):
    """
    标注任务。segment_start_ms/segment_end_ms 均为 NULL 表示覆盖整个样本（长任务），
    否则表示样本内的一个子时间段（短任务）；两者可在同一 sample 下并存。
    """

    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint(
            "(segment_start_ms IS NULL AND segment_end_ms IS NULL) OR "
            "(segment_start_ms IS NOT NULL AND segment_end_ms IS NOT NULL AND segment_end_ms > segment_start_ms)",
            name="chk_segment_range",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("samples.id"), nullable=False)
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType), nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus), nullable=False, default=TaskStatus.PENDING_ASSIGN
    )

    segment_start_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    segment_end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_task_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=True)

    round_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)

    assigned_to: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    reviewer_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)

    # 软锁：认领时写入，超时未续期由定时任务回收
    locked_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    lock_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
