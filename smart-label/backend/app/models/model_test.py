from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ModelTestSet(Base):
    """
    模型测试集：挑出来专门给模型「考试」的数据，一批一个版本（v1 冻结后补数据就复制成 v2 再加）。
    测试集里的样本**任何训练导出都不要**（training_export_service 里排除），否则测试就作废了。
    冻结（frozen_at 不空）之后不能再增删，报告上注明用的哪一版，前后才比得了。
    """

    __tablename__ = "model_test_sets"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, comment="冻结时间；冻结后不能增删")
    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ModelTestItem(Base):
    """
    测试集里的一段：某个任务（= 某个样本）里的一个时间窗。start_ms/end_ms 为空 = 整个任务。
    窗口外的时间也不进训练——排除按整个样本算，防止相邻几秒「漏」进训练集。
    """

    __tablename__ = "model_test_items"
    __table_args__ = (UniqueConstraint("set_id", "task_id", "start_ms", name="uq_model_test_item"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    set_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("model_test_sets.id"), nullable=False, index=True)
    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=False)
    sample_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("samples.id"), nullable=False, index=True)
    start_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 人工核对过这一段（看了窗口里的片段，该调的调了）。打分可以只用核对过的
    checked_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    added_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
