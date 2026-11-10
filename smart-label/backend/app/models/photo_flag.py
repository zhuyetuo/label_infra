from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PhotoFlag(Base):
    """
    单张照片拍得不合格（模糊 / 太暗 / 没拍到皮肤…）的标记。
    评级是对一只狗一次问诊整体给的；可「看不清」常常只是其中几张，得落到具体哪张、什么问题，
    回头才能汇总给狗场：哪天哪只狗第几张怎么不行、下次拍注意什么。一张照片只记一条（谁最后标的算谁的）。
    """

    __tablename__ = "photo_flags"
    __table_args__ = (UniqueConstraint("album", "folder", "dog_folder", "filename", name="uq_photo_flag"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    album: Mapped[str] = mapped_column(String(20), nullable=False, default="skin")
    folder: Mapped[str] = mapped_column(String(200), nullable=False, comment="日期目录（含来源前缀）")
    dog_folder: Mapped[str] = mapped_column(String(200), nullable=False, comment="狗名目录")
    filename: Mapped[str] = mapped_column(String(200), nullable=False)
    reason: Mapped[str] = mapped_column(String(20), nullable=False, comment="blurry/dark/no_skin/blocked/far/other")
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
