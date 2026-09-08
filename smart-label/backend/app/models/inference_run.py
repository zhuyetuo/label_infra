from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SampleInferenceRun(Base):
    """
    一个样本被某个模型、某个版本跑出来的一份 AI 结果。

    之前一个样本只有一份结果 JSON，重跑就覆盖——换模型重跑一次，旧的当场消失，
    "以前能识别出来的现在还行不行"这种问题根本没法回答。现在每个
    (样本, 模型, 版本) 各存一份，谁也不盖谁，这张表就是它们的索引：

      - 工作台要显示"现在这些片段是谁跑的"、能列出还有哪些版本可选
      - 模型对比要按 (模型, 版本) 把两份结果调出来逐条配对
      - 训练完新模型，对同一批数据重跑一遍，跟旧的并排看回归

    结果本身还是落在 NAS（json_path），这里只存索引和几个概览数字——JSON 里
    windows 有几千条，塞进数据库既没必要也查不动。
    """

    __tablename__ = "sample_inference_runs"
    __table_args__ = (
        UniqueConstraint("sample_id", "model_tag", "mode", name="uq_infer_run_sample_model_mode"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    sample_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("samples.id"), nullable=False, index=True)
    # 模型文件名去掉后缀，比如 scratch_rf_20260901。同一个模型换个路径也算同一个
    model_tag: Mapped[str] = mapped_column(String(120), nullable=False)
    model_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, comment="stable / viterbi / raw")

    json_path: Mapped[str] = mapped_column(String(500), nullable=False, comment="NAS 相对路径")
    n_windows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    n_segments: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    n_candidates: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    missing_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # {类别: 段数}，对比时先看这个就知道差在哪一类
    label_counts: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON {label: n}")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
