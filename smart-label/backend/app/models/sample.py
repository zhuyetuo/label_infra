import enum
from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, Enum, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ImportStatus(str, enum.Enum):
    pending = "pending"
    verified = "verified"
    error = "error"


class Sample(Base):
    """
    原始样本：2或3路同步视频 + 1个IMU CSV，均为相对 NAS_ROOT 的相对路径。
    历史数据里有一批只有cam1/cam2两路（没有cam3），video_cam3_path 允许为空
    以兼容这批数据；cam1/cam2 是硬性要求，任何样本都至少有这两路。
    """

    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    dog_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    session_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    video_cam1_path: Mapped[str] = mapped_column(String(500), nullable=False)
    video_cam2_path: Mapped[str] = mapped_column(String(500), nullable=False)
    video_cam3_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    imu_csv_path: Mapped[str] = mapped_column(String(500), nullable=False)
    ai_label_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    video_duration_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)
    video_fps: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    video_resolution: Mapped[str | None] = mapped_column(String(20), nullable=True)
    imu_sample_rate_hz: Mapped[int | None] = mapped_column(Integer, nullable=True)
    imu_row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    import_status: Mapped[ImportStatus] = mapped_column(
        Enum(ImportStatus), nullable=False, default=ImportStatus.pending
    )
    import_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    remark: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
