from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.model_version import ModelTrainStatus


class DatasetSpecIn(BaseModel):
    date: str
    extra_date: list[str] = []
    missing_strategy: str | None = None
    skip_syn: bool = False
    # 用标注平台导出的数据集训练时带上：NAS 相对路径的 Label Studio 格式 JSON。
    # AI 服务会把它整理成 data/raw_custom/<date>/merged_tmp.json 再跑 train_custom.sh
    export_json: str | None = None
    source_hz: int | None = None
    hz: int | None = None
    clean: bool = False


class TrainSubmitIn(BaseModel):
    dataset: DatasetSpecIn
    model_type: str = "rf"
    tag: str | None = None


class ModelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    algo_job_id: int
    status: ModelTrainStatus
    model_type: str
    model_version: str | None
    model_path: str | None
    error: str | None
    dataset_spec: str
    metrics: str | None
    created_at: datetime
    updated_at: datetime


class PrelabelItem(BaseModel):
    """一段 AI 预测出来的行为，时间已经换算成相对 IMU CSV 起点的毫秒数——
    跟标注工作台里 LabelItem 用的是同一个时间基准，前端拿到就能直接画色块。"""

    label_name: str
    start_time_ms: int
    end_time_ms: int
    confidence: float


class PrelabelResult(BaseModel):
    """
    imu_train/label_service 的 /infer 返回的是按类别分组的 segments
    （{类别: [{start_ts, end_ts, conf_max, ...}]}，start_ts 是绝对墙钟时间字符串），
    后端在 ai_prelabel 里摊平并换算成相对毫秒后给前端，前端不用管时间戳换算。
    """

    sample_id: int
    ai_label_path: str
    items: list[PrelabelItem]
    n_windows: int
    # 时间戳为空/换算出来时长非正的片段数，前端提示用
    skipped: int
