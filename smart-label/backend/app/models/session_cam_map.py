from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SessionCamMap(Base):
    """一场录制里「文件名的机位号 → 实际拍的是几号间」。

    狗场两台采集机各录一半房间。摄像头 USB 重插后枚举顺序会变，采集端
    `sites/*.env` 里 CAMERAS 的第二列没跟着改的话，文件名还是 cam1，可画面
    已经是另一个房间——平台按 camN 判房间，从此 A 房间的狗配着 B 房间的画面。

    人看画面确认后在「机位核对」页改一次，这里按 session（文件名里那串开机
    时刻）存下来：自动扫描之后照样按这份算，不会被改回去。
    """

    __tablename__ = "session_cam_maps"
    __table_args__ = (UniqueConstraint("session_key", name="uq_session_cam_map"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    site: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # {"1": 2, "2": 1, "7": 7}：文件里写的是 cam1，实际拍的是 2 号单间
    mapping: Mapped[dict] = mapped_column(JSON, nullable=False)
    updated_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
