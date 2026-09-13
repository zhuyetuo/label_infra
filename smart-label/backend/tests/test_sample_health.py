"""
样本体检的测试。

判据是「CSV 行数 ÷（视频时长 × 采样率）」——把"有文件"和"有数据"区分开。
这条的必要性来自一段真实素材：`multicam_20260816_160001055_cam1_imu1_raw.mp4`，
5 分钟、文件名是配对好的、画面正常、能预览能建任务，但视频里烧着的 overlay
从头到尾写着 `[Bibi] MISSING` ——它配对的那路 IMU 整段没连上。

这种样本在库里跟正常的长得一模一样。不体检的话，只有等标注员标到一半发现波形
是平的，或者更糟：训练集里混进一批没有标签依据的片段。
"""

import pytest

from app.services import sample_health_service as health


def _csv(tmp_path, name: str, rows: int, hz: float = 50.0) -> str:
    """写一份长得像真的 CSV：第一列是 epoch 毫秒（采集端 raw 就是这么写的），
    按给定采样率排。时间戳不真实的话 measure_csv_hz 会量出个离谱的数，
    测出来的就不是被测逻辑而是测试数据本身。"""
    p = tmp_path / name
    t0 = 1786424400488.0
    step = 1000.0 / hz
    p.write_text(
        "pc_ms,acc_x,acc_y,acc_z\n" + "".join(f"{t0 + i * step:.3f},0,0,1\n" for i in range(rows)),
        encoding="utf-8",
    )
    return name


def test_整段没连上的_imu_被标出来(tmp_path):
    """就是那段素材的情形：视频 295 秒、50Hz，正常该有 14750 行，实际只有表头。"""
    rel = _csv(tmp_path, "a.csv", 0)
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "empty"
    assert "没连上" in r["reason"]


def test_掉线一大半的也被标出来(tmp_path):
    """比空文件更阴险：有数据、能画出波形、能标注，只是大半段是空的。"""
    rel = _csv(tmp_path, "b.csv", 3000)   # 295s × 50Hz = 14750，只有两成
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "bad"
    assert r["coverage"] is not None and r["coverage"] < 0.5
    assert "20%" in r["reason"]


def test_正常样本是_ok(tmp_path):
    rel = _csv(tmp_path, "c.csv", 14700)
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "ok"
    assert r["reason"] == ""
    assert r["coverage"] >= 0.99


def test_中间缺一块是_partial_不是_bad(tmp_path):
    """能用但要知道——直接判 bad 会让人把还能用的数据也扔了。"""
    rel = _csv(tmp_path, "d.csv", 11000)  # 约 75%
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "partial"
    assert "缺了一块" in r["reason"]


def test_采样率对不上会被指出来(tmp_path):
    """8-11 之前那批是采集端就降到 16Hz 存的。按 50Hz 去跑 16Hz 的文件，
    重采样和特征窗口全错，而且不报错。"""
    rel = _csv(tmp_path, "e.csv", 4720)   # 295s × 16Hz
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=16.0, declared_hz=50)
    assert r["verdict"] == "hz_mismatch"
    assert "16" in r["reason"] and "50" in r["reason"]


def test_文件没了不会炸(tmp_path):
    r = health.check_one(str(tmp_path), "不存在.csv", duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "no_csv"
    assert r["rows"] is None


def test_没有_csv_路径的样本(tmp_path):
    r = health.check_one(str(tmp_path), None, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "no_csv"


def test_没记采样率时会自己量出来(tmp_path):
    """sample_hz 是后来才加的字段，老样本上是空的。空了不能就放弃体检——
    量一遍就有了。"""
    rel = _csv(tmp_path, "f.csv", 14700, hz=50.0)
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=None)
    assert r["hz"] is not None and 45 <= r["hz"] <= 55, r
    assert r["verdict"] == "ok"


def test_缺视频时长时不硬判(tmp_path):
    """算不出来就说算不出来，不要瞎猜一个结论——瞎猜的结论会被当真。"""
    rel = _csv(tmp_path, "f2.csv", 100)
    r = health.check_one(str(tmp_path), rel, duration_sec=None, sample_hz=50.0)
    assert r["verdict"] == "unknown"
    assert r["coverage"] is None


def test_多写几行不会算出超过百分之百(tmp_path):
    """采集端偶尔多写几行。不封顶的话这些会排到最前面，把真问题挤下去。"""
    rel = _csv(tmp_path, "g.csv", 20000)
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["coverage"] == 1.0
    assert r["verdict"] == "ok"


@pytest.mark.parametrize("verdict", ["no_csv", "empty", "bad", "hz_mismatch", "partial", "unknown"])
def test_该让人看的结论都在清单里(verdict):
    assert verdict in health.NEEDS_ATTENTION


def test_ok_不进清单():
    """全库几千条样本，正常的也列出来就没人看了。"""
    assert "ok" not in health.NEEDS_ATTENTION


# ── 影棚新旧数据要分得开 ────────────────────────────────────────────────
#
# 同一个 imu 号在新旧数据里指的不是同一个设备：
#     文件里的 imu2   9-11 及以前 = WT5（lulu 的）   9-12 起 = WT2（bibi 的）
# 同一张狗档案登记表，对老数据有一半会给出错的狗——而且不报错、界面上看不出来。
# 采集端从 9-13 起把后缀改成 _yingpeng2，这里据此把老的标出来。

@pytest.mark.parametrize("rel,expected", [
    ("data_raw/2026_9_10_yingpeng/a_imu2_raw.csv", True),     # 改编号之前
    ("data_raw/2026_9_11_yingpeng/a_imu2_raw.csv", True),     # 最后一天错的
    ("data_raw/2026_9_12_yingpeng/a_imu2_raw.csv", False),    # 改编号当天，已经是对的
    ("data_raw/2026_9_13_yingpeng/a_imu2_raw.csv", False),    # 编号对了、目录还是老名字
    ("data_raw/2026_9_14_yingpeng2/a_imu2_raw.csv", False),   # 新后缀
    ("data_raw/2026_9_13_gouchang/a_imu2_raw.csv", False),    # 狗场一直是真实编号
    ("data_raw/2026_9_10/a_imu2_raw.csv", False),             # 没后缀的老数据，另说
    ("data_raw/乱七八糟_yingpeng/a.csv", False),               # 日期取不出来 → 不标
    (None, False),
])
def test_认得出影棚老数据(rel, expected):
    assert health.is_legacy_yingpeng(rel) is expected


def test_编号改掉那天之后的不算老数据():
    """后缀是 9-13 才加的，编号是 9-12 改的——中间那一天多的数据编号已经对了、
    目录却还叫 _yingpeng。只按后缀判会把这批好数据误标成"归属不可信"，
    比不标还糟：真正有问题的那批会淹没在误报里，久了就没人看了。"""
    assert health.is_legacy_yingpeng("d/2026_9_11_yingpeng/x.csv") is True
    assert health.is_legacy_yingpeng("d/2026_9_12_yingpeng/x.csv") is False
    assert health.is_legacy_yingpeng("d/2026_9_13_yingpeng/x.csv") is False


def test_yingpeng2_不能被当成_yingpeng():
    """后缀判断最容易翻的地方：endswith('_yingpeng') 对 '_yingpeng2' 是 False，
    但反过来写成 in 或者去掉数字就会误伤——新数据被标成"归属不可信"，
    等于这次改后缀白改。"""
    assert health.is_legacy_yingpeng("d/2026_9_14_yingpeng2/x_imu1_raw.csv") is False
    assert health.is_legacy_yingpeng("d/2026_9_10_yingpeng/x_imu1_raw.csv") is True
    # 老后缀 + 老日期才算，9-12 起就算还在老目录里也是对的
    assert health.is_legacy_yingpeng("d/2026_9_10_yingpeng2/x.csv") is False


def test_老数据即使本身健康也要标出来(tmp_path):
    """数据可能完全正常（覆盖率 100%），问题在"这个 imu 号是谁的"。
    所以不覆盖 verdict，单独一个字段 + 在原因里说清楚。"""
    p = tmp_path / "2026_9_10_yingpeng"
    p.mkdir()
    rel = f"2026_9_10_yingpeng/{_csv(p, 'a.csv', 14700)}"
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["verdict"] == "ok", "数据本身是好的，不该改判"
    assert r["legacy_imu_numbering"] is True
    assert "位置号" in r["reason"] and "翻译" in r["reason"]


def test_新数据不带这个标记(tmp_path):
    p = tmp_path / "2026_9_14_yingpeng2"
    p.mkdir()
    rel = f"2026_9_14_yingpeng2/{_csv(p, 'a.csv', 14700)}"
    r = health.check_one(str(tmp_path), rel, duration_sec=295, sample_hz=50.0)
    assert r["legacy_imu_numbering"] is False
    assert r["reason"] == ""
