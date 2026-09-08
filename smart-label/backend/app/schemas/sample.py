from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models.sample import ImportStatus


class SampleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sample_code: str
    dog_id: int | None
    session_date: date | None
    video_cam1_path: str
    video_cam2_path: str
    video_cam3_path: str | None
    imu_csv_path: str
    ai_label_path: str | None
    video_duration_sec: int | None
    video_fps: float | None
    video_resolution: str | None
    imu_sample_rate_hz: int | None
    imu_row_count: int | None
    # 这份 CSV 的实际采样率（导入时量的）。混着两种数据时要按它处理
    sample_hz: float | None = None
    total_size_bytes: int | None
    import_status: ImportStatus
    import_error: str | None
    remark: str | None
    is_sensitive: bool = False
    sensitive_note: str | None = None
    created_at: datetime


class SampleUpdate(BaseModel):
    """手动关联/改关联到哪只狗；标记/解除"含敏感隐私信息"。"""

    dog_id: int | None = None
    is_sensitive: bool | None = None
    sensitive_note: str | None = None


class SampleSensitiveBulk(BaseModel):
    """一批样本一起标记/解除敏感。"""

    sample_ids: list[int]
    is_sensitive: bool
    sensitive_note: str | None = None


class SampleDeleteBulk(BaseModel):
    """一批样本连同上面的任务一起删。"""

    sample_ids: list[int]


class SampleMediaOut(BaseModel):
    video1_id: int | None
    video2_id: int | None
    video3_id: int | None
    csv_id: int | None
    video_fps: float | None
    # 播不了的时候要能说清是哪一步缺：样本上压根没登记这一路视频（采集/归档就没有
    # 这个文件），还是登记了但媒体库里找不到（文件没传上 NAS，或者传了没被扫到）。
    # 只给一句「没有找到可播放的视频」的话，没人知道该去哪儿查
    video_paths: list[str | None] = []
    video_missing_in_library: list[str] = []


class ScanStartResult(BaseModel):
    already_running: bool


class ScanProgressOut(BaseModel):
    status: str
    total_groups: int
    processed: int
    created: int
    skipped_existing: int
    verified: int
    errors: int
    detail: list[str]
    error_message: str | None
    elapsed_sec: float
    estimated_remaining_sec: float | None
