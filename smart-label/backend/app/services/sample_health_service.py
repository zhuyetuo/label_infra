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
import re

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
        return {"verdict": "no_csv", "reason": "这条样本没有 IMU CSV",
                "legacy_imu_numbering": False, "coverage": None, "rows": None, "hz": None}

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
    legacy = is_legacy_yingpeng(csv_rel_path)
    if legacy:
        # 不覆盖原来的结论：数据本身可能完全正常，问题在"这个 imu 号是谁的"。
        # 所以单独一个字段，让人一眼看到，而不是混进 verdict 里
        reason = (reason + "；" if reason else "") + \
            "这批是影棚 9-12 之前的数据，文件名里的 imu 号是位置号不是设备编号，" \
            "按狗档案判出来的狗有一半是错的——要用先按当天的 record_multicam 日志翻译"
    return {
        "verdict": verdict,
        "reason": reason,
        "legacy_imu_numbering": legacy,
        "coverage": round(coverage, 3) if coverage is not None else None,
        "rows": rows,
        "hz": round(hz, 1) if hz else None,
    }


#: 值得让人看一眼的结论。ok 不用列，partial 要列——它是"能用但要知道"。
NEEDS_ATTENTION = ("no_csv", "empty", "bad", "hz_mismatch", "partial", "unknown")


# ── 影棚老数据：imu 号的含义变过 ────────────────────────────────────────
#
# 2026-09-12 之前，影棚的采集端没设 IMU_IDS，文件名里的 imu1..imu4 是按 IMUS 的
# **位置**排的，不是设备真实编号。现场实测过：位置 2 上装的是 WT5。
#
#     文件里的 imu2      9-11 及以前 = WT5（lulu 的）   9-12 起 = WT2（bibi 的）
#     平台按狗档案判给    bibi  ✗                        bibi  ✓
#
# 也就是说同一张档案登记表，对老数据有一半会给出**错的狗**——而且不报错、
# 界面上看不出来。bibi 和 bali 的历史统计里各混了另一只狗的数据，lulu 和 xima
# 的历史数据整个记在了别人名下。
#
# 采集端从 2026-09-13 起把日期目录后缀改成了 _yingpeng2，就是为了让这件事变成
# 路径上看得见的事实。这里据此把老目录标出来：不删、不改，只是让人知道
# 「这批的狗归属不能直接信」。
LEGACY_YINGPENG_SUFFIX = "_yingpeng"
NEW_YINGPENG_SUFFIX = "_yingpeng2"

# 采集端换成设备真实编号的那一天。这天**之后**录的都是对的。
#
# 为什么光看后缀不够：后缀（_yingpeng2）是 2026-09-13 才加的，而编号是 09-12
# 改的——中间 9-12 到 9-13 这一天多的数据，编号已经是对的，目录却还叫
# _yingpeng。只按后缀判会把这批好数据误标成"归属不可信"，那比不标还糟：
# 真正有问题的那批会淹没在误报里，久了就没人看了。
#
# 所以两个条件都要：老后缀 **且** 日期早于这一天。
_NUMBERING_FIXED_ON = (2026, 9, 12)

_DAY_RE = re.compile(r"^(\d{4})_(\d{1,2})_(\d{1,2})(?:_|$)")


def _dir_date(part: str) -> tuple[int, int, int] | None:
    """从 `2026_9_13_yingpeng` 这种目录名里取日期。取不出就返回 None。"""
    m = _DAY_RE.match(part)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def is_legacy_yingpeng(rel_path: str | None) -> bool:
    """这条样本是不是影棚**编号改之前**那批（imu 号是位置号，狗归属有一半是错的）。

    判据：目录后缀是老的 `_yingpeng`（不是 `_yingpeng2`）**并且**日期早于
    2026-09-12。两个条件缺一不可——只看后缀会误伤 9-12/9-13 那批（编号已经对了、
    目录还是老名字），只看日期又要求每个场地都维护一张"哪天改的"表。

    日期取不出来（目录名不是 `YYYY_M_D_...` 的形状）时判**不是**老数据：
    宁可漏标也不误标，误标会让真正有问题的那批淹没在误报里。
    """
    if not rel_path:
        return False
    for part in rel_path.replace("\\", "/").split("/"):
        if not part:
            continue
        low = part.lower()
        if not low.endswith(LEGACY_YINGPENG_SUFFIX) or low.endswith(NEW_YINGPENG_SUFFIX):
            continue
        d = _dir_date(part)
        if d is not None and d < _NUMBERING_FIXED_ON:
            return True
    return False
