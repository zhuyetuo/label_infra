"""
样本体检：这条样本的 IMU 数据到底能不能用。

起因是一段真实素材：`multicam_20260816_160001055_cam1_imu1_raw.mp4`。文件名看着
是配对好的（cam1 配 imu1），画面也正常，但视频里烧着的 overlay 从头到尾写着
`[Bibi] MISSING` —— 它配对的那路 IMU 整段就没连上。这种样本在库里跟正常样本
长得一模一样：有视频、有 CSV、能预览、能建任务。人翻不出来，只有等标注员标到
一半发现波形是平的，或者更糟——训练集里混进一批没有标签依据的片段。

所以要有一个能一次扫完全库的体检。判据只用"能自动算出来"的东西：

  - **覆盖率**：CSV 的行数 ÷（视频时长 × 采样率）。IMU 中途掉线、整段没连上，
    这个数就低。这是最有用的一条，因为它把"有文件"和"有数据"区分开了。
  - **采样率**：量出来的 Hz 跟登记的差太多，说明文件不是它声称的那种。
  - **空文件**：只有表头。

刻意不做的：不改扫描流程、不写库、不自动删。只读一遍给人看——这类判断错一次的
代价（误删一天的数据）比漏一次高得多，而且原因往往要人看了现场才知道。
"""

import os

from app.utils.ffprobe import count_csv_rows, measure_csv_hz

# 覆盖率低于这个数就算"IMU 基本没数据"。
# 为什么是 0.5：正常样本量出来在 0.95 以上；掉线一半的样本（比如这次这段
# 12fps 的影棚数据）在 0.5 以下。中间地带留给人看，不硬划线。
BAD_COVERAGE = 0.5
# 0.5-0.9 之间是"缺了一块但还有得用"，单独标出来
WARN_COVERAGE = 0.9

# 量出来的 Hz 跟登记的差这么多倍就算对不上
HZ_MISMATCH_RATIO = 1.5


def _verdict(coverage: float | None, rows: int | None, hz: float | None, declared_hz: float | None) -> tuple[str, str]:
    """给一个结论 + 一句人话。结论只有三档，别再细分——细分了没人看得懂。"""
    if rows is None:
        return "no_csv", "CSV 读不到（文件没了，或者 NAS 没挂上）"
    if rows <= 0:
        return "empty", "CSV 只有表头，一行数据都没有——这路 IMU 整段没连上"
    if coverage is None:
        return "unknown", "算不出覆盖率（视频时长或采样率缺一个）"
    if coverage < BAD_COVERAGE:
        return "bad", f"IMU 只覆盖了视频的 {coverage * 100:.0f}%，大半段没数据"
    if declared_hz and hz and (hz > declared_hz * HZ_MISMATCH_RATIO or hz * HZ_MISMATCH_RATIO < declared_hz):
        return "hz_mismatch", f"量出来 {hz:.0f}Hz，登记的是 {declared_hz:.0f}Hz，对不上"
    if coverage < WARN_COVERAGE:
        return "partial", f"IMU 覆盖了视频的 {coverage * 100:.0f}%，中间缺了一块"
    return "ok", ""


def check_one(nas_root: str, csv_rel_path: str | None, duration_sec: int | None,
              sample_hz: float | None, declared_hz: float | None = None) -> dict:
    """体检一条样本。纯函数式：给路径和登记值，返回结论，不碰数据库。"""
    if not csv_rel_path:
        return {"verdict": "no_csv", "reason": "这条样本没有 IMU CSV", "coverage": None, "rows": None, "hz": None}

    full = os.path.join(nas_root, csv_rel_path)
    rows = count_csv_rows(full)
    hz = sample_hz
    if hz is None and rows:
        hz = measure_csv_hz(full)

    coverage = None
    if rows and duration_sec and hz and hz > 0:
        expected = duration_sec * hz
        if expected > 0:
            # 封到 1.0：采集端偶尔多写几行，超过 100% 没有意义，
            # 而不封的话排序时这些会排到最前面，把真问题挤下去
            coverage = min(rows / expected, 1.0)

    verdict, reason = _verdict(coverage, rows, hz, declared_hz)
    return {
        "verdict": verdict,
        "reason": reason,
        "coverage": round(coverage, 3) if coverage is not None else None,
        "rows": rows,
        "hz": round(hz, 1) if hz else None,
    }


#: 值得让人看一眼的结论。ok 不用列，partial 要列——它是"能用但要知道"。
NEEDS_ATTENTION = ("no_csv", "empty", "bad", "hz_mismatch", "partial", "unknown")
