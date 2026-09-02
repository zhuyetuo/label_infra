import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MediaFileType(str, enum.Enum):
    raw_video = "raw_video"
    raw_imu_csv = "raw_imu_csv"
    ai_label_json = "ai_label_json"
    clip_video = "clip_video"


class MediaFile(Base):
    """
    统一的 NAS 相对路径索引。前端永远只持有这张表的主键(file_id)，从不接触真实路径。
    file.py 的路径解析必须经过 services/media_resolver.py，禁止在路由层直接拼路径。
    """

    __tablename__ = "media_files"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    file_type: Mapped[MediaFileType] = mapped_column(Enum(MediaFileType), nullable=False)
    # 相对 NAS_ROOT 的相对路径，如 data_raw/2026-06-03/26060315/cam1.mp4
    relative_path: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False, default="application/octet-stream")
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
