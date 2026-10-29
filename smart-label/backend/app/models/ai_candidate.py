import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Float, ForeignKey, Integer, SmallInteger, String, Text, func
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
    疑似片段候选（界面上叫「疑似片段」，以前叫「疑似抓挠」）：抓挠 / 舔 / 进食 / 饮水 / 吠叫……
    最早只有抓挠这一类——AI 预标注（稳定版/v2）为了准把一部分真抓挠也滤掉了，label_service
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
    reason: Mapped[str] = mapped_column(String(20), nullable=False, comment="low_conf / spectral / grooming / eating / drinking / barking / shaking / toileting / vision / similar")
    # 画面候选（reason=vision）是哪家哪个模型给的，如 anthropic:claude-opus-5。
    # 同一批任务用两个模型各跑一遍，就能按这个对比谁更准。IMU 来的候选为空
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # 模型看到了什么 + 为什么这么判。人复核时的第一眼信息：不对的话不用点开视频
    # 就能排掉。也是调试用的——「侧卧，头转向身后，口鼻接触左后肢」说明看懂了，
    # 「一只狗趴在地毯上」说明根本没看清，这两种的解法完全不同。IMU 来的候选为空
    evidence: Mapped[str | None] = mapped_column(String(300), nullable=True)
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
    # 审核标的「这条判断有问题」（比如改成了活动，其实是舔）。跟已标注片段上的同一套：
    # 开新一轮时跟着过去；标注员重新判断这条（确认 / 改类别 / 排除 / 待定）就清掉
    review_note: Mapped[str | None] = mapped_column(String(300), nullable=True, comment="审核标的问题")
    review_flag_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    review_flag_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 起止每被人调一次记一笔（跟已标注片段上的 boundary_edits 同一个格式）。
    # 确认成片段时带过去，片段上就能看到它在候选阶段就被调过几次
    boundary_edits: Mapped[str | None] = mapped_column(Text, nullable=True, comment="起止调整记录 JSON")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
