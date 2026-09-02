from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models.sample import ImportStatus


class SampleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sample_code: str
    dog_id: str | None
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
    total_size_bytes: int | None
    import_status: ImportStatus
    import_error: str | None
    remark: str | None
    created_at: datetime


class SampleMediaOut(BaseModel):
    video1_id: int | None
    video2_id: int | None
    video3_id: int | None
    csv_id: int | None


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
