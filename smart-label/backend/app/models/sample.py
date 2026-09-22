import enum
from datetime import date, datetime

from sqlalchemy import JSON, BigInteger, Boolean, Date, DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ImportStatus(str, enum.Enum):
    pending = "pending"
    verified = "verified"
    error = "error"


class Sample(Base):
    """
    原始样本：2或3路同步视频 + 1个IMU CSV，均为相对 NAS_ROOT 的相对路径。
    路数是可变的，只有 cam1 是硬性要求：
      - 早期有一批只有 cam1/cam2 两路（没有 cam3）
      - 狗场是一间一狗一摄像头，一只狗的样本天生就只有一路视频；
        更早的单摄像头录制（multi_*）也是一路
    所以 cam2/cam3 都允许为空。缺路数不是数据有问题，是场地就那样。
    """

    __tablename__ = "samples"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    # 哪只狗的样本。现在采集端文件名里还没带这个信息，所以允许为空；
    # 等文件名里带上 dog 编号之后，扫描导入会自动按编号建档/关联（见
    # sample_import_service.py），到时候新样本自然都会有，历史样本继续留空。
    dog_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("dogs.id"), nullable=True)
    session_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)

    video_cam1_path: Mapped[str] = mapped_column(String(500), nullable=False)
    video_cam2_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    video_cam3_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 每路视频各自的时间偏移 {"cam2": -4171}：**这一路的第 0 秒在样本时间轴上是第几毫秒**。
    # 空 / 缺键 = 0，跟样本同一个原点（绝大多数样本都是这样，行为不变）。
    # 只有跨 session 挂过来的那一路才有值——狗场两台采集机各自开机，时间戳差几秒，
    # 而 cam7 一台俯拍看的是全部六间，挂给另一台那三间时必须带上这个差值，
    # 否则那一路上每一条标注都差几秒，而且错得看不出来
    video_offsets_ms: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    imu_csv_path: Mapped[str] = mapped_column(String(500), nullable=False)
    ai_label_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    video_duration_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)
    video_fps: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    video_resolution: Mapped[str | None] = mapped_column(String(20), nullable=True)
    imu_sample_rate_hz: Mapped[int | None] = mapped_column(Integer, nullable=True)
    imu_row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 这份 CSV 的采样率。不是所有样本都一样：8-11 之前采集端就已经降到 16Hz 存了，
    # 8-11 起才是 50Hz 原始流。按错的频率跑推理，重采样和特征窗口全错
    sample_hz: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    import_status: Mapped[ImportStatus] = mapped_column(
        Enum(ImportStatus), nullable=False, default=ImportStatus.pending
    )
    import_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    remark: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # 含敏感隐私信息：只有管理员/超级管理员能看到、能标注，其他角色在任何接口里都
    # 碰不到（见 services/task_scope.py）。确认不敏感了可以解除。
    is_sensitive: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    sensitive_note: Mapped[str | None] = mapped_column(String(200), nullable=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
