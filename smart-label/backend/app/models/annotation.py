import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RecordSourceType(str, enum.Enum):
    human_only = "human_only"  # 从零标注 -> data_labeled_human_only
    ai_revised = "ai_revised"  # AI预标注+人工修改 -> data_labeled_ai_revised


class LabelItemSource(str, enum.Enum):
    ai_generated = "ai_generated"
    human_added = "human_added"


class AnnotationRecord(Base):
    """
    某任务某一轮的标注草稿/提交快照。同一 (task_id, round_no) 反复保存 = UPSERT 同一行；
    round_no 递增，历史行只增不改，驳回重标可完整追溯。
    """

    __tablename__ = "annotation_records"
    __table_args__ = (UniqueConstraint("task_id", "round_no", name="uq_annotation_task_round"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("tasks.id"), nullable=False)
    round_no: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    source_type: Mapped[RecordSourceType] = mapped_column(Enum(RecordSourceType), nullable=False)

    # 标注结果整体导出后落盘的 NAS 相对路径（data_labeled_human_only / data_labeled_ai_revised 下）
    result_file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AnnotationLabelItem(Base):
    """
    标签级溯源：逐条行为标签记录，同一 annotation_record 内时间区间不允许重叠
    （应用层在 submit 时强制校验，草稿阶段允许暂时重叠）。
    """

    __tablename__ = "annotation_label_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    annotation_record_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("annotation_records.id"), nullable=False
    )
    label_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("label_definitions.id"), nullable=False)

    start_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_time_ms: Mapped[int] = mapped_column(Integer, nullable=False)

    source_type: Mapped[LabelItemSource] = mapped_column(Enum(LabelItemSource), nullable=False)
    is_modified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, comment="AI标签是否被人工修改过"
    )
    ai_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    # AI 标签被人看过并确认正确。改过类别/起止会自动清掉，需要再确认一次
    ai_confirmed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0", comment="AI标签是否已被人工确认为正确"
    )
    # 「待定」：看了也拿不准（画面里没拍到狗、动作看不清），既不能确认成抓挠也不
    # 舍得删。留着当记录，但不进训练集——导出时这段时间会从所有片段里挖掉，
    # 免得它以"活动/睡觉"的身份混成负样本，教坏模型
    uncertain: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0", comment="待定：拿不准，不参与训练"
    )
    # 待定的两种情况，复看时想知道是哪一种：
    #   no_view    画面里根本没拍到狗，无从判断
    #   ambiguous  拍到了，但动作像抓挠又不太像
    #   needs_split 确实是抓挠，但这一段里混了甩身体/走路，起止要调、要拆细，
    #              暂时没时间弄——跟前两种不一样，这个是排期问题不是判断问题
    # 两种都不进训练集，区别只在"以后补拍/回看还有没有救"
    uncertain_reason: Mapped[str | None] = mapped_column(
        String(16), nullable=True, comment="待定原因：no_view / ambiguous / needs_split"
    )
    # 标记：看的时候发现、但暂时没空处理的问题，回头能按标记找回来。可以打好几个，逗号分开的代码：
    #   compound   一段里混了好几个类别，要拆
    #   boundary   在两个类别的边界上，拿不准
    #   unclear    画面看不清狗（太暗 / 被挡住 / 跑出画面），回头再看
    #   av_mismatch 画面跟 IMU 对不上（可能戴错了 / 还没戴上 / 时间没对齐）
    #   other      其它（具体写在 mark_note 里）
    # 跟「待定」不是一回事：待定是「拿不准，不进训练集」，标记只是记号，不影响导出
    marks: Mapped[str | None] = mapped_column(String(200), nullable=True, comment="标记，逗号分开：compound / boundary / av_mismatch / other")
    mark_note: Mapped[str | None] = mapped_column(String(300), nullable=True, comment="标记的备注")
    # 这条是从哪个「疑似抓挠」候选确认上来的。留着是为了能退回去：人当时可能
    # 走神点错了，回头发现不对，删掉之后那条候选也该回到「待确认」重新判断，
    # 而不是永远消失
    from_candidate_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("ai_candidates.id"), nullable=True, comment="从哪条候选确认来的"
    )

    # AI 当初给的判断（类别、起止）。AI 生成时写入，之后人怎么改都不动——
    # 这样「AI 判的舔 → 人改成活动」才能一眼看出来。is_modified 只说"改过"，
    # 说不出原来是什么。人工新画的、从疑似片段确认来的都是 NULL（后者的出处看
    # from_candidate_id 那条候选）。加这几列之前改过的老数据也是 NULL，原值已经找不回来
    ai_label_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("label_definitions.id"), nullable=True, comment="AI 原始类别"
    )
    ai_start_ms: Mapped[int | None] = mapped_column(Integer, nullable=True, comment="AI 原始开始")
    ai_end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True, comment="AI 原始结束")

    # 审核时标出来的「这一条有问题」：原因（类别错了 / 起止不准…）、谁标的、什么时候。
    # 以前只能整个任务退回，标注员拿回去不知道该看哪几条；有了这个，退回时只需要
    # 改这几条。驳回 / 退回重标开新一轮时跟着带过去；标注员改了这条（类别或起止）
    # 就自动清掉，也可以手动标「已改好」清掉
    review_note: Mapped[str | None] = mapped_column(String(300), nullable=True, comment="审核标的问题")
    review_flag_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    review_flag_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # 起止每被人改一次记一笔：[{"from": [起, 止], "to": [起, 止], "by": 用户 id, "by_name": 名字,
    # "at": 时间}, ...]，最早的在前。一段可能被调好几次（先粗标、再在波形上抠精确的起止），
    # 光一个 is_modified 看不出改过几次、从哪改到哪。开新一轮时跟着带过去
    boundary_edits: Mapped[str | None] = mapped_column(Text, nullable=True, comment="起止调整记录 JSON")

    # 片段级审核（「片段审核」页）：不用等整个任务标完提交，按类别一条条审。
    #   seg_status   空 = 待审 / approved = 通过 / returned = 退回（原因写在 review_note）
    #   类别或起止被人改了就回到待审——改过的东西要重新看一眼
    # 认领：审核员按类别领一批，领了别人看不到，过期（seg_claim_expires_at）自动放回
    seg_status: Mapped[str | None] = mapped_column(String(12), nullable=True, index=True,
                                                   comment="片段审核：空=待审 / approved / returned")
    seg_reviewed_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    seg_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    seg_claimed_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True, index=True)
    seg_claim_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 数据池（「模型训练 → 数据池」）：人认可的高质量片段库，每次训练从里面挑一部分。
    #   空 = 自动：审核通过（seg_status=approved）就在池里
    #   in = 手动加入（认可的历史数据整批加进来）/ out = 手动移出
    #   人改了起止 / 类别，手动加入的也失效（跟审核通过一样，改过的要重新认可）
    pool_state: Mapped[str | None] = mapped_column(String(4), nullable=True, index=True,
                                                   comment="数据池：空=自动（审核通过即在池）/ in=手动加入 / out=手动移出")
    # 手动加入数据池的时间。审核通过进来的用 seg_reviewed_at；「刚进池的先」按这两个排
    pool_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, comment="手动加入数据池的时间")

    # 人最后一次动这条（改起止/类别、确认、标待定）的时间和人。created_at 对 AI 给的片段
    # 是机器写入的时刻，算不出"人什么时候确认的"——每一类片段的确认耗时靠这两列
    touched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    touched_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    # 实际标注这一条的用户；AI生成的为 NULL；任务被中途转手也能按人追溯
    created_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
