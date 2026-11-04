from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SkinPhotoRating(Base):
    """
    看皮肤照片给一只狗那一次问诊评级（兽医 / 实习生各评各的，方便对照一致性）。
    照片本身在素材库 NAS 上按 {日期目录}/{狗名目录}/*.jpg 放着，这里按 (相册, 日期目录, 狗名目录, 评级人) 记一条。
    档位跟产品的 S 档对齐：S0 正常 / S1 轻度 / S2 中重度，另加 unsure（照片看不清、判断不了）。
    """

    __tablename__ = "skin_photo_ratings"
    __table_args__ = (UniqueConstraint("album", "folder", "dog_folder", "user_id", name="uq_skin_photo_rating"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    album: Mapped[str] = mapped_column(String(20), nullable=False, default="skin")
    folder: Mapped[str] = mapped_column(String(200), nullable=False, comment="日期目录（含来源前缀），如 博朗旺-狗场合作/博朗旺20261103")
    dog_folder: Mapped[str] = mapped_column(String(200), nullable=False, comment="狗名目录，如 002拉布拉多小七")
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False, index=True)
    grade: Mapped[str] = mapped_column(String(10), nullable=False, comment="S0 / S1 / S2 / unsure")
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
