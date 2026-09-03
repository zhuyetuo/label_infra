"""
IMU CSV 读取 + 窗口化 + LTTB 降采样。列名约定（跟公司现有IMU采集/标注流程一致）：
    timestamp, acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z

真实采集出来的 CSV 不一定这么干净，这里做了几层兜底：
- 列名可能带空格/BOM/大小写不一致，统一规整后再找
- timestamp 可能是日期字符串，也可能是秒/毫秒/微秒/纳秒的 epoch 数字，
  按量级判断单位（写死成毫秒的话纳秒时间戳会直接溢出报错）
- 通道列里可能混进 MISSING、空串这类非数字，转成 NaN 当作缺采样，
  而不是让 astype(float) 抛异常
- NaN 传到 JSON 里是非法的，序列化前统一换成 null，前端画成断点

外面只认 ImuReadError，所以这里必须保证不漏出别的异常类型，
否则接口会变成一个没有任何信息的 500（之前线上就是报 ValueError）。

当前实现每次请求都重新读CSV（MVP版本，够用；量大后按架构文档规划升级成
Parquet缓存+预计算概览金字塔，见 imu_ingest_worker 的TODO）。
"""

import math
import re

import numpy as np
import pandas as pd

from app.utils.lttb import lttb_select_indices

_CHANNELS = ["acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z"]

# epoch 数字按量级猜单位：秒(1e9)、毫秒(1e12)、微秒(1e15)、纳秒(1e18)
_EPOCH_UNIT_THRESHOLDS = [(1e17, "ns"), (1e14, "us"), (1e11, "ms"), (0, "s")]

# 时间戳解析失败的行超过这个比例就认为整列格式不对，直接报错而不是硬撑
_MAX_BAD_TIMESTAMP_RATIO = 0.5


class ImuReadError(Exception):
    pass


def _norm(name: object) -> str:
    """列名规整：去BOM/空白、转小写、把分隔符统一成下划线。"""
    s = str(name).replace("\ufeff", "").strip().lower()
    for ch in (" ", "-", ".", "/"):
        s = s.replace(ch, "_")
    while "__" in s:
        s = s.replace("__", "_")
    return s.strip("_")


# 时间戳列可能叫什么。采集端各版本命名不统一，中英文都见过，所以按候选名匹配。
_TIMESTAMP_CANDIDATES = [
    "timestamp", "time_stamp", "ts", "time", "datetime", "date_time",
    "timestamp_ms", "time_ms", "timestamp_us", "timestamp_ns", "epoch", "epoch_ms",
    "时间戳", "时间", "采集时间",
]

# 六个通道各自可接受的写法：acc_x / accx / ax / accel_x / acceleration_x / a_x ...
_CHANNEL_PATTERNS = {
    "acc_x": r"^(acc|accel|acceleration|a)_?x$",
    "acc_y": r"^(acc|accel|acceleration|a)_?y$",
    "acc_z": r"^(acc|accel|acceleration|a)_?z$",
    "gyro_x": r"^(gyro|gyr|gyroscope|g)_?x$",
    "gyro_y": r"^(gyro|gyr|gyroscope|g)_?y$",
    "gyro_z": r"^(gyro|gyr|gyroscope|g)_?z$",
}


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    把实际列名映射到约定列名。真实数据里列名不统一（中文时间戳、accx、ax、
    带单位后缀等等），所以先规整再按候选名/正则匹配，匹配不上的原样保留，
    由调用方报错时把实际列名一并带出来，方便对着排查。
    """
    df = df.rename(columns={c: _norm(c) for c in df.columns})
    cols = list(df.columns)
    mapping: dict[str, str] = {}

    for cand in _TIMESTAMP_CANDIDATES:
        if cand in cols:
            mapping[cand] = "timestamp"
            break
    else:
        # 没有完全同名的，退一步找包含 time/时间 的列
        for c in cols:
            if "time" in c or "时间" in c:
                mapping[c] = "timestamp"
                break

    for target, pattern in _CHANNEL_PATTERNS.items():
        if target in cols:
            continue
        for c in cols:
            if c in mapping:
                continue
            if re.match(pattern, c):
                mapping[c] = target
                break

    return df.rename(columns=mapping)


def _parse_timestamp(ts_raw: pd.Series) -> pd.Series:
    """把 timestamp 列解析成 datetime，数字按量级判断 epoch 单位。"""
    numeric = pd.to_numeric(ts_raw, errors="coerce")
    # 绝大多数都能当数字解析时，才按 epoch 处理；否则当日期字符串
    if numeric.notna().mean() > 0.9:
        finite = numeric[numeric.notna() & (numeric > 0)]
        if finite.empty:
            raise ImuReadError("timestamp 列没有有效数值")
        magnitude = float(finite.abs().median())
        unit = next(u for threshold, u in _EPOCH_UNIT_THRESHOLDS if magnitude >= threshold)
        try:
            return pd.to_datetime(numeric, unit=unit, errors="coerce")
        except (ValueError, OverflowError, pd.errors.OutOfBoundsDatetime) as exc:
            raise ImuReadError(f"timestamp 按 {unit} 解析失败（数量级 {magnitude:.3g}）: {exc}") from exc
    return pd.to_datetime(ts_raw, errors="coerce", format="mixed")


def _load_dataframe(csv_path: str) -> pd.DataFrame:
    try:
        df = pd.read_csv(csv_path)
    except Exception as exc:  # noqa: BLE001
        raise ImuReadError(f"读取CSV失败: {exc}") from exc

    if df.empty:
        raise ImuReadError("CSV 没有数据行")

    df = _normalize_columns(df)

    if "timestamp" not in df.columns:
        raise ImuReadError(f"CSV缺少 timestamp 列，实际列名: {list(df.columns)[:12]}")
    missing = [c for c in _CHANNELS if c not in df.columns]
    if missing:
        raise ImuReadError(f"CSV缺少通道列 {missing}，实际列名: {list(df.columns)[:12]}")

    ts = _parse_timestamp(df["timestamp"])
    bad_ratio = float(ts.isna().mean())
    if bad_ratio > _MAX_BAD_TIMESTAMP_RATIO:
        sample_bad = df.loc[ts.isna(), "timestamp"].head(3).tolist()
        raise ImuReadError(f"timestamp 列有 {bad_ratio:.0%} 无法解析，例如: {sample_bad}")

    df = df.assign(_ts=ts)
    # 解析不出时间的行没法定位到时间轴上，直接丢掉（上面已保证只是少数）
    df = df[df["_ts"].notna()]
    if df.empty:
        raise ImuReadError("timestamp 列全部无法解析")

    # 采集端偶尔会乱序，排一下再算相对时间，否则 duration 会算成负数
    df = df.sort_values("_ts", kind="stable").reset_index(drop=True)
    df["_t_ms"] = ((df["_ts"] - df["_ts"].iloc[0]).dt.total_seconds() * 1000).round().astype(np.int64)

    # MISSING、空串之类的非数字当成缺采样（NaN），不要让整次请求失败
    for c in _CHANNELS:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    return df


def _safe(fn, *args, **kwargs):
    """把非预期异常统一转成 ImuReadError，避免接口漏出裸 500。"""
    try:
        return fn(*args, **kwargs)
    except ImuReadError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ImuReadError(f"解析IMU数据失败: {type(exc).__name__}: {exc}") from exc


def _get_meta(csv_path: str) -> dict:
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


def _to_json_floats(values: np.ndarray) -> list[float | None]:
    """NaN/inf 不是合法 JSON，换成 null；前端 uPlot 会把 null 画成断点。"""
    return [None if v is None or not math.isfinite(v) else round(float(v), 4) for v in values.tolist()]


def _get_series(csv_path: str, start_ms: int, end_ms: int, max_points: int) -> dict:
    df = _load_dataframe(csv_path)
    window = df[(df["_t_ms"] >= start_ms) & (df["_t_ms"] <= end_ms)]

    if len(window) == 0:
        return {"t": [], **{c: [] for c in _CHANNELS}}

    t = window["_t_ms"].to_numpy()

    if len(window) > max_points:
        # 六轴共享同一组下标：在 acc_x 上跑LTTB选点，其余通道按同样下标采样，
        # 保证多 series 共享 x 轴、时间精度一致。acc_x 可能有 NaN，
        # 补成前后值再选点，否则算出来的三角形面积会是 NaN、选不出点。
        ref = window["acc_x"].astype(float).ffill().bfill().fillna(0.0).to_numpy(dtype=np.float64)
        idx = lttb_select_indices(t.astype(np.float64), ref, max_points)
        window = window.iloc[idx]
        t = window["_t_ms"].to_numpy()

    result: dict = {"t": t.tolist()}
    for c in _CHANNELS:
        result[c] = _to_json_floats(window[c].to_numpy(dtype=np.float64))
    return result


def get_meta(csv_path: str) -> dict:
    return _safe(_get_meta, csv_path)


def get_series(csv_path: str, start_ms: int, end_ms: int, max_points: int) -> dict:
    return _safe(_get_series, csv_path, start_ms, end_ms, max_points)
