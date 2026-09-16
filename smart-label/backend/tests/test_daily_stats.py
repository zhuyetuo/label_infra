"""日常统计：每只狗每天各类行为多久、多少次。

这些测试盯的是几件"错了不报错"的事：
  · 不同模型版本的数据混着加（得到一个悄悄平均掉的数字）
  · "没有时长数据"被当成"时长是 0"（历史行看起来像这只狗一整天没动）
  · 片段时间解析失败被当成 0 秒（一整天的时长悄悄少一截）
"""

import datetime as _dt
import json

import pytest

from app.services import ai_prelabel_service as prelabel
from app.services import daily_stats_service as svc


# ── 每类时长的计算 ────────────────────────────────────────────────────────


def test_label_seconds_sums_segment_durations():
    segs = {
        "睡觉": [{"start_ts": "2026-09-13 01:00:00.000", "end_ts": "2026-09-13 03:00:00.000"},
                 {"start_ts": "2026-09-13 04:00:00.000", "end_ts": "2026-09-13 05:30:00.000"}],
        "抓挠": [{"start_ts": "2026-09-13 10:00:00.000", "end_ts": "2026-09-13 10:00:12.500"}],
    }
    got = prelabel._label_seconds(segs)
    assert got["睡觉"] == pytest.approx(2 * 3600 + 1.5 * 3600)
    assert got["抓挠"] == pytest.approx(12.5)


def test_unparseable_segment_is_skipped_not_counted_as_zero():
    """解析不了的片段**跳过，不当成 0 秒**。

    当成 0 的话一整天的时长会悄悄少一截，而看数字完全正常。
    跳过至少让总数偏小的方式是"少一段"，跟"这段是 0 秒"是两回事。
    """
    segs = {"睡觉": [
        {"start_ts": "2026-09-13 01:00:00.000", "end_ts": "2026-09-13 02:00:00.000"},
        {"start_ts": "坏掉的", "end_ts": "2026-09-13 03:00:00.000"},
        {"start_ts": "2026-09-13 04:00:00.000"},          # 缺 end
        {"start_ts": "2026-09-13 06:00:00.000", "end_ts": "2026-09-13 05:00:00.000"},  # 倒转
    ]}
    assert prelabel._label_seconds(segs)["睡觉"] == pytest.approx(3600)


def test_seconds_not_minutes():
    """存秒不存分钟：跨天汇总时先取整会一点点攒出误差。"""
    segs = {"抓挠": [{"start_ts": "2026-09-13 10:00:00.000",
                      "end_ts": "2026-09-13 10:00:20.000"}] * 3}
    assert prelabel._label_seconds(segs)["抓挠"] == pytest.approx(60.0)


def test_timestamp_without_millis_is_accepted():
    """两种格式都要认——片段时间是别的服务给的，格式不由这边控制。"""
    segs = {"活动": [{"start_ts": "2026-09-13 10:00:00", "end_ts": "2026-09-13 10:10:00"}]}
    assert prelabel._label_seconds(segs)["活动"] == pytest.approx(600)


# ── 聚合 ──────────────────────────────────────────────────────────────────


class _Run:
    def __init__(self, n_windows=100, missing=0.0, secs=None, counts=None):
        self.n_windows = n_windows
        self.missing_seconds = missing
        self.label_seconds = json.dumps(secs) if secs is not None else None
        self.label_counts = json.dumps(counts or {})


class _Sample:
    def __init__(self, d, dog_id=1):
        self.session_date = d
        self.dog_id = dog_id


class _Dog:
    def __init__(self, name="bibi"):
        self.name = name


class _DB:
    def __init__(self, rows):
        self._rows = rows

    async def execute(self, q):
        rows = self._rows

        class R:
            @staticmethod
            def all():
                return rows
        return R()


@pytest.fixture
def run():
    import asyncio
    return lambda c: asyncio.run(c)


def test_same_day_multiple_samples_are_summed(run):
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 3600}, counts={"睡觉": 2}), _Sample(d), _Dog()),
        (_Run(secs={"睡觉": 1800}, counts={"睡觉": 1}), _Sample(d), _Dog()),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert len(out) == 1
    assert out[0]["seconds"]["睡觉"] == pytest.approx(5400)
    assert out[0]["counts"]["睡觉"] == 3
    assert out[0]["n_samples"] == 2


def test_missing_label_seconds_is_flagged_not_zeroed(run):
    """老的行没有 label_seconds（那一列是后加的、历史不回填）。

    **"没有时长"和"时长是 0"必须分得开**——混在一起的话，历史那些行
    看起来像这只狗一整天没动过。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs=None, counts={"睡觉": 5}), _Sample(d), _Dog())]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["has_seconds"] is False
    assert out[0]["counts"]["睡觉"] == 5


def test_partial_seconds_still_counts_as_having_data(run):
    """一天里只要有一个样本带时长，就算有数据——那一行的时长是真的，
    只是不完整。全当成没有的话反而更糟。"""
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs=None, counts={"睡觉": 1}), _Sample(d), _Dog()),
        (_Run(secs={"睡觉": 600}, counts={"睡觉": 1}), _Sample(d), _Dog()),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["has_seconds"] is True
    assert out[0]["seconds"]["睡觉"] == pytest.approx(600)


def test_label_order_is_fixed_not_alphabetical(run):
    """类别按固定顺序排，不按字典序。

    按字典序的话换一个模型列的顺序就变，两天的表放一起看不出哪列是哪列。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"甩身体": 1, "活动": 1, "抓挠": 1, "睡觉": 1, "未佩戴": 1},
                  counts={}), _Sample(d), _Dog())]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["labels"] == ["活动", "睡觉", "抓挠", "未佩戴", "甩身体"]


def test_three_class_model_does_not_get_phantom_columns(run):
    """3 类模型的那天**不该多出未佩戴/甩身体两列**。

    补上空列的话看着像"这两类一直是 0"，而实际是这个模型根本没有它们。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"活动": 1, "睡觉": 1, "抓挠": 1}, counts={}), _Sample(d), _Dog())]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["labels"] == ["活动", "睡觉", "抓挠"]
    assert "未佩戴" not in out[0]["seconds"]


def test_missing_seconds_is_carried_through(run):
    """缺数据要报出来——缺得多的话下面那些数天然偏低，
    别被当成"今天没动"。"""
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(missing=1200.0, secs={"活动": 60}, counts={}), _Sample(d), _Dog())]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["missing_seconds"] == pytest.approx(1200.0)


# ── 版本不能混 ────────────────────────────────────────────────────────────


def test_query_filters_by_model_and_mode():
    """SQL 里必须同时按 model_tag 和 mode 过滤。

    少一个的话，一天里跑过两个版本的样本会被加在一起——得到一个
    悄悄把两版平均掉的数字，**而它看起来完全正常**。
    直接比编译出来的 SQL，因为这条在结果上看不出来。
    """
    import asyncio

    captured = {}

    class FakeDB:
        async def execute(self, q):
            captured["sql"] = str(q.compile(compile_kwargs={"literal_binds": True}))

            class R:
                @staticmethod
                def all():
                    return []
            return R()

    d = _dt.date(2026, 9, 13)
    asyncio.run(svc.daily(FakeDB(), d, d, "edge_rf_d10", "board"))
    sql = captured["sql"]
    assert "'edge_rf_d10'" in sql, "没按模型过滤，两个模型会混在一起"
    assert "'board'" in sql, "没按版本过滤，两个版本会混在一起"
    assert "session_date" in sql


def test_api_requires_model_and_mode():
    """接口**不给默认值**——默认一个版本的话，人看到的是一个自己没选过的
    数字，而它看起来就像"全部数据"。"""
    import inspect

    from pydantic_core import PydanticUndefined

    from app.api.v1 import daily_stats as api
    sig = inspect.signature(api.daily)
    for name in ("model_tag", "mode"):
        p = sig.parameters[name]
        # Query(...) 在 FastAPI 里存成 PydanticUndefined，不是 Ellipsis——
        # 我第一版按 Ellipsis 断言，挂了才发现。挂了是好事：要是当时写成
        # "不等于 None" 之类的宽松判断，这条就永远绿了
        assert p.default.default is PydanticUndefined, f"{name} 有默认值了"
