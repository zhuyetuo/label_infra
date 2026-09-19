from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CamRegion(Base):
    """公用机位（狗场天花板 cam7）画面里，每个单间占哪一块。

    cam7 是固定机位，一次能看到全部单间；单间自己的摄像头有死角，两路互补。要把 cam7
    里检出来的狗算到某个单间头上，就得知道"画面里哪一块是几号间"——这是人在画面上框
    出来的，归一化坐标（0~1），换分辨率不用重画。一个场地一个机位一个房间一行。
    """

    __tablename__ = "cam_regions"
    __table_args__ = (UniqueConstraint("site", "cam", "room", name="uq_cam_region"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    site: Mapped[str] = mapped_column(String(20), nullable=False, comment="场地：gouchang")
    cam: Mapped[int] = mapped_column(Integer, nullable=False, comment="公用机位号，如 7")
    room: Mapped[int] = mapped_column(Integer, nullable=False, comment="这块是几号单间（= 那间自己的机位号）")
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    w: Mapped[float] = mapped_column(Float, nullable=False)
    h: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
