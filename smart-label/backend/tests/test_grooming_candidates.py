"""疑似舔/啃候选走「疑似抓挠」那条现成通道：label_service 每条候选带 label，平台照收。

老版本的 label_service 不给 label 字段——那些还得是抓挠，不能变成没类别。
"""

from __future__ import annotations

from datetime import datetime

from app.services.ai_prelabel_service import flatten_candidates

T0 = datetime(2026, 9, 17, 10, 0, 0)


def _raw(**over):
    d = {"start_ts": "2026-09-17 10:02:00.000", "end_ts": "2026-09-17 10:02:20.000",
         "conf_mean": 0.6, "spec": None, "reason": "low_conf"}
    d.update(over)
    return d


def test_label_from_service_is_kept():
    got = flatten_candidates([_raw(label="舔身体", reason="grooming")], T0)
    assert got[0].label_name == "舔身体"
    assert got[0].reason == "grooming"


def test_missing_label_still_means_scratch():
    """老 label_service 的候选没有 label 字段：那就是抓挠，跟以前一样。"""
    got = flatten_candidates([_raw()], T0)
    assert got[0].label_name == "抓挠"


def test_empty_label_falls_back_too():
    got = flatten_candidates([_raw(label="")], T0)
    assert got[0].label_name == "抓挠"


def test_mixed_list_keeps_each_ones_label():
    got = flatten_candidates([_raw(label="舔身体", reason="grooming"), _raw()], T0)
    assert sorted(c.label_name for c in got) == ["抓挠", "舔身体"]
