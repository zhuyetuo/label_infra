import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, SmallInteger, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ReviewDecision(str, enum.Enum):
    approved = "approved"
    rejected = "rejected"


class ReviewRecord(Base):
    """按轮次保留审核意见，(task_id, round_no) 唯一，历史永久保留。不做审核快照（决策⑨）。"""

    __tablename__ = "review_records"
    __table_args__ = (UniqueConstraint("task_id", "round_no", name="uq_review_task_round"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=False)
    round_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    reviewer_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    decision: Mapped[ReviewDecision] = mapped_column(Enum(ReviewDecision), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
