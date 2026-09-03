from pydantic import BaseModel


class ImuMeta(BaseModel):
    duration_ms: int
    row_count: int
    sample_rate_hz: float | None
    channels: list[str]
    start_timestamp: str | None


class ImuSeries(BaseModel):
    """缺采样的点用 null 表示（NaN 不是合法 JSON），前端画成断点。"""

    t: list[int]
    acc_x: list[float | None]
    acc_y: list[float | None]
    acc_z: list[float | None]
    gyro_x: list[float | None]
    gyro_y: list[float | None]
    gyro_z: list[float | None]
