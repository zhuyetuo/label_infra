import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ToothPhotoResult(Base):
    """
    一张口腔照片最近一次 YOLO 检测的结果。照片本身在素材库 NAS 上
    （material_root/oral_dir/{日期目录}/{狗名目录}/文件），这里只存相对
    oral_dir 的路径 + 检测结果 JSON，页面列目录时靠这张表给每张图挂"检出了
    什么"的角标；重新检测就整行覆盖（rel_path 唯一）。
    """

    __tablename__ = "tooth_photo_results"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    rel_path: Mapped[str] = mapped_column(String(500), unique=True, nullable=False, comment="相对 oral_dir 的路径")
    folder: Mapped[str] = mapped_column(String(100), nullable=False, comment="日期目录名，如 2026-09-02-ok")
    dog_folder: Mapped[str] = mapped_column(String(100), nullable=False, comment="狗名目录，如 Bali")
    dog_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("dogs.id"), nullable=True)

    detections: Mapped[str] = mapped_column(Text, nullable=False, comment="JSON 列表 [{class_name, confidence, box}]")
    n_detections: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    top_class: Mapped[str | None] = mapped_column(String(100), nullable=True, comment="置信度最高的类别")
    top_conf: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_conf: Mapped[float] = mapped_column(Float, nullable=False, comment="检测时用的置信度阈值")
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)

    detected_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    detected_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
