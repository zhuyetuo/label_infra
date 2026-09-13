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
