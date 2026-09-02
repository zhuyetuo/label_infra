from pydantic import BaseModel


class ImuMeta(BaseModel):
    duration_ms: int
    row_count: int
    sample_rate_hz: float | None
    channels: list[str]
    start_timestamp: str | None


class ImuSeries(BaseModel):
    t: list[int]
    acc_x: list[float]
    acc_y: list[float]
    acc_z: list[float]
    gyro_x: list[float]
    gyro_y: list[float]
    gyro_z: list[float]
