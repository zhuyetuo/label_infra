from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class LocalModelStat(Base):
    """算法机上本地模型（狗检测 / SAM / 画面向量 / 姿态 / vLLM）的调用量，按小时一行。

    视觉服务的计数在它自己进程内存里，重启归零、也没有时间维度。平台每几分钟拉一次
    快照，跟上一次比出差值记到当前小时这一行（计数变小了就当它重启过、差值 = 当前值）。
    有了这张表，「调用统计」页才能按天 / 周 / 月看每个模型的用量。
    """

    __tablename__ = "local_model_stats"
    __table_args__ = (UniqueConstraint("model_key", "hour", name="uq_local_model_stat_hour"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_key: Mapped[str] = mapped_column(String(20), nullable=False, index=True, comment="dog / sam / embed / pose / vllm")
    hour: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True, comment="整点")
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    frames: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)


class LocalModelSnapshot(Base):
    """上一次从视觉服务拉到的累计计数（每个模型一行）。差值要跟它比。

    存库而不是存进程内存：API 进程（打开统计页时即时采一次）和调度器进程（每 5 分钟）
    都要采，各自记内存快照会把同一段量算两遍。
    """

    __tablename__ = "local_model_snapshots"

    model_key: Mapped[str] = mapped_column(String(20), primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    frames: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_ms: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    taken_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
