"""每只狗该有几路视角 —— 这是从**文件名里的配对关系**推出来的，不是写死的。

    狗场（_gouchang）  一间一狗一摄像头 + 天花板那路 → 每只狗 2 路
    影棚              三路固定机位，所有狗共用     → 每只狗 3 路

这份测试盯的是「**别把别人房间的画面挂给这只狗**」那一类错：挂错了不报错，
标注员看着一个不认识的房间标半天，而片段本身看起来完全正常。
"""

from __future__ import annotations

import pytest

from app.scripts.report_cam_layout import _site_of, scan_nas


def _touch(d, name):
    (d / name).write_bytes(b"")


@pytest.fixture
def nas(tmp_path):
    root = tmp_path / "data_raw"
    (root / "2026_9_15_gouchang").mkdir(parents=True)
    (root / "2026_9_15_yingpeng").mkdir(parents=True)
    return root


# ── 站点后缀的解析 ────────────────────────────────────────────────────────


def test_site_is_parsed_from_anywhere_in_the_key():
    """真实 session_key 前面还有别的（multicam_...）。

    用 `^` 从头匹配的话一个都对不上，整份报告会说「无站点后缀」——
    第一版就是这么写的。
    """
    assert _site_of("multicam_2026_9_15_gouchang") == "gouchang"
    assert _site_of("multicam_2026_9_15_gouchang_imu9") == "gouchang"
    assert _site_of("2026_9_15_yingpeng") == "yingpeng"


def test_no_site_suffix_is_reported_as_such():
    assert "无站点" in _site_of("multicam_2026_9_15")


# ── 狗场：一间一狗 + 天花板 = 2 路 ────────────────────────────────────────


def _gouchang(nas, imus=(9, 10, 11), ceiling_cam=7):
    d = nas / "2026_9_15_gouchang"
    for i in imus:
        _touch(d, f"multicam_2026_9_15_gouchang_cam{i}_imu{i}_raw.mp4")
        _touch(d, f"multicam_2026_9_15_gouchang_cam{ceiling_cam}_imu{i}_raw.mp4")
    # 天花板那路还留着一份不带 imu 号的原文件
    _touch(d, f"multicam_2026_9_15_gouchang_cam{ceiling_cam}_raw.mp4")
    return d


def test_gouchang_dog_gets_two_views(nas):
    _gouchang(nas)
    g = scan_nas(str(nas))["multicam_2026_9_15_gouchang"]
    assert g["paired_site"] is True
    for imu in (9, 10, 11):
        assert g["per_imu"][imu]["n"] == 2, f"imu{imu} 应该是 2 路"


def test_a_named_file_is_not_shared_when_that_cam_has_pairings(nas):
    """天花板那路既有 `_cam7_raw.mp4` 也有 `_cam7_imuN_raw.mp4`。

    **不能把前者当公用挂给所有狗** —— 那样每只狗除了自己的 2 路之外
    还会多出一路，而且内容跟它自己那路 cam7 是同一个画面。
    """
    _gouchang(nas)
    g = scan_nas(str(nas))["multicam_2026_9_15_gouchang"]
    assert g["shared_cams"] == [], f"不该有公用路，实际 {g['shared_cams']}"
    assert g["unshared_named"] == [7], "cam7 那个不带 imu 号的文件没被正确排除"


def test_a_genuinely_shared_cam_is_added_to_everyone(nas):
    """天花板那路**只有**一份不带 imu 号的文件（清理脚本跑过之后的样子）。

    这时它是真公用，每只狗都该挂上 → 自己 1 路 + 公用 1 路 = 2 路。
    """
    d = nas / "2026_9_15_gouchang"
    for i in (9, 10):
        _touch(d, f"multicam_2026_9_15_gouchang_cam{i}_imu{i}_raw.mp4")
    _touch(d, "multicam_2026_9_15_gouchang_cam7_raw.mp4")
    g = scan_nas(str(nas))["multicam_2026_9_15_gouchang"]
    assert g["shared_cams"] == [7]
    assert g["per_imu"][9]["n"] == 2
    assert g["per_imu"][10]["n"] == 2


# ── 影棚：三路共用 ────────────────────────────────────────────────────────


def test_yingpeng_dog_gets_three_views(nas):
    d = nas / "2026_9_15_yingpeng"
    for c in (1, 2, 3):
        _touch(d, f"multicam_2026_9_15_yingpeng_cam{c}_raw.mp4")
    _touch(d, "multicam_2026_9_15_yingpeng_cam1_imu5_raw.mp4")
    g = scan_nas(str(nas))["multicam_2026_9_15_yingpeng"]
    assert g["paired_site"] is False, "影棚不该走按 IMU 配对那条路"
    assert g["per_imu"][5]["n"] == 3


def test_the_two_sites_coexist_without_mixing(nas):
    """两个场地的数据放在一起时，各按各的规则，**不能互相污染**。

    截图里那个样本三路里有一路是犬舍笼位、另两路是室内地砖——
    看起来就像两个场地的视频混进了同一个任务。
    """
    _gouchang(nas)
    d = nas / "2026_9_15_yingpeng"
    for c in (1, 2, 3):
        _touch(d, f"multicam_2026_9_15_yingpeng_cam{c}_raw.mp4")
    _touch(d, "multicam_2026_9_15_yingpeng_cam1_imu5_raw.mp4")

    info = scan_nas(str(nas))
    assert set(info) == {"multicam_2026_9_15_gouchang", "multicam_2026_9_15_yingpeng"}
    assert info["multicam_2026_9_15_gouchang"]["per_imu"][9]["n"] == 2
    assert info["multicam_2026_9_15_yingpeng"]["per_imu"][5]["n"] == 3
    # 两个 session 的文件不能窜到对方的 per_imu 里
    assert 5 not in info["multicam_2026_9_15_gouchang"]["per_imu"]
    assert 9 not in info["multicam_2026_9_15_yingpeng"]["per_imu"]


# ── 三个位置封顶 ──────────────────────────────────────────────────────────


def test_more_than_three_cams_is_capped(nas):
    """samples 表只有 cam1/cam2/cam3，多出来的挂不上。

    报告里要如实说"会挂 3 路"，不能报 5 —— 那样人会去找剩下两路去哪了。
    """
    d = nas / "2026_9_15_gouchang"
    for c in (1, 2, 3, 4, 5):
        _touch(d, f"multicam_2026_9_15_gouchang_cam{c}_imu9_raw.mp4")
    g = scan_nas(str(nas))["multicam_2026_9_15_gouchang"]
    assert g["per_imu"][9]["own"] == [1, 2, 3, 4, 5]
    assert g["per_imu"][9]["n"] == 3


# ── 前缀过滤 ──────────────────────────────────────────────────────────────


def test_prefix_filter_matches_inside_the_key(nas):
    """真实 session_key 是 multicam_2026_9_15_...，**不以日期打头**。

    用 startswith 过滤的话一个都扫不到，报告会说"没扫到匹配的视频文件"，
    而人会以为是路径配错了。
    """
    _gouchang(nas)
    got = scan_nas(str(nas), "2026_9_15")
    assert got != {}
    # **必须查到 per_imu**：配对文件和公用文件走的是两条分支，
    # 只断言"结果非空"的话，公用那条把结果填上了，而配对那条即使
    # 被 startswith 全过滤掉也看不出来——变异测试里就是这么活下来的
    g = got["multicam_2026_9_15_gouchang"]
    assert set(g["per_imu"]) == {9, 10, 11}, \
        f"配对文件一个都没扫到：{g['per_imu']}"
    assert scan_nas(str(nas), "2026_9_16") == {}
