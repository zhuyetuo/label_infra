from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, SmallInteger, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LabelDefinition(Base):
    """
    行为标签体系，管理员通过后台 CRUD 维护，不写死为 ENUM。
    parent_id 预留分层字段，当前阶段一律为 NULL（不启用分层）。

    标签属于某个项目：同一份数据在不同项目里要标的东西不一样，所以 code 只在
    项目内唯一，不同项目可以各自有同名的 code。
    """

    __tablename__ = "label_definitions"
    __table_args__ = (UniqueConstraint("project_id", "code", name="uq_label_project_code"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("projects.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    display_name: Mapped[str] = mapped_column(String(50), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    parent_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("label_definitions.id"), nullable=True)
    sort_order: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
