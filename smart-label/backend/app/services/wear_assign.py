"""一只狗两个项圈轮换（每 24 小时换一次，换下来的那个放充电座上，**也在记录**）：
每一分钟到底是哪个项圈戴在狗身上。

为什么不直接用「未佩戴」识别：单看一个设备，未佩戴跟睡觉 / 静止的原始数据很像，
模型分不太开（充电的那个经常被判成「静止」，两个项圈一天都显示戴了 23 小时多，
抓挠也会被重复算或者算到充电座上那个去）。但同一时刻两个设备**放在一起比**就容易得多：
戴着的那个总有呼吸 / 翻身带来的动静，充电座上那个几乎完全不动——所以每分钟取
「未佩戴」概率更低的那个当戴着的，用相对比较代替绝对判断。

规则（都按分钟）：
  · 两个都有数据：选「未佩戴」概率（前后几分钟平滑过）更低的那个；已经在戴的那个
    要被另一个低出 margin 以上才换（滞回，免得来回跳）
  · 两个都很像没戴（低的那个也 ≥ both_max）：都没戴（比如两个同时在充电座上）
  · 只有一个有数据：它的未佩戴概率 < solo_max 就算戴着，否则算都没戴
  · 都没数据：都没戴
  · 最后把短于 min_run 分钟的碎段并进前后（一天就换一次，碎段多半是判抖了）

只用模型已经给出的逐窗口概率（AI 结果 JSON 里的 windows[].probs），不用再读原始 CSV。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

NOTWORN = "未佩戴"


def _minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


def minute_notworn(windows: list[tuple[datetime, dict]]) -> dict[datetime, float]:
    """逐窗口 (时间, probs) → 每分钟「未佩戴」概率的平均。probs 里没有这一类就返回空"""
    acc: dict[datetime, list[float]] = defaultdict(list)
    for t, probs in windows:
        if not probs or NOTWORN not in probs:
            continue
        acc[_minute(t)].append(float(probs[NOTWORN]))
    return {m: sum(v) / len(v) for m, v in acc.items()}


def assign_worn(per_dev: dict[str, dict[datetime, float]], smooth: int = 5, margin: float = 0.15,
                solo_max: float = 0.6, both_max: float = 0.7, min_run: int = 10) -> dict[str, list[tuple[datetime, datetime]]]:
    """per_dev：{IMU: {分钟: 未佩戴概率}}。返回 {IMU: [(起, 止), ...]} 戴着的时段（按分钟、左闭右开）。"""
    devs = sorted(per_dev)
    minutes = sorted({m for d in devs for m in per_dev[d]})
    if not minutes:
        return {d: [] for d in devs}
    step = timedelta(minutes=1)
    # 时间轴补齐成连续的分钟（中间没数据的分钟也要占位，才好算「都没戴」和前后平滑）
    axis: list[datetime] = []
    t = minutes[0]
    while t <= minutes[-1]:
        axis.append(t)
        t += step

    def sm(d: str, i: int) -> float | None:
        vals = [per_dev[d][axis[j]] for j in range(max(0, i - smooth), min(len(axis), i + smooth + 1))
                if axis[j] in per_dev[d]]
        return sum(vals) / len(vals) if vals else None

    choice: list[str | None] = []
    cur: str | None = None
    for i, m in enumerate(axis):
        present = [d for d in devs if m in per_dev[d]]
        if not present:
            cur = None
        elif len(present) == 1:
            d = present[0]
            p = sm(d, i)
            cur = d if p is not None and p < solo_max else None
        else:
            ps = {d: sm(d, i) for d in present}
            best = min(present, key=lambda d: ps[d] if ps[d] is not None else 1.0)
            if ps[best] is None or ps[best] >= both_max:
                cur = None                # 两个都像放在桌上（换下来那会儿都在充电座上）：都没戴
            elif cur in present and ps[cur] is not None and ps[best] is not None and ps[cur] - ps[best] < margin:
                pass                      # 差得不够多，不换
            else:
                cur = best
        choice.append(cur)

    # 短碎段并进前后：按段扫，短于 min_run 的段改成前一段（没有前一段就后一段）
    runs: list[list] = []
    for i, c in enumerate(choice):
        if runs and runs[-1][0] == c:
            runs[-1][2] = i
        else:
            runs.append([c, i, i])
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for k, (c, a, b) in enumerate(runs):
            if b - a + 1 < min_run:
                tgt = runs[k - 1][0] if k > 0 else runs[k + 1][0]
                if tgt != c:
                    runs[k][0] = tgt
                    changed = True
        merged: list[list] = []
        for r in runs:
            if merged and merged[-1][0] == r[0]:
                merged[-1][2] = r[2]
            else:
                merged.append(list(r))
        runs = merged

    out: dict[str, list[tuple[datetime, datetime]]] = {d: [] for d in devs}
    for c, a, b in runs:
        if c is not None:
            out[c].append((axis[a], axis[b] + step))
    return out


def clip(spans: list[tuple[datetime, datetime]], keep: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    """spans 跟 keep 求交：只留下落在戴着时段里的那部分"""
    out = []
    for a, b in spans:
        for x, y in keep:
            lo, hi = max(a, x), min(b, y)
            if hi > lo:
                out.append((lo, hi))
    return out


def seconds(spans: list[tuple[datetime, datetime]]) -> float:
    merged: list[list[datetime]] = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return sum((b - a).total_seconds() for a, b in merged)
