"""
一份样本的某一路视频，画面里有没有狗。

结果来自 vision_service 的 /api/v1/dog/scan（COCO 预训练权重，不训练不微调）。
存下来是为了让样本/任务列表**不用点进去就知道这段该不该看**——一整段没狗的
片段，标注员现在只有看到波形是平的、或者点开视频才发现。

── 为什么一路一行，不是一份样本一行 ────────────────────────────────────

影棚一份样本有三路视频，三路拍的是同一个大空间的不同角度：cam1 里没狗不代表
cam2 里没狗。合成一行的话要么丢信息，要么得在一列里塞三份 JSON——后者迟早
被当成"一份样本一个结论"读错。

── 存什么不存什么 ──────────────────────────────────────────────────────

汇总（verdict / 无狗比例 / 最大只数）+ 逐采样点的 `[[秒, 几只], ...]`。

**不存框**。框在第三步（这只狗在不在画面里）和第四步（画面抓挠对不对得上
IMU）都用不上——那两步要的是"什么时候有几只"，不是"在画面哪个位置"。
一小时按 5 秒采样是 720 个点，只存 [t, n] 是几 KB；连框一起存是几百 KB，
几千份样本就是好几 G，而且列表接口每次都要读。真要框的时候重扫一遍就行，
扫描本来就是幂等的。
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

#: 扫描结论。跟 vision_service 那边一字不差——两边对不上的话，平台会把一个
#: 没见过的 verdict 当成"未知"处理，而 unknown 在这里是有特定含义的。
VERDICTS = ("no_dog", "mostly_empty", "has_dog", "unknown")

#: 扫描本身失败（服务没起、视频读不出、显存不够）。跟 unknown **不是一回事**：
#: unknown 是"扫了但一帧都没采到"，failed 是"压根没扫成"。两个都不能当成
#: "确认没狗"——那会让人跳过一整段真有素材的视频。
STATE_OK = "ok"
STATE_FAILED = "failed"


class SampleVisionScan(Base):
    __tablename__ = "sample_vision_scans"
    __table_args__ = (
        # 一份样本的一路视频只留最新一次结果，重扫就覆盖
        Index("ux_sample_vision_scans_sample_cam", "sample_id", "cam", unique=True),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("samples.id", ondelete="CASCADE"), nullable=False)
    cam: Mapped[str] = mapped_column(String(10), nullable=False, comment="cam1 / cam2 / cam3")

    state: Mapped[str] = mapped_column(String(10), nullable=False, default=STATE_OK, comment="ok / failed")
    error: Mapped[str | None] = mapped_column(String(500), nullable=True, comment="state=failed 时为什么")

    verdict: Mapped[str | None] = mapped_column(String(20), nullable=True, comment=str(VERDICTS))
    no_dog_ratio: Mapped[float | None] = mapped_column(
        Numeric(5, 3), nullable=True,
        comment="采样点里没狗的比例。**扫不成时必须为 NULL**，不能填 1——那会被读成「确认没狗」",
    )
    max_dogs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sampled: Mapped[int | None] = mapped_column(Integer, nullable=True, comment="一共采了几个点")
    frames_with_dog: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_sec: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)

    # MEDIUMTEXT：带框之后一小时一只狗约 25KB，两三只就顶到 TEXT 的 64KB 了
    timeline: Mapped[str | None] = mapped_column(
        Text(length=16777215), nullable=True,
        comment="JSON [[秒, 几只, [[x,y,w,h,conf],...]], ...]，给第3/4步按时间对齐、复查画面叠框用",
    )

    every_sec: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    conf: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)
    weights: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
        comment="哪份权重扫的。换了型号之后老结果还留着，不记下来就分不清哪些该重扫",
    )

    scanned_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
