import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ModelTrainStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class ModelVersion(Base):
    """
    algo_service 训练任务在 label_infra 这边的记录。提交 /train 时立刻插一行
    status=queued，algo_job_id 存 algo_service 返回的 job_id；之后要么靠轮询
    （app/services/algo_client.py 的 poll_train）、要么靠 algo_service 训练完
    主动回调（POST /api/v1/model-versions/{algo_job_id}/callback），把
    model_version/model_path/metrics 写回这一行、status 改成 done/failed。

    model_path 是 algo_service 那台机器上的路径（不是 NAS 相对路径——训练产出
    暂时留在 algo_service 自己那边，没有自动同步/发布到线上，这张表只是记录
    "训练出过什么、效果怎样"，实际换模型仍是运维手动操作，见 algo_service
    modules/label_pipeline/trainer.py 里的说明）。
    """

    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    algo_job_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True, comment="algo_service 那边的 job_id")
    status: Mapped[ModelTrainStatus] = mapped_column(Enum(ModelTrainStatus), nullable=False, default=ModelTrainStatus.queued)

    model_type: Mapped[str] = mapped_column(String(32), nullable=False)
    dataset_spec: Mapped[str] = mapped_column(Text, nullable=False, comment="JSON字符串，提交训练时的date/extra_date等参数")

    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    metrics: Mapped[str | None] = mapped_column(Text, nullable=True, comment="JSON字符串，训练脚本产出的指标")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
