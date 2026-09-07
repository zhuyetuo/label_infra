from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SkinRecord(Base):
    """
    「皮肤评估 / 填写问答」的一条记录：某只狗某天某人填的问卷（6 题选项字母 + 前置题），
    加上当时算出来的问答分、以及（如果那次一起算了的话）C 值/S 总分和档位。
    对应 Gradio 版 pm_skin_scoring/data/records.csv 的一行；分值本身由 label_service
    的 /skin/* 接口按 PM 规则算，这里只存结果。
    (dog_name, fill_date, filler) 唯一——同一天同一人同一只狗重复保存就是覆盖。
    """

    __tablename__ = "skin_records"
    __table_args__ = (UniqueConstraint("dog_name", "fill_date", "filler", name="uq_skin_record_dog_date_filler"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dog_name: Mapped[str] = mapped_column(String(100), nullable=False, comment="比熊-BB 这种 PM 用的狗名")
    dog_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("dogs.id"), nullable=True)
    fill_date: Mapped[date] = mapped_column(Date, nullable=False)
    filler: Mapped[str] = mapped_column(String(50), nullable=False, comment="填写人（显示名）")
    imu: Mapped[str | None] = mapped_column(String(20), nullable=True, comment="IMU1..4，从统计数据带过来时有")

    has_hair_loss: Mapped[str | None] = mapped_column(String(2), nullable=True, comment="是/否")
    color: Mapped[str | None] = mapped_column(String(2), nullable=True, comment="选项字母 A-E")
    odor: Mapped[str | None] = mapped_column(String(2), nullable=True)
    lesion: Mapped[str | None] = mapped_column(String(2), nullable=True)
    hair_spot: Mapped[str | None] = mapped_column(String(2), nullable=True)
    hair_diameter: Mapped[str | None] = mapped_column(String(2), nullable=True)
    coat: Mapped[str | None] = mapped_column(String(2), nullable=True)

    q_score: Mapped[float | None] = mapped_column(Float, nullable=True, comment="问答分数")
    c_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    c_tier: Mapped[str | None] = mapped_column(String(4), nullable=True)
    s_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    s_tier: Mapped[str | None] = mapped_column(String(4), nullable=True)
    c_inputs: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON：算 C 值时的 10 个输入，方便回看")
    # C 值来源：ai=标注平台 AI 版 / human=标注平台人工版 / stats=扫 stats.csv / manual=手填；
    # 从标注平台拉取时两个版本的 C 值都存，历史记录里对比模型 vs 人工
    c_source: Mapped[str | None] = mapped_column(String(10), nullable=True)
    c_value_ai: Mapped[float | None] = mapped_column(Float, nullable=True)
    c_tier_ai: Mapped[str | None] = mapped_column(String(4), nullable=True)
    c_value_human: Mapped[float | None] = mapped_column(Float, nullable=True)
    c_tier_human: Mapped[str | None] = mapped_column(String(4), nullable=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SkinWeeklyRow(Base):
    """
    「周报表」一行：某个 IMU（=某只狗）某一天。36 列按 PM 模板原样存成 JSON
    （列名见 label_service /skin/options 的 weekly_report_columns），只把 imu/date
    拆出来做唯一键和排序。对应 Gradio 版 weekly_report.csv。
    """

    __tablename__ = "skin_weekly_rows"
    __table_args__ = (UniqueConstraint("imu", "report_date", name="uq_skin_weekly_imu_date"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    imu: Mapped[str] = mapped_column(String(20), nullable=False)
    dog_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    report_date: Mapped[str] = mapped_column(String(20), nullable=False, comment="2026_8_19 原样（跟推理结果目录名一致）")
    data: Mapped[str] = mapped_column(Text, nullable=False, comment="JSON {列名: 值}，36 列")

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
