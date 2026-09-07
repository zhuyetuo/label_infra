from datetime import date as _date
from datetime import datetime

from sqlalchemy import BigInteger, Date, DateTime, Float, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SkinDailyStat(Base):
    """
    「项目联动」算出来的每天每只狗的抓挠日统计，一行 = (日期, IMU, 来源)。
    来源 source：ai = 预标注的原始结果；human = 任务里当前的人工片段。

    存下来有三个好处，都是之前每次现算做不到的：
      1. 切页面/换电脑/重登录都还在，不用每次等几十秒重算；
      2. 基线（前几天的中位数）能用**全部历史天数**算，不再只看这次选的日期范围——
         范围里只有一天时基线为 0、变化幅度不计分，C 值上限只有 70；
      3. 周报表、C 值计算这些地方可以直接读，不用各自再扫一遍 NAS。

    events 存的是当天该来源的抓挠事件时间对，重算基线时要用（label_service 的
    /skin/stats/from-events 吃的是事件，不是聚合后的数字）。
    """

    __tablename__ = "skin_daily_stats"
    __table_args__ = (UniqueConstraint("stat_date", "imu", "source", name="uq_skin_daily_date_imu_source"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    stat_date: Mapped[_date] = mapped_column(Date, nullable=False, index=True)
    imu: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False, comment="ai / human")

    events: Mapped[str] = mapped_column(Text, nullable=False, comment='JSON [[start_ts, end_ts], ...]')
    wear_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # 下面几个是算完之后的结果，读的时候不用再调 AI 服务
    stats: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON：日统计那一行")
    c_inputs: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON：C 值的输入")
    c_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    c_tier: Mapped[str | None] = mapped_column(String(4), nullable=True)
    # 任务进度 / AI 用的哪个版本，前端表格要显示
    tasks: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON：各状态任务数")
    ai_mode: Mapped[str | None] = mapped_column(String(40), nullable=True)

    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
