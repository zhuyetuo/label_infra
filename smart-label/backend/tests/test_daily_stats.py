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
    def __init__(self, d, imu=5):
        self.session_date = d
        self.sample_code = f"20260913_x_imu{imu}"
        self.dog_id = None      # 实际数据里基本是空的，所以不能靠它分组


class _DB:
    def __init__(self, rows):
        self._rows = rows
        self._n = 0

    async def execute(self, q):
        # 第一次是查狗档案（_imu_to_dog），之后才是主查询
        self._n += 1
        rows = [] if self._n == 1 else self._rows

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
        (_Run(secs={"睡觉": 3600}, counts={"睡觉": 2}), _Sample(d)),
        (_Run(secs={"睡觉": 1800}, counts={"睡觉": 1}), _Sample(d)),
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
    rows = [(_Run(secs=None, counts={"睡觉": 5}), _Sample(d))]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["has_seconds"] is False
    assert out[0]["counts"]["睡觉"] == 5


def test_partial_seconds_still_counts_as_having_data(run):
    """一天里只要有一个样本带时长，就算有数据——那一行的时长是真的，
    只是不完整。全当成没有的话反而更糟。"""
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs=None, counts={"睡觉": 1}), _Sample(d)),
        (_Run(secs={"睡觉": 600}, counts={"睡觉": 1}), _Sample(d)),
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
                  counts={}), _Sample(d))]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["labels"] == ["活动", "睡觉", "抓挠", "未佩戴", "甩身体"]


def test_three_class_model_does_not_get_phantom_columns(run):
    """3 类模型的那天**不该多出未佩戴/甩身体两列**。

    补上空列的话看着像"这两类一直是 0"，而实际是这个模型根本没有它们。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"活动": 1, "睡觉": 1, "抓挠": 1}, counts={}), _Sample(d))]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert out[0]["labels"] == ["活动", "睡觉", "抓挠"]
    assert "未佩戴" not in out[0]["seconds"]


def test_missing_seconds_is_carried_through(run):
    """缺数据要报出来——缺得多的话下面那些数天然偏低，
    别被当成"今天没动"。"""
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(missing=1200.0, secs={"活动": 60}, counts={}), _Sample(d))]
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


# ── 按狗分组 ──────────────────────────────────────────────────────────────


def test_rows_are_per_dog_not_all_merged(run):
    """一天里不同设备的样本要分成**不同的行**。

    第一版我按 Sample.dog_id 分组——而那一列在实际数据里基本是空的，
    于是所有狗被 collapse 成一行：一天 303 个样本、180 万个窗口挤在一起，
    「狗」那列显示「—」。**不报错，只是这张表完全没用。**
    """
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 3600}, counts={}), _Sample(d, imu=5)),
        (_Run(secs={"睡觉": 1800}, counts={}), _Sample(d, imu=9)),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert len(out) == 2, f"两个设备该是两行，实际 {len(out)} 行"
    assert {r["imu"] for r in out} == {"IMU5", "IMU9"}
    assert {r["seconds"]["睡觉"] for r in out} == {3600, 1800}


def test_same_dog_same_day_still_merges(run):
    """同一个设备同一天的多个样本还是要合并（分段采集）。"""
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 3600}, counts={}), _Sample(d, imu=5)),
        (_Run(secs={"睡觉": 1800}, counts={}), _Sample(d, imu=5)),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))
    assert len(out) == 1
    assert out[0]["seconds"]["睡觉"] == pytest.approx(5400)


def test_dog_comes_from_sample_code_not_dog_id():
    """狗是从 sample_code 解析 IMU 来的，跟皮肤评估同一套。

    各写各的话，同一个样本在两个页面上会被判给不同的狗——而两边看起来都对。
    """
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(svc.daily).strip())
    # **先剥掉注释和 docstring 再扫**：docstring 里正写着"不是用 dog_id"，
    # 全文搜关键词会把那句解释当成在用它。
    # （这个跟头我在 model_of、logf 两处已经栽过——第三次了，所以这次
    #   直接用 AST：看的是真的属性访问，不是文本。）
    attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "_imu_of" in names, "没从 sample_code 解析 IMU"
    assert "sample_code" in attrs, "没读 sample_code"
    assert "dog_id" not in attrs, "还在用 Sample.dog_id 分组——那一列基本是空的"


def test_unknown_device_is_not_silently_dropped(run):
    """sample_code 里解析不出 IMU 的样本**不能丢掉**，归到「未知设备」。

    丢掉的话总数对不上，而看这张表完全看不出少了东西。
    """
    d = _dt.date(2026, 9, 13)
    s = _Sample(d)
    s.sample_code = "没有设备号的编码"
    out = run(svc.daily(_DB([(_Run(secs={"睡觉": 60}, counts={}), s)]), d, d, "m", "viterbi"))
    assert len(out) == 1 and out[0]["imu"] == "未知设备"


# ── 回填脚本 ──────────────────────────────────────────────────────────────


def test_backfill_skips_unreadable_json_instead_of_writing_zeros(tmp_path, monkeypatch):
    """读不到 JSON 的行**跳过，不写空字典**。

    写空的话那一行会变成「有时长数据，全是 0」——比「时长未记」更糟，
    因为它看着像真的。
    """
    from app.core.config import settings
    from app.scripts import backfill_label_seconds as bf

    monkeypatch.setattr(settings, "nas_root", str(tmp_path))
    assert bf._read("不存在的.json") is None
    bad = tmp_path / "bad.json"
    bad.write_text("{不是合法 json", encoding="utf-8")
    assert bf._read("bad.json") is None
    good = tmp_path / "good.json"
    good.write_text('{"segments": {}}', encoding="utf-8")
    assert bf._read("good.json") == {"segments": {}}


def test_backfill_only_touches_rows_missing_seconds():
    """只补 label_seconds 为空的行，所以可以重复跑、断了接着跑。"""
    import inspect
    from app.scripts import backfill_label_seconds as bf
    src = inspect.getsource(bf.run)
    assert "label_seconds.is_(None)" in src, "没有只挑缺的那些行，会把已有的重算一遍"


def test_backfill_reuses_the_same_duration_calculation():
    """回填用的必须是**写索引时同一个函数**。

    另写一份的话，补出来的历史数据跟新跑的数据算法不一样，
    而两边看起来都对——同一只狗同一类行为，新旧两段时间的数会有系统性偏差。
    """
    import inspect
    from app.scripts import backfill_label_seconds as bf
    src = inspect.getsource(bf)
    assert "from app.services.ai_prelabel_service import _label_seconds" in src


# ── 图 ────────────────────────────────────────────────────────────────────


def _charts_src() -> str:
    import os
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "components", "DailyStatsCharts.tsx")
    with open(p, encoding="utf-8") as f:
        return f.read()


def test_charts_use_the_same_units_as_the_table():
    """图和表必须同一个口径：抓挠/甩身体看次数，其余看时长。

    两处口径不一样的话，同一天的数看着对不上，而两边各自都"对"。
    """
    src = _charts_src()
    assert 'COUNT_LABELS = new Set(["抓挠", "甩身体"])' in src, \
        "图里的次数/时长口径跟表格不一致"


def test_missing_duration_is_a_gap_not_a_zero_in_charts():
    """没有时长数据的那天要**断线**，不能画成 0。

    画成 0 的话图上看起来是"这天真的一点没动"——而那是这个页面
    最容易被误读的地方，图比表更容易误导。
    """
    src = _charts_src()
    assert "if (!r.has_seconds) return null" in src, \
        "没有时长数据时画成了 0，图上会显示成「这天真的是 0」"


def test_charts_are_one_per_label_not_stacked():
    """一个类别一张图，不堆叠。

    五个类别量纲差一个数量级（睡觉十几小时、抓挠几分钟），堆一起的话
    抓挠会被压成贴着 X 轴的一条线——而那恰好是最需要看的。
    """
    src = _charts_src()
    assert "labels.map((l) => (" in src, "不是一个类别一张图"
    assert "stack" not in src.lower(), "用了堆叠"


def test_charts_share_the_palette_with_the_skin_page():
    """跟皮肤评估用同一套分类色。

    不同色的话，同一只狗在两个页面上是两个颜色，人会以为是两只狗。
    """
    import os
    src = _charts_src()
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "components", "TrackingCharts.tsx")
    with open(p, encoding="utf-8") as f:
        other = f.read()
    for name in ("SERIES_LIGHT", "SERIES_DARK"):
        a = src.split(f"const {name} = ")[1].split(";")[0]
        b = other.split(f"const {name} = ")[1].split(";")[0]
        assert a == b, f"{name} 跟 TrackingCharts 不一样了，同一只狗会变色"


def test_dog_name_mapping_reuses_the_shared_helper(run):
    """IMU → 狗名要走 imu_keys_of_dog，**不能自己写一套**。

    那个函数处理了几件实际数据里就有的情况：
      · 一只狗两个 IMU 轮换充电（逗号分隔，中英文逗号都认）
      · 大家习惯只填数字「5」而不是「IMU5」
      · 什么都没填、编号本身是数字时按编号当设备号

    自己写 `.upper()` 的话这三种全对不上，那只狗在这个页面上显示「未登记」，
    而在皮肤评估页面上是有名字的——同一只狗，两个页面两个说法。
    """
    d = _dt.date(2026, 9, 13)

    class DogDB:
        def __init__(self, dogs, rows):
            self._dogs, self._rows, self._n = dogs, rows, 0

        async def execute(self, q):
            self._n += 1
            data = self._dogs if self._n == 1 else self._rows

            class R:
                @staticmethod
                def all():
                    return data
            return R()

    # (dog_code, name, imu)：一只只填数字，一只填了两个设备
    dogs = [("1", "bibi", "5"), ("2", "dodo", "IMU9，IMU12")]
    rows = [
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=5)),
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=12)),
    ]
    out = run(svc.daily(DogDB(dogs, rows), d, d, "m", "viterbi"))
    names = {r["imu"]: r["dog_name"] for r in out}
    assert names.get("IMU5") == "bibi", f"只填数字的那只没映射上：{names}"
    assert names.get("IMU12") == "dodo", f"一只狗两个设备时第二个没映射上：{names}"
