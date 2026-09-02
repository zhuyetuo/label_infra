"""
IMU CSV 读取 + 窗口化 + LTTB 降采样。假设列名约定（跟公司现有IMU采集/标注流程一致）：
    timestamp, acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z
timestamp 支持标准可解析的日期时间字符串，或纯数字（当作秒/毫秒 epoch）。

当前实现每次请求都重新读CSV（MVP版本，够用；量大后按架构文档规划升级成
Parquet缓存+预计算概览金字塔，见 imu_ingest_worker 的TODO）。
"""

import numpy as np
import pandas as pd

from app.utils.lttb import lttb_select_indices

_CHANNELS = ["acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z"]


class ImuReadError(Exception):
    pass


def _load_dataframe(csv_path: str) -> pd.DataFrame:
    try:
        df = pd.read_csv(csv_path)
    except Exception as exc:  # noqa: BLE001
        raise ImuReadError(f"读取CSV失败: {exc}") from exc

    if "timestamp" not in df.columns:
        raise ImuReadError("CSV缺少 timestamp 列")

    ts_raw = df["timestamp"]
    if pd.api.types.is_numeric_dtype(ts_raw):
        # 纯数字：按量级猜测秒还是毫秒
        base = ts_raw.iloc[0]
        unit = "ms" if base > 1e12 else "s"
        ts = pd.to_datetime(ts_raw, unit=unit)
    else:
        ts = pd.to_datetime(ts_raw, errors="coerce")
        if ts.isna().any():
            raise ImuReadError("timestamp 列存在无法解析的值")

    df = df.assign(_ts=ts)
    df["_t_ms"] = ((df["_ts"] - df["_ts"].iloc[0]).dt.total_seconds() * 1000).astype(np.int64)

    missing = [c for c in _CHANNELS if c not in df.columns]
    if missing:
        raise ImuReadError(f"CSV缺少通道列: {missing}")

    return df


def get_meta(csv_path: str) -> dict:
    df = _load_dataframe(csv_path)
    row_count = len(df)
    duration_ms = int(df["_t_ms"].iloc[-1]) if row_count else 0
    sample_rate_hz = round(row_count / (duration_ms / 1000), 2) if duration_ms > 0 else None
    start_timestamp = df["_ts"].iloc[0].isoformat() if row_count else None
    return {
        "duration_ms": duration_ms,
        "row_count": row_count,
        "sample_rate_hz": sample_rate_hz,
        "channels": _CHANNELS,
        "start_timestamp": start_timestamp,
    }


def get_series(csv_path: str, start_ms: int, end_ms: int, max_points: int) -> dict:
    df = _load_dataframe(csv_path)
    window = df[(df["_t_ms"] >= start_ms) & (df["_t_ms"] <= end_ms)]

    if len(window) == 0:
        return {"t": [], **{c: [] for c in _CHANNELS}}

    t = window["_t_ms"].to_numpy()

    if len(window) > max_points:
        # 六轴共享同一组下标：在 acc_x 上跑LTTB选点，其余通道按同样下标采样，
        # 保证多 series 共享 x 轴、时间精度一致
        idx = lttb_select_indices(t.astype(np.float64), window["acc_x"].to_numpy(dtype=np.float64), max_points)
        window = window.iloc[idx]
        t = window["_t_ms"].to_numpy()

    result = {"t": t.tolist()}
    for c in _CHANNELS:
        result[c] = window[c].astype(float).round(4).tolist()
    return result
