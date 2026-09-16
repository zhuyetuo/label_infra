"""每只狗该有几路视角 —— 这是从**文件名里的配对关系**推出来的，不是写死的。

    狗场（_gouchang）  一间一狗一摄像头 + 天花板那路 → 每只狗 2 路
    影棚              三路固定机位，所有狗共用     → 每只狗 3 路

这份测试盯的是「**别把别人房间的画面挂给这只狗**」那一类错：挂错了不报错，
标注员看着一个不认识的房间标半天，而片段本身看起来完全正常。
"""

from __future__ import annotations

import os

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


# ── 真实数据：一间一狗，但不是每场都满员 ──────────────────────────────────
#
# 这一组是照着 NAS 上 2026_9_15_gouchang 的真实文件名建的。
# 狗场每场 7 路：cam1~cam6 是六个房间，cam7 是天花板。
# **但不是每场六只狗都在** —— 16:00 那场 imu17 没上，cam5 那一路就没有配对文件。
#
# 按单场判的话 cam5 会被当成"公用"，于是当场每只狗都多挂一路**空房间**的画面。
# 平台上看起来就是"狗场怎么是 3 路"，而那第二路是一地空地砖。


def _real_gouchang(nas):
    """照抄真实文件名的两场：一场满员、一场少一只狗。"""
    d = nas / "2026_9_15_gouchang"
    # 满员那场：cam1~cam6 各一只狗，cam7 天花板
    full = "multicam_20260915_105410191"
    for cam, imu in ((1, 9), (2, 11), (3, 13), (4, 15), (5, 17), (6, 19)):
        _touch(d, f"{full}_cam{cam}_imu{imu}_raw.mp4")
    _touch(d, f"{full}_cam7_raw.mp4")
    # 少一只狗那场：imu17 没上 → cam5 没有配对文件
    short = "multicam_20260915_160014491"
    for cam, imu in ((1, 9), (2, 11), (3, 13), (4, 15), (6, 19)):
        _touch(d, f"{short}_cam{cam}_imu{imu}_raw.mp4")
    _touch(d, f"{short}_cam5_raw.mp4")     # ← 空房间那一路
    _touch(d, f"{short}_cam7_raw.mp4")
    return full, short


def test_an_idle_room_camera_is_not_treated_as_shared(nas):
    """**这条是那个 bug 本身。**

    cam5 在满员那场是有配对的（imu17），所以它是房间摄像头，
    不是公用 —— 哪怕在少一只狗那场它没有配对文件。
    """
    from app.services.sample_import_service import _scan_filesystem

    _full, short = _real_gouchang(nas)
    groups = _scan_filesystem(str(nas), str(nas))
    g = groups[short]
    # 站点级累计：cam1~cam6 都在今天某一场里配对过
    assert g["site_paired_cams"] >= {1, 2, 3, 4, 5, 6}, \
        f"站点级配对集合不对：{g['site_paired_cams']}"
    assert 7 not in g["site_paired_cams"], "天花板那路不该出现在配对集合里"


def test_every_gouchang_dog_gets_exactly_two_views(nas):
    """满员那场和少一只狗那场，**每只狗都是 2 路**：自己房间 + 天花板。

    改之前少一只狗那场是 3 路，多出来的正是空房间 cam5。
    """
    from app.services.sample_import_service import _scan_filesystem

    full, short = _real_gouchang(nas)
    groups = _scan_filesystem(str(nas), str(nas))
    for key, imus in ((full, (9, 11, 13, 15, 17, 19)), (short, (9, 11, 13, 15, 19))):
        g = groups[key]
        paired = set(g["site_paired_cams"])
        shared = {c for c in (g["shared_videos"] or {}) if c not in paired}
        assert shared == {7}, f"{key} 的公用路应该只有天花板 cam7，实际 {shared}"
        for imu in imus:
            own = set(g["videos_by_imu"].get(imu) or {})
            assert len(own | shared) == 2, \
                f"{key} imu{imu} 应该是 2 路，实际 {sorted(own | shared)}"


def test_the_decision_itself_excludes_the_idle_room(nas):
    """**测真正做决定的那个函数**，不是只测扫描结果。

    第一版只断言 site_paired_cams 的内容，而"把它当成空集、退回按本场算"
    这个变异照样绿——扫描是对的，决定是错的。
    """
    from app.services.sample_import_service import (
        _scan_filesystem,
        genuinely_shared_cams,
    )

    _full, short = _real_gouchang(nas)
    g = _scan_filesystem(str(nas), str(nas))[short]
    shared = genuinely_shared_cams(g)
    assert set(shared) == {7}, \
        f"只有天花板 cam7 该是公用，实际 {sorted(shared)}（多出来的是空房间）"


def test_the_decision_falls_back_per_session_without_site_info(nas):
    """没有站点级信息时退回按本场算——老数据不至于崩，但也确实会多一路。

    钉住这个**退化**行为本身：它是兜底，不是正确结果。
    """
    from app.services.sample_import_service import (
        _scan_filesystem,
        genuinely_shared_cams,
    )

    _full, short = _real_gouchang(nas)
    g = dict(_scan_filesystem(str(nas), str(nas))[short])
    g.pop("site_paired_cams")
    assert set(genuinely_shared_cams(g)) == {5, 7}, \
        "退回本场算时空房间那路会混进来——这正是改之前的行为"


def test_the_idle_room_video_is_not_attached_to_anyone(nas):
    """那一路空房间的视频**谁都不该挂上**。

    它在 shared_videos 里（文件名不带 imu 号），但因为 cam5 在站点级
    配对集合里，所以被排除掉。挂上的话标注员会对着一地空地砖标半天。
    """
    from app.services.sample_import_service import _scan_filesystem

    _full, short = _real_gouchang(nas)
    g = _scan_filesystem(str(nas), str(nas))[short]
    assert 5 in (g["shared_videos"] or {}), "前提变了：cam5 本该是个不带 imu 号的文件"
    assert 5 in g["site_paired_cams"], "cam5 在满员那场配对过，该被认出来"


def test_falling_back_to_per_session_when_site_info_is_missing(nas):
    """老的调用方不带 site_paired_cams 时退回按本场算，别直接崩。"""
    from app.services.sample_import_service import _scan_filesystem

    _full, short = _real_gouchang(nas)
    g = dict(_scan_filesystem(str(nas), str(nas))[short])
    g.pop("site_paired_cams")
    paired = set(g.get("site_paired_cams") or ())
    if not paired:
        paired = {c for cams in g["videos_by_imu"].values() for c in cams}
    assert paired == {1, 2, 3, 4, 6}, f"退回本场算应该是这几路，实际 {paired}"


# ── cams_for_imu：真正决定"挂哪几路"的那一步 ──────────────────────────────


def test_cams_for_imu_gives_two_slots_at_gouchang(nas):
    """狗场每只狗 2 路：自己房间 + 天花板。**空房间那路不该出现。**"""
    from app.services.sample_import_service import (
        _scan_filesystem,
        cams_for_imu,
        genuinely_shared_cams,
    )

    _full, short = _real_gouchang(nas)
    g = _scan_filesystem(str(nas), str(nas))[short]
    shared_cams = {c: g["videos"][c] for c in (1, 2, 3) if c in g["videos"]}
    got = cams_for_imu(g, 9, shared_cams, genuinely_shared_cams(g))
    assert len(got) == 2, f"imu9 应该 2 路，实际 {got}"
    names = [os.path.basename(p) for p in got.values()]
    assert any("cam1_imu9" in n for n in names), f"没挂自己房间：{names}"
    assert any("cam7_raw" in n for n in names), f"没挂天花板：{names}"
    assert not any("cam5" in n for n in names), f"空房间那路混进来了：{names}"


def test_a_non_paired_site_is_untouched(nas):
    """影棚走共用那三路，**行为一个字没变**。

    这次改动只该影响狗场；把影棚也带上的话，之前认出来的样本会莫名其妙变。
    """
    from app.services.sample_import_service import (
        _scan_filesystem,
        cams_for_imu,
        genuinely_shared_cams,
    )

    d = nas / "2026_9_15_yingpeng"
    base = "multicam_20260915_160010613"
    for c, imu in ((1, 1), (2, 2), (3, 3)):
        _touch(d, f"{base}_cam{c}_imu{imu}_raw.mp4")
    g = _scan_filesystem(str(nas), str(nas))[base]
    assert g["paired_site"] is False
    shared_cams = {c: g["videos"][c] for c in (1, 2, 3) if c in g["videos"]}
    for imu in (1, 2, 3):
        assert cams_for_imu(g, imu, shared_cams, genuinely_shared_cams(g)) == shared_cams


def test_cams_for_imu_caps_at_three_slots(nas):
    """samples 表只有 cam1/cam2/cam3。**多出来的必须丢掉，不能返回第 4 个槽位**。

    返回 4 个的话，导入那边 `setattr(sm, _SLOTS[slot-1], ...)` 会 IndexError，
    或者（更糟）修复脚本按 slot 号写进去的时候静默漏掉最后一路。
    这条第一版漏了：真实数据里没有哪只狗超过 3 路，把上限改成 9 也没测出来。
    """
    from app.services.sample_import_service import (
        _scan_filesystem,
        cams_for_imu,
        genuinely_shared_cams,
    )

    d = nas / "2026_9_15_gouchang"
    base = "multicam_20260915_160014491"
    for c in (1, 2, 3, 4, 5):
        _touch(d, f"{base}_cam{c}_imu9_raw.mp4")
    _touch(d, f"{base}_cam7_raw.mp4")
    g = _scan_filesystem(str(nas), str(nas))[base]
    got = cams_for_imu(g, 9, {}, genuinely_shared_cams(g))
    assert set(got) <= {1, 2, 3}, f"槽位超出 1~3：{sorted(got)}"
    assert len(got) == 3
