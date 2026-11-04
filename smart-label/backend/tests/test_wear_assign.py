"""两个项圈轮换：每分钟按「未佩戴」概率相对比较定哪个戴着。"""

import random
from datetime import datetime, timedelta

from app.services.wear_assign import assign_worn, clip, minute_notworn, seconds

T0 = datetime(2026, 11, 1, 0, 0)


def _series(n, fn, seed=0):
    rnd = random.Random(seed)
    return {T0 + timedelta(minutes=i): min(1.0, max(0.0, fn(i) + rnd.uniform(-0.1, 0.1))) for i in range(n)}


def test_handover_mid_day():
    # 0~600 分钟 IMU1 戴着（未佩戴概率低，睡觉时也只到 0.4），之后换 IMU2；充电的那个 0.5~0.9 晃
    n = 1440
    a = _series(n, lambda i: 0.15 if i < 600 else 0.75, 1)
    b = _series(n, lambda i: 0.7 if i < 600 else (0.4 if 900 < i < 1000 else 0.15), 2)   # 睡觉那段也比充电座低
    out = assign_worn({"IMU1": a, "IMU2": b})
    assert len(out["IMU1"]) == 1 and len(out["IMU2"]) == 1
    (s1, e1), (s2, e2) = out["IMU1"][0], out["IMU2"][0]
    assert s1 == T0 and abs((e1 - T0).total_seconds() / 60 - 600) <= 6 and e1 == s2
    assert seconds(out["IMU1"]) + seconds(out["IMU2"]) == n * 60


def test_both_charging_gap_and_solo():
    # 中间 30 分钟两个都放桌上（都 0.8）→ 都算没戴；只有一个有数据、它又像没戴 → 也算没戴
    a = {**_series(100, lambda i: 0.1), **{T0 + timedelta(minutes=100 + i): 0.85 for i in range(30)}}
    b = {T0 + timedelta(minutes=100 + i): 0.8 for i in range(30)}
    out = assign_worn({"IMU1": a, "IMU2": b})
    worn = seconds(out["IMU1"]) + seconds(out["IMU2"])
    assert abs(worn - 100 * 60) <= 360          # 前后平滑 ±5 分钟，边界差几分钟


def test_minute_notworn_and_clip():
    w = [(T0 + timedelta(seconds=s), {"未佩戴": 0.2 if s < 60 else 0.8}) for s in range(0, 120, 2)]
    m = minute_notworn(w)
    assert m[T0] == 0.2 and m[T0 + timedelta(minutes=1)] == 0.8
    assert minute_notworn([(T0, {"活动": 1.0})]) == {}
    ev = [(T0, T0 + timedelta(minutes=10))]
    assert clip(ev, [(T0 + timedelta(minutes=5), T0 + timedelta(minutes=20))]) == [(T0 + timedelta(minutes=5), T0 + timedelta(minutes=10))]
