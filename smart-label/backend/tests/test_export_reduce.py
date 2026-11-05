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


def test_手动指定每类留多少秒():
    t = _data()
    rep, warn = _reduce(t, [], 3.0, {"静止/休息": 900, "抓挠": 50})
    got = {r["label"]: r["after_sec"] for r in rep}
    assert got == {"静止/休息": 900, "抓挠": 50} and warn == []
    _c, secs, *_ = _tally(t)
    assert secs["活动"] == 60                                    # 没给的不动
    assert abs(secs["静止/休息"] + secs["睡眠"] - 900) < 1e-6


def test_长片段切块轮流抽_摊到每一段():
    """未佩戴 / 静止这种一段几十分钟：上限 1 小时不能只留一两整段，要从每一段里都拿一点"""
    tasks = []
    for tid in range(19):                                   # 19 段，每段 35 分钟
        tasks.append({"id": tid, "annotations": [{"result": [_seg(["未佩戴"], 0, 35 * 60)]}]})
    t2 = copy.deepcopy(tasks)
    rep, warn = _reduce(tasks, [], 1.0, {"未佩戴": 3600})
    _reduce(t2, [], 1.0, {"未佩戴": 3600})
    assert warn == [] and rep[0]["after_sec"] == 3600
    assert rep[0]["from_segs"] == 19                        # 19 段每段都有份
    per = [sum(_s["value"]["end_ms"] - _s["value"]["start_ms"] for _s in t["annotations"][0]["result"]) / 1000 for t in tasks]
    assert all(120 <= x <= 240 for x in per), per           # 每段约 3 分钟（1 小时 / 19）
    for t in tasks:                                         # 小块都在原段里面、起止字符串跟毫秒对得上
        for sg in t["annotations"][0]["result"]:
            v = sg["value"]
            assert 0 <= v["start_ms"] < v["end_ms"] <= 35 * 60 * 1000
            assert v["start"].startswith("2026-10-01 00:") and v["end"] > v["start"]
    assert tasks == t2                                      # 可复现
