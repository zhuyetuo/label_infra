import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RecordSourceType(str, enum.Enum):
    human_only = "human_only"  # 从零标注 -> data_labeled_human_only
    ai_revised = "ai_revised"  # AI预标注+人工修改 -> data_labeled_ai_revised


class LabelItemSource(str, enum.Enum):
    ai_generated = "ai_generated"
    human_added = "human_added"


class AnnotationRecord(Base):
    """
    某任务某一轮的标注草稿/提交快照。同一 (task_id, round_no) 反复保存 = UPSERT 同一行；
    round_no 递增，历史行只增不改，驳回重标可完整追溯。
    """

    __tablename__ = "annotation_records"
    __table_args__ = (UniqueConstraint("task_id", "round_no", name="uq_annotation_task_round"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=False)
    round_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    source_type: Mapped[RecordSourceType] = mapped_column(Enum(RecordSourceType), nullable=False)

    # 标注结果整体导出后落盘的 NAS 相对路径（data_labeled_human_only / data_labeled_ai_revised 下）
    result_file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AnnotationLabelItem(Base):
    """
    标签级溯源：逐条行为标签记录，同一 annotation_record 内时间区间不允许重叠
    （应用层在 submit 时强制校验，草稿阶段允许暂时重叠）。
    """

    __tablename__ = "annotation_label_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    annotation_record_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("annotation_records.id"), nullable=False
    )
    label_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("label_definitions.id"), nullable=False)

    start_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    source_type: Mapped[LabelItemSource] = mapped_column(Enum(LabelItemSource), nullable=False)
    is_modified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, comment="AI标签是否被人工修改过"
    )
    ai_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    # 实际标注这一条的用户；AI生成的为 NULL；任务被中途转手也能按人追溯
    created_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
