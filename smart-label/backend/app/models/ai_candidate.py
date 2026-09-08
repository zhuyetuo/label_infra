import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Float, ForeignKey, Integer, SmallInteger, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CandidateStatus(str, enum.Enum):
    pending = "pending"
    confirmed = "confirmed"
    rejected = "rejected"
    # 看了拿不准：画面里没拍到狗，或者拍到了但像抓挠又不太像。跟正式片段上的
    # 「待定」一个意思——既不确认也不排除，这段时间从训练集里挖掉
    uncertain = "uncertain"


class AiCandidate(Base):
    """
    疑似抓挠候选：AI 预标注（稳定版/v2）为了准把一部分真抓挠也滤掉了，label_service
    用低门槛再抽一遍（模型低置信 / 频谱像抓挠）给人工看。不进任务草稿，单独一张表：
    人工在工作台里「确认」就变成正式片段，「排除」记下来当负反馈。两种决定都是
    以后重训模型最有价值的数据（确认 = 模型漏检的正样本，排除 = 误报）。
    """

    __tablename__ = "ai_candidates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=False, index=True)
    round_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    label_name: Mapped[str] = mapped_column(String(50), nullable=False)
    start_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    spec: Mapped[float | None] = mapped_column(Float, nullable=True, comment="陀螺仪 4–8Hz 能量占比")
    reason: Mapped[str] = mapped_column(String(20), nullable=False, comment="low_conf / spectral")
    status: Mapped[CandidateStatus] = mapped_column(
        Enum(CandidateStatus), nullable=False, default=CandidateStatus.pending, server_default="pending"
    )
    # 确认成了哪个类别。空 = 就是抓挠；有值 = 人看完判成别的动作（多半是甩身体），
    # 这种既是那个类别的正例，也是抓挠最缺的难负样本，值得单独记一笔
    decided_label_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("label_definitions.id"), nullable=True, comment="确认成了哪个类别，空=抓挠"
    )
    # 待定的哪一种：no_view / ambiguous / needs_split，跟片段上的 uncertain_reason 同一套
    uncertain_reason: Mapped[str | None] = mapped_column(
        String(16), nullable=True, comment="待定原因：no_view / ambiguous / needs_split"
    )
    decided_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
