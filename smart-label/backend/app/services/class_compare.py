"""两类片段的原始 IMU 数据逐个维度对比（网页上的「类别对比」）。

为什么要有：模型老把 A 判成 B（比如静止 ↔ 未佩戴）时，先要回答"两类原始数据到底差在哪"——
是真的几乎一样（那模型怎么训都分不开，得换输入 / 加特征 / 加规则），还是有某个量明显不同
（那就把它喂给模型或者做成规则）。

做法：从两类已标注片段里各抽一批（按样本分组，每个 CSV 只读一次），切成固定长度的窗口，
每个窗口算一组特征；每个特征给 AUC（0.5 = 分不开，越靠近 0 / 1 越好分）、两类的分位数、
叠在一起的直方图、以及「一刀切」阈值和准确率。跟 imu_train/src/eval/compare_two_classes.py
同一套特征，那份给离线跑大数据用，这份给网页上随手看。

不依赖 scipy：带通能量用 FFT 在频域里直接取频段。
"""

from __future__ import annotations

import random
from collections import defaultdict

import numpy as np
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.sample import Sample
from app.models.task import Task
from app.services import imu_service
from app.services.data_pool import _label_ids_under, in_pool_cond
from app.services.media_resolver import resolve_nas_path

ACC = ["acc_x", "acc_y", "acc_z"]
GYR = ["gyro_x", "gyro_y", "gyro_z"]

#: 这几个主要随设备标定 / 放置角度变，跨设备比出来的差多半是「换了个项圈」而不是「戴没戴」
DEVICE_SENSITIVE = {"mag_mean", "grav_axis", "pitch", "roll"}
#: 片段比窗口短也用（整段算一个窗口），但至少这么长
MIN_SEG_MS = 1000

# (key, 名字, 说明)：前端按这个顺序 / 文字显示
FEATURES: list[tuple[str, str, str]] = [
    ("acc_std", "加速度三轴标准差（均值）", "整体晃动大小"),
    ("mag_std", "加速度模长标准差", "不管朝向的晃动大小"),
    ("mag_ptp", "加速度模长极差", "窗口里最大的一下起伏"),
    ("mag_mean", "加速度模长均值", "≈ 重力，看量程 / 标定差异"),
    ("jerk_med", "加加速度中位数", "变化快不快（细碎抖动）"),
    ("breath", "呼吸频段能量 0.15–0.6Hz", "戴着睡觉时的呼吸起伏，放桌上应该几乎没有"),
    ("heart", "心跳频段能量 0.8–3Hz", "颈动脉 / 心跳带来的微振动"),
    ("hf", "高频能量 3Hz 以上", "传感器本底噪声 / 快速抖动"),
    ("gyro_mean", "陀螺模长均值", "转动大小；放桌上只剩本底"),
    ("gyro_std", "陀螺模长标准差", "转动的起伏"),
    ("gyro_breath", "陀螺呼吸频段能量", "呼吸带来的细微转动"),
    ("gyro_zero", "陀螺读数为 0 的比例", "放桌上转动小于传感器死区就直接读 0；戴着有呼吸，多少有点转动"),
    ("grav_axis", "重力最大轴占比", "接近 1 = 平放（重力几乎全在一个轴上）"),
    ("pitch", "俯仰角（度）", "佩戴 / 放置的姿态"),
    ("roll", "横滚角（度）", "佩戴 / 放置的姿态"),
]


def _band_energy(x: np.ndarray, hz: float, lo: float, hi: float | None) -> float:
    """去均值后在 [lo, hi) Hz 频段的平均功率（≈ 带通后的方差）"""
    n = len(x)
    if n < 8:
        return 0.0
    spec = np.abs(np.fft.rfft(x - x.mean())) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / hz)
    m = (freqs >= lo) & (freqs < (hi if hi is not None else hz))
    # Parseval：单边谱 2|X|²/N² 对应方差
    return float(2.0 * spec[m].sum() / (n * n))


def window_features(acc: np.ndarray, gyr: np.ndarray | None, hz: float) -> dict[str, float]:
    mag = np.linalg.norm(acc, axis=1)
    g = acc.mean(axis=0)
    gn = float(np.linalg.norm(g)) or 1.0
    f = {
        "acc_std": float(acc.std(axis=0).mean()),
        "mag_std": float(mag.std()),
        "mag_ptp": float(np.ptp(mag)),
        "mag_mean": float(mag.mean()),
        "jerk_med": float(np.median(np.abs(np.diff(mag))) * hz) if len(mag) > 1 else 0.0,
        "breath": _band_energy(mag, hz, 0.15, 0.6),
        "heart": _band_energy(mag, hz, 0.8, 3.0),
        "hf": _band_energy(mag, hz, 3.0, None),
        "grav_axis": float(np.abs(g).max() / gn),
        "pitch": float(np.degrees(np.arctan2(g[0], np.hypot(g[1], g[2])))),
        "roll": float(np.degrees(np.arctan2(g[1], g[2]))),
    }
    if gyr is not None and np.isfinite(gyr).all():
        gm = np.linalg.norm(gyr, axis=1)
        f.update({"gyro_mean": float(gm.mean()), "gyro_std": float(gm.std()),
                  "gyro_breath": _band_energy(gm, hz, 0.15, 0.6),
                  "gyro_zero": float((np.abs(gyr).max(axis=1) == 0).mean())})
    return f


def _auc(a: np.ndarray, b: np.ndarray) -> float:
    """P(A 的值 > B 的值)"""
    allv = np.concatenate([a, b])
    order = allv.argsort(kind="mergesort")
    ranks = np.empty(len(allv))
    ranks[order] = np.arange(1, len(allv) + 1)
    # 并列取平均名次
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=ranks)
    ranks = (sums / cnt)[inv]
    ra = ranks[: len(a)].sum()
    return float((ra - len(a) * (len(a) + 1) / 2) / (len(a) * len(b)))


def _best_cut(a: np.ndarray, b: np.ndarray) -> tuple[float, float, str]:
    """一个阈值切开两类：返回 (阈值, 两类平均召回, 'A 在上' / 'A 在下')"""
    cands = np.quantile(np.concatenate([a, b]), np.linspace(0.01, 0.99, 197))
    best = (float("nan"), 0.0, "")
    for t in cands:
        up = ((a > t).mean() + (b <= t).mean()) / 2
        down = ((a <= t).mean() + (b > t).mean()) / 2
        if up > best[1]:
            best = (float(t), float(up), "A 在上")
        if down > best[1]:
            best = (float(t), float(down), "A 在下")
    return best


async def _pick_segments(db: AsyncSession, names: list[str], project_ids: list[int] | None,
                         pool_only: bool, max_segments: int, min_ms: int) -> list[tuple]:
    ids = await _label_ids_under(db, names)
    if not ids:
        return []
    it = AnnotationLabelItem
    q = (select(it.id, it.start_time_ms, it.end_time_ms, Sample.id, Sample.imu_csv_path)
         .join(AnnotationRecord, AnnotationRecord.id == it.annotation_record_id)
         .join(Task, and_(Task.id == AnnotationRecord.task_id, AnnotationRecord.round_no == Task.round_no))
         .join(Sample, Sample.id == Task.sample_id)
         .where(it.label_id.in_(ids), it.uncertain.is_(False), Sample.imu_csv_path.is_not(None),
                it.end_time_ms - it.start_time_ms >= min_ms))
    if project_ids:
        q = q.where(Task.project_id.in_(project_ids))
    if pool_only:
        q = q.where(in_pool_cond())
    rows = (await db.execute(q)).all()
    rnd = random.Random(0)          # 固定种子：同样的条件每次抽到同一批，结果可复现
    if len(rows) > max_segments:
        rows = rnd.sample(rows, max_segments)
    return rows


def _features_for(rows: list[tuple], win_ms: int, max_windows: int) -> tuple[list[dict], int, list[str]]:
    """按 CSV 分组，每个文件只读一次，片段切成不重叠的窗口算特征。返回 (窗口特征, 用上的片段数, 读不了的文件)"""
    by_csv: dict[str, list[tuple]] = defaultdict(list)
    for r in rows:
        by_csv[r[4]].append(r)
    out: list[dict] = []
    used = 0
    bad: list[str] = []
    for rel, segs in by_csv.items():
        try:
            df = imu_service._load_dataframe(resolve_nas_path(rel))
        except Exception:  # noqa: BLE001 —— 一个文件坏了不耽误别的
            bad.append(rel)
            continue
        t = df["_t_ms"].to_numpy()
        if len(t) < 4:
            continue
        dt = np.median(np.diff(t[: min(len(t), 5000)]))
        hz = 1000.0 / dt if dt > 0 else 25.0
        acc_all = df[ACC].to_numpy(np.float64)
        gyr_all = df[GYR].to_numpy(np.float64) if all(c in df.columns for c in GYR) else None
        for _iid, s_ms, e_ms, sid, _rel in segs:
            lo, hi = np.searchsorted(t, s_ms), np.searchsorted(t, e_ms)
            n = int(win_ms / 1000 * hz)
            # 比窗口短的片段（甩头 / 抖身这种两三秒的）整段算一个窗口；比 1 秒还短的不要
            if hi - lo < n:
                if hi - lo < max(8, int(MIN_SEG_MS / 1000 * hz)):
                    continue
                starts, n = [lo], hi - lo
            else:
                starts = list(range(lo, hi - n + 1, n))
            used += 1
            for k in starts:
                acc = acc_all[k:k + n]
                if not np.isfinite(acc).all():
                    continue
                gyr = gyr_all[k:k + n] if gyr_all is not None else None
                f = window_features(acc, gyr, hz)
                f["_sample"] = sid
                out.append(f)
                if len(out) >= max_windows:
                    return out, used, bad
    return out, used, bad


async def compare(db: AsyncSession, names_a: list[str], names_b: list[str], project_ids: list[int] | None = None,
                  pool_only: bool = False, win_s: float = 10.0, max_segments: int = 80,
                  max_windows: int = 3000, bins: int = 30) -> dict:
    import asyncio

    win_ms = int(win_s * 1000)
    seg_a = await _pick_segments(db, names_a, project_ids, pool_only, max_segments, MIN_SEG_MS)
    seg_b = await _pick_segments(db, names_b, project_ids, pool_only, max_segments, MIN_SEG_MS)
    (fa, used_a, bad_a), (fb, used_b, bad_b) = await asyncio.gather(
        asyncio.to_thread(_features_for, seg_a, win_ms, max_windows),
        asyncio.to_thread(_features_for, seg_b, win_ms, max_windows),
    )
    res = {
        "a": {"names": names_a, "segments": used_a, "windows": len(fa), "samples": len({f["_sample"] for f in fa})},
        "b": {"names": names_b, "segments": used_b, "windows": len(fb), "samples": len({f["_sample"] for f in fb})},
        "win_s": win_s, "unreadable": (bad_a + bad_b)[:10], "features": [], "warnings": [],
    }
    # 样本（= 设备 / 录制）太少时，比出来的差多半是设备之间的差：项圈标定、噪声底都不一样
    for side, d in (("A", res["a"]), ("B", res["b"])):
        if 0 < d["samples"] < 5:
            res["warnings"].append(f"{side} 只来自 {d['samples']} 个样本：比出来的差可能是设备 / 那只狗的差异，"
                                   "不一定是类别的差异。多攒些不同设备、不同狗的片段再比")
    sa, sb = {f["_sample"] for f in fa}, {f["_sample"] for f in fb}
    if sa and sb and not (sa & sb):
        res["warnings"].append("两类没有来自同一个样本的片段：最好有同一个项圈两种状态都录到的数据（比如同一段录制里先戴着睡、再摘下放桌上），"
                               "那样比的才只是类别差异")
    if len(fa) < 5 or len(fb) < 5:
        res["error"] = "窗口太少，没法比（片段都比窗口短？换短一点的窗口，或者放宽项目 / 来源）"
        return res
    for key, name, hint in FEATURES:
        a = np.array([f[key] for f in fa if key in f], dtype=np.float64)
        b = np.array([f[key] for f in fb if key in f], dtype=np.float64)
        if len(a) < 5 or len(b) < 5:
            continue
        auc = _auc(a, b)
        cut, acc, side = _best_cut(a, b)
        lo, hi = np.quantile(np.concatenate([a, b]), [0.01, 0.99])
        if hi <= lo:
            hi = lo + 1e-9
        edges = np.linspace(lo, hi, bins + 1)
        ha, _ = np.histogram(np.clip(a, lo, hi), edges)
        hb, _ = np.histogram(np.clip(b, lo, hi), edges)
        q = [0.05, 0.25, 0.5, 0.75, 0.95]
        res["features"].append({
            "key": key, "name": name, "hint": hint, "device_sensitive": key in DEVICE_SENSITIVE,
            "auc": round(auc, 4), "sep": round(abs(auc - 0.5) * 2, 4),
            "cut": cut, "cut_acc": round(acc, 4), "cut_side": side,
            "qa": [float(x) for x in np.quantile(a, q)], "qb": [float(x) for x in np.quantile(b, q)],
            "edges": [float(x) for x in edges],
            "ha": [round(float(x) / len(a), 5) for x in ha], "hb": [round(float(x) / len(b), 5) for x in hb],
        })
    # 跨设备不可靠的排到后面：可分性再高也多半是设备差
    res["features"].sort(key=lambda x: (x["device_sensitive"], -x["sep"]))
    return res


async def preview(db: AsyncSession, names: list[str], project_ids: list[int] | None, pool_only: bool,
                  win_s: float) -> dict:
    """对比前看一眼有多少数据：片段数、样本数、总时长、够一个窗口的 / 短的各几段、大概能切出多少窗口"""
    if not names:
        return {"segments": 0, "samples": 0, "total_s": 0.0, "long": 0, "short": 0, "too_short": 0, "windows": 0}
    ids = await _label_ids_under(db, names)
    if not ids:
        return {"segments": 0, "samples": 0, "total_s": 0.0, "long": 0, "short": 0, "too_short": 0, "windows": 0}
    it = AnnotationLabelItem
    q = (select(it.start_time_ms, it.end_time_ms, Sample.id)
         .join(AnnotationRecord, AnnotationRecord.id == it.annotation_record_id)
         .join(Task, and_(Task.id == AnnotationRecord.task_id, AnnotationRecord.round_no == Task.round_no))
         .join(Sample, Sample.id == Task.sample_id)
         .where(it.label_id.in_(ids), it.uncertain.is_(False)))
    if project_ids:
        q = q.where(Task.project_id.in_(project_ids))
    if pool_only:
        q = q.where(in_pool_cond())
    rows = (await db.execute(q)).all()
    win_ms = int(win_s * 1000)
    durs = [max(0, e - s) for s, e, _ in rows]
    long_ = sum(1 for d in durs if d >= win_ms)
    short = sum(1 for d in durs if MIN_SEG_MS <= d < win_ms)
    return {
        "segments": len(rows), "samples": len({r[2] for r in rows}), "total_s": round(sum(durs) / 1000, 1),
        "long": long_, "short": short, "too_short": len(rows) - long_ - short,
        "windows": sum(d // win_ms for d in durs if d >= win_ms) + short,
    }
