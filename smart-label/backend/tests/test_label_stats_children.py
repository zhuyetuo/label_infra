"""类别统计要同时给大类和细类的时长。

**大类够不等于细类够。** 实测 ds_20260923_1051：抓挠 129 段 1125 秒，占
94.31%，看着很充足——可摊开是 94 段头颈耳、34 段躯干、1 段肩胸，肩胸只有
几秒，根本训不出二级。只看大类的话这件事完全看不见。

数据一直都在：导出文件里 timeserieslabels 存的是整条链 [抓挠, 抓挠-躯干]，
之前统计只取了 labels[0]。
"""

import json
import os

import pytest

from app.core.config import settings
from app.services.training_export_service import TRAIN_DIR, label_stats


def _seg(chain, start, end):
    return {"from_name": "label", "to_name": "ts", "type": "timeserieslabels",
            "value": {"start": start, "end": end, "timeserieslabels": chain}}


@pytest.fixture
def ds(tmp_path, monkeypatch):
    """一份长得像 ds_20260923_1051 的导出。"""
    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    d = tmp_path / TRAIN_DIR / "ds_20260923_1051"
    d.mkdir(parents=True)

    segs = []
    t = 0

    def add(chain, sec):
        nonlocal t
        segs.append(_seg(chain, f"2026-09-23 10:{t // 60:02d}:{t % 60:02d}.000",
                         f"2026-09-23 10:{(t + sec) // 60:02d}:{(t + sec) % 60:02d}.000"))
        t += sec + 1

    for _ in range(9):
        add(["抓挠", "抓挠-头颈耳"], 10)      # 90 秒
    for _ in range(3):
        add(["抓挠", "抓挠-躯干"], 10)        # 30 秒
    add(["抓挠"], 5)                          # 只标到大类的那 1 段
    add(["舔", "舔-躯干"], 8)

    (d / "merged_tmp.json").write_text(
        json.dumps([{"id": 1, "data": {"sample_code": "s1"}, "annotations": [{"result": segs}]}]),
        encoding="utf-8")
    return "ds_20260923_1051"


def test_大类还是原来那个数(ds):
    rows = {r["label"]: r for r in label_stats([ds])["rows"]}
    assert rows["抓挠"]["n_segments"] == 13
    assert rows["抓挠"]["seconds"] == 125.0


def test_细类摊开_按时长从多到少(ds):
    kids = {k["label"]: k for k in
            next(r for r in label_stats([ds])["rows"] if r["label"] == "抓挠")["children"]}
    assert kids["抓挠-头颈耳"]["n_segments"] == 9
    assert kids["抓挠-头颈耳"]["seconds"] == 90.0
    assert kids["抓挠-躯干"]["seconds"] == 30.0
    # 多的排前面：人一眼要看到哪一类撑起了这个大类
    order = [k["label"] for k in
             next(r for r in label_stats([ds])["rows"] if r["label"] == "抓挠")["children"]]
    assert order[0] == "抓挠-头颈耳"


def test_只标到大类的那部分不能省(ds):
    """省掉的话细类加起来对不上大类，人会以为统计错了。"""
    kids = {k["label"]: k for k in
            next(r for r in label_stats([ds])["rows"] if r["label"] == "抓挠")["children"]}
    assert "抓挠（未细分）" in kids
    assert kids["抓挠（未细分）"]["is_root_only"] is True
    assert kids["抓挠（未细分）"]["seconds"] == 5.0
    root = next(r for r in label_stats([ds])["rows"] if r["label"] == "抓挠")
    assert round(sum(k["seconds"] for k in root["children"]), 1) == root["seconds"]


def test_细类占比按本大类算_不是全局(ds):
    """要回答的是"抓挠里头颈耳占多少"，不是"头颈耳占全部数据多少"。"""
    kids = {k["label"]: k for k in
            next(r for r in label_stats([ds])["rows"] if r["label"] == "抓挠")["children"]}
    assert kids["抓挠-头颈耳"]["pct_in_parent"] == pytest.approx(72.0, abs=0.1)   # 90/125
    assert sum(k["pct_in_parent"] for k in kids.values()) == pytest.approx(100.0, abs=0.2)


def test_没有二级标签的大类只有一个未细分的孩子(ds):
    lick = next(r for r in label_stats([ds])["rows"] if r["label"] == "舔")
    assert [k["label"] for k in lick["children"]] == ["舔-躯干"]
