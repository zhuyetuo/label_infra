"""类别对比：特征能算、AUC 方向对、能区分注入了「呼吸起伏」的那一类。"""

import numpy as np

from app.services import class_compare as cc


def test_breath_feature_separates():
    rng = np.random.default_rng(0)
    hz, n = 16.0, 160
    t = np.arange(n) / hz
    fa, fb = [], []
    for _ in range(40):
        base = np.c_[np.full(n, 0.1), np.full(n, 0.2), np.full(n, 0.97)]
        a = base + rng.normal(0, 0.002, (n, 3))                       # 放桌上：只有本底噪声
        b = base + rng.normal(0, 0.002, (n, 3))
        b[:, 2] += 0.004 * np.sin(2 * np.pi * 0.3 * t)                # 戴着睡：呼吸起伏
        fa.append(cc.window_features(a, rng.normal(0, .3, (n, 3)), hz))
        fb.append(cc.window_features(b, rng.normal(0, .3, (n, 3)), hz))
    a = np.array([f["breath"] for f in fa])
    b = np.array([f["breath"] for f in fb])
    assert cc._auc(a, b) < 0.1                                        # A 明显小
    cut, acc, side = cc._best_cut(a, b)
    assert acc > 0.9 and side == "A 在下"
    # 两边一样的量分不开
    g = np.array([f["gyro_mean"] for f in fa]), np.array([f["gyro_mean"] for f in fb])
    assert 0.25 < cc._auc(*g) < 0.75


def test_compare_endpoint(db, run, monkeypatch):
    import pandas as pd

    from app.api.v1 import data_pool as pool_api
    from app.models.sample import Sample
    from sqlalchemy import select
    from tests.test_segment_review import _world

    w = _world(db, run)
    smp = run(db.execute(select(Sample))).scalar_one()
    smp.imu_csv_path = "x/imu.csv"
    run(db.commit())
    hz = 16
    t = np.arange(0, 120_000, 1000 / hz)
    rng = np.random.default_rng(1)
    df = pd.DataFrame({"_t_ms": t, "acc_x": 0.1 + rng.normal(0, .002, len(t)), "acc_y": 0.2 + rng.normal(0, .002, len(t)),
                       "acc_z": 0.97 + rng.normal(0, .002, len(t)), "gyro_x": 0.0, "gyro_y": 0.0, "gyro_z": 0.0})
    df.loc[(t >= 50_000) & (t < 60_000), "acc_x"] += 0.3 * np.sin(t[(t >= 50_000) & (t < 60_000)] / 50)   # 活动那段晃
    monkeypatch.setattr(cc.imu_service, "_load_dataframe", lambda _p: df)
    monkeypatch.setattr(cc, "resolve_nas_path", lambda p: p)
    r = run(pool_api.post_compare(pool_api.CompareIn(a=["抓挠"], b=["活动"], win_s=1.0, pool_only=False), db, w.rev))["data"]
    assert r["a"]["windows"] >= 6 and r["b"]["windows"] >= 9
    top = r["features"][0]
    assert top["sep"] > 0.9 and len(top["ha"]) == 30 and not top["device_sensitive"]
    assert r["warnings"]                         # 都只来自 1 个样本
    # 窗口比片段长：短片段整段算一个窗口（抓挠 3 秒一段，窗口 10 秒）
    r = run(pool_api.post_compare(pool_api.CompareIn(a=["抓挠"], b=["活动"], win_s=10.0, pool_only=False), db, w.rev))["data"]
    assert r["a"]["segments"] >= 3 and r["a"]["windows"] == r["a"]["segments"]   # 每段 3 秒：整段一个窗口
    # 预览：不读 CSV，给段数 / 能切出的窗口
    pv = run(pool_api.post_compare_preview(pool_api.CompareIn(a=["抓挠"], b=["活动"], win_s=5.0, pool_only=False), db, w.rev))["data"]
    assert pv["a"]["short"] >= 3 and pv["b"]["long"] == 1 and pv["b"]["windows"] == 2
    pv = run(pool_api.post_compare_preview(pool_api.CompareIn(a=["抓挠"], b=["活动"]), db, w.rev))["data"]
    assert pv["a"]["segments"] == 0              # 默认只用数据池：池里还没东西
