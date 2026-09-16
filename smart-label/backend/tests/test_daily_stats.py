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


# ── 按狗 / 按设备筛 ────────────────────────────────────────────────────────


def test_imu_nums_accepts_both_forms_and_dedups():
    """「IMU5」和「5」都认；重复的去掉，顺序不变。

    「按狗」和「按设备」两种选法可以同时选，同一个设备会出现两次。
    """
    assert svc._imu_nums(["IMU5", "5", "IMU5", "IMU9"]) == ["5", "9"]
    assert svc._imu_nums([" imu12 "]) == ["12"]
    assert svc._imu_nums(["", "abc", None if False else "x"]) == []


def test_filter_narrows_in_sql_not_just_in_python():
    """筛选要**落到 SQL 里**。

    只在内存里丢的话，看一只狗也要把全部狗的行拉出来——而"看单只狗"
    是最常用的看法，一天几百个样本、几十天，那是白扫。
    """
    import asyncio

    captured = {}

    class FakeDB:
        def __init__(self):
            self.n = 0

        async def execute(self, q):
            self.n += 1
            if self.n > 1:      # 第一次是查狗档案
                captured["sql"] = str(q.compile(compile_kwargs={"literal_binds": True}))

            class R:
                @staticmethod
                def all():
                    return []
            return R()

    d = _dt.date(2026, 9, 13)
    asyncio.run(svc.daily(FakeDB(), d, d, "m", "viterbi", imus=["IMU5"]))
    assert "like" in captured["sql"].lower(), "筛选没进 SQL"
    assert "imu5" in captured["sql"].lower()


def test_filter_does_not_leak_similar_device_numbers(run):
    """筛 IMU5 不能把 IMU15 也带出来。

    `like '%imu5'` 要求以 imu5 结尾，imu15 是以 u15 结尾，所以不会误中。
    但 like 之后还有一层精确核对（_imu_of）——两层都在，这条钉的是结果。
    """
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=5)),
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=15)),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi", imus=["IMU5"]))
    assert [r["imu"] for r in out] == ["IMU5"], out


def test_filter_by_dog_takes_all_its_devices(run):
    """按狗筛要带上它名下全部设备。

    一只狗轮换两个 IMU 充电，只筛其中一个会出现「只看到这只狗一半的日子」
    ——而表上完全看不出为什么少了几天。
    """
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=9)),
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=12)),
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=5)),
    ]
    out = run(svc.daily(_DB(rows), d, d, "m", "viterbi", imus=["IMU9", "IMU12"]))
    assert sorted(r["imu"] for r in out) == ["IMU12", "IMU9"]


def test_no_filter_means_all(run):
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=5)),
        (_Run(secs={"睡觉": 60}, counts={}), _Sample(d, imu=9)),
    ]
    assert len(run(svc.daily(_DB(rows), d, d, "m", "viterbi"))) == 2
    assert len(run(svc.daily(_DB(rows), d, d, "m", "viterbi", imus=[]))) == 2


def test_dogs_endpoint_lists_both_devices_of_a_dog(run):
    """狗列表要把一只狗的两个设备都列出来——前端「按设备」那一组靠它。"""
    class DogDB:
        async def execute(self, q):
            data = [("1", "bibi", "5"), ("2", "dodo", "IMU9，IMU12")]

            class R:
                @staticmethod
                def all():
                    return data
            return R()

    out = run(svc.dogs(DogDB()))
    by = {d["dog_name"]: d["imus"] for d in out}
    assert by["bibi"] == ["IMU5"]
    assert by["dodo"] == ["IMU9", "IMU12"]


def test_dog_options_come_from_the_roster_not_the_data():
    """下拉的选项从狗档案来，不从当前数据扫。

    从数据扫的话，筛掉一只狗之后剩下的选项也跟着变少——下拉会越点越空。
    """
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(svc.dogs).strip())
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "Dog" in names, "没查狗档案"
    assert "SampleInferenceRun" not in names, "从数据里扫选项了"


def test_ui_offers_both_by_dog_and_by_device():
    """界面上两种选法都要有。"""
    import os
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "pages", "DailyStats.tsx")
    with open(p, encoding="utf-8") as f:
        src = f.read()
    assert 'label: "按狗"' in src
    assert 'label: "按设备"' in src
    assert 'mode="multiple"' in src, "不能多选的话没法同时看两只狗"


# ── 合计（跟 24 小时对） ──────────────────────────────────────────────────


def test_total_seconds_is_the_sum_of_the_columns_shown(run):
    """合计必须等于表上那几列相加。

    如果这里偷偷把某个没展示的类别也加进去，人会看到"每列加起来不等于合计"，
    而那种对不上最难查——两个数都"对"，只是口径不一样。
    """
    d = _dt.date(2026, 9, 13)
    secs = {"活动": 8 * 3600, "睡觉": 13 * 3600, "抓挠": 60, "未佩戴": 3600, "甩身体": 0}
    out = run(svc.daily(_DB([(_Run(secs=secs, counts={}), _Sample(d))]), d, d, "m", "viterbi"))
    r = out[0]
    assert r["total_seconds"] == pytest.approx(sum(r["seconds"].values()))
    assert r["total_seconds"] == pytest.approx(22 * 3600 + 60)


def test_total_seconds_excludes_missing_seconds(run):
    """缺数据**不算进合计**。

    算进去的话合计会凑得很接近 24 小时，反而把"那天没采满"这件事盖住——
    而这正是人要从合计里看出来的东西。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"睡觉": 3600}, counts={}, missing=1800.0), _Sample(d))]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["total_seconds"] == pytest.approx(3600)
    assert r["missing_seconds"] == pytest.approx(1800)


def test_total_seconds_sums_across_samples_of_the_day(run):
    """一天几个样本，合计是全天的，不是最后一个样本的。"""
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 3600, "活动": 1800}, counts={}), _Sample(d)),
        (_Run(secs={"睡觉": 1800}, counts={}), _Sample(d)),
    ]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["total_seconds"] == pytest.approx(7200)


def test_total_seconds_is_none_when_duration_unknown(run):
    """没有时长数据时合计是 None，**不是 0**。

    给 0 的话那些老行会显示"合计 0 小时，比 24 小时少 24 小时"——
    看起来像这只狗那天彻底失联，而其实只是这列数据没记。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs=None, counts={"睡觉": 3}), _Sample(d))]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["has_seconds"] is False
    assert r["total_seconds"] is None


def test_total_can_exceed_a_day_and_is_not_clamped(run):
    """合计超过 24 小时时**照实给**，不截到 24。

    超过说明样本时间段有重叠（数据重复导入之类）——那是要查的问题。
    截一下的话它看起来完全正常，问题就永远不会被发现。
    """
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 20 * 3600}, counts={}), _Sample(d)),
        (_Run(secs={"睡觉": 20 * 3600}, counts={}), _Sample(d)),
    ]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["total_seconds"] == pytest.approx(40 * 3600)


def test_ui_shows_a_total_column_and_explains_the_gap():
    """界面上要有合计列，并且能解释为什么对不上 24 小时。

    只给一个"不对"的数字没用——偏多（重叠，是 bug）和偏少（没采满，正常）
    是两类完全不同的事，人得知道该不该管。
    """
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "src")
    with open(os.path.join(base, "pages", "DailyStats.tsx"), encoding="utf-8") as f:
        page = f.read()
    assert "合计" in page
    assert "total_seconds" in page, "合计没用后端算好的那个数"
    assert "DayTotalHelp" in page, "没有解释对不上的原因"
    with open(os.path.join(base, "components", "DayTotalHelp.tsx"), encoding="utf-8") as f:
        help_src = f.read()
    assert "偏多" in help_src and "偏少" in help_src, "两个方向要分开说"


# ── 未采集（把一天对平） ──────────────────────────────────────────────────


def test_a_day_adds_up_to_exactly_24h(run):
    """合计 + 缺数据 + 未采集 == 24 小时，一秒不差。

    这是整张表的对账式。对不平的话人没法判断少掉的时间去哪了，
    只能自己拿 24 减——而减出来的那个数没有名字，容易被当成"都是断联"，
    从而去查一个不存在的蓝牙问题。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"活动": 4 * 3600 + 37 * 60, "睡觉": 7 * 3600 + 35 * 60,
                        "抓挠": 60, "未佩戴": 37 * 60}, counts={},
                  missing=24 * 60.0), _Sample(d))]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert (r["total_seconds"] + r["missing_seconds"]
            + r["uncovered_seconds"]) == pytest.approx(86400)


def test_uncovered_is_not_the_same_thing_as_missing(run):
    """「没在记」和「在记但断联」要分开。

    合成一个数的话，"那天只戴了 10 小时"（正常）和"戴了一整天但断联 14 小时"
    （设备坏了）会长得一模一样。
    """
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs={"睡觉": 10 * 3600}, counts={}, missing=600.0), _Sample(d))]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["missing_seconds"] == pytest.approx(600)
    assert r["uncovered_seconds"] == pytest.approx(86400 - 10 * 3600 - 600)


def test_uncovered_goes_negative_on_overlap_instead_of_clamping(run):
    """时间超过一天时未采集是**负数**，不是 0。

    负数就是"样本时间段有重叠"的信号（同一批数据导入了两次之类）。
    截到 0 的话这一行看起来跟"刚好采满一天"完全一样，问题永远发现不了。
    """
    d = _dt.date(2026, 9, 13)
    rows = [
        (_Run(secs={"睡觉": 20 * 3600}, counts={}), _Sample(d)),
        (_Run(secs={"睡觉": 20 * 3600}, counts={}), _Sample(d)),
    ]
    r = run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]
    assert r["uncovered_seconds"] == pytest.approx(86400 - 40 * 3600)
    assert r["uncovered_seconds"] < 0


def test_uncovered_is_none_when_duration_unknown(run):
    """没有时长数据时未采集也是 None——算不出来，就别给一个数。"""
    d = _dt.date(2026, 9, 13)
    rows = [(_Run(secs=None, counts={"睡觉": 3}), _Sample(d))]
    assert run(svc.daily(_DB(rows), d, d, "m", "viterbi"))[0]["uncovered_seconds"] is None


def test_ui_shows_missing_and_uncovered_separately():
    """界面上两列都要有，而且缺数据不能因为「小」就显示成「—」。

    显示「—」的话，一行写着「合计 12 小时 51 分 / 缺数据 —」，
    看着像那天完整覆盖、只是行为只有 12 小时——而真相是只记了 13 个小时。
    """
    import os
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "pages", "DailyStats.tsx")
    with open(p, encoding="utf-8") as f:
        src = f.read()
    assert "未采集" in src
    assert "uncovered_seconds" in src
    # 小于一分钟时给秒，不给「0 分」——后者看着像没断过
    assert "秒" in src, "不满一分钟的缺数据会被四舍五入没了"
