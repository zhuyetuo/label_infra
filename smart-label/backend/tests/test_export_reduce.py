"""导出减量：大头类别按段抽掉一部分，降到「其余最大类的 N 倍」；以及层级汇总树。"""

from __future__ import annotations

import copy

from app.services.training_export_service import _reduce, _tally


def _seg(chain, a_s, b_s):
    return {"value": {"timeserieslabels": chain, "start": f"2026-10-01 00:{a_s // 60:02d}:{a_s % 60:02d}.000",
                      "end": f"2026-10-01 00:{b_s // 60:02d}:{b_s % 60:02d}.000",
                      "start_ms": a_s * 1000, "end_ms": b_s * 1000}}


def _data():
    tasks = []
    for tid in range(10):
        res = [_seg(["静止/休息"], 0, 300), _seg(["静止/休息", "睡眠"], 300, 600),   # 每个任务 600 秒静止
               _seg(["抓挠", "抓挠-头颈耳"], 600, 610)]                           # 10 秒抓挠
        if tid == 0:
            res.append(_seg(["活动"], 700, 760))                                   # 活动一共 60 秒
        tasks.append({"id": tid, "annotations": [{"result": res}]})
    return tasks


def test_减到其余最大类的N倍_可复现():
    t1, t2 = _data(), _data()
    rep, warn = _reduce(t1, ["静止/休息"], 2.0)
    _reduce(t2, ["静止/休息"], 2.0)
    assert warn == []
    # 其余最大类是抓挠 100 秒 → 目标 200 秒
    assert rep[0]["before_sec"] == 6000 and rep[0]["after_sec"] == 200 and rep[0]["target_sec"] == 200
    _c, secs, *_ = _tally(t1)
    assert secs["抓挠-头颈耳"] == 100 and secs["活动"] == 60       # 没选的一条不动
    assert abs(secs["静止/休息"] + secs["睡眠"] - 200) < 1e-6
    assert t1 == t2                                                 # 同一批数据抽到的是同一些段


def test_已经不多的不减():
    t = _data()
    before = copy.deepcopy(t)
    rep, _ = _reduce(t, ["静止/休息"], 100.0)
    assert rep[0]["after_sec"] == rep[0]["before_sec"] and t == before


def test_层级树_父类含子类():
    *_, tree = _tally(_data())
    top = {n["label"]: n for n in tree}
    assert top["静止/休息"]["sec"] == 6000 and top["静止/休息"]["n"] == 20
    assert [c["label"] for c in top["静止/休息"]["children"]] == ["睡眠"]
    assert top["抓挠"]["children"][0]["sec"] == 100
    assert "children" not in top["活动"]
