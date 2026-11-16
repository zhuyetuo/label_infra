"""机位核对：摄像头重插后，人看画面把「文件里的 camN」改回真实房间。

要守住的：改完这一场每只狗都拿到**正确房间**的画面；自动扫描不能把它盖回去；
分类（own/public）跟着人工结果走，而不是继续信文件名。
"""

from __future__ import annotations

from datetime import date

import pytest

from app.models.sample import Sample
from app.models.user import User, UserRole
from app.services import cam_map_service as svc
from app.services import site_layout


DAY = "data_raw/2026_9_20_gouchang"
SESSION = "multicam_20260920_000016301"
# 同一天的另外两场：博朗旺一场、影棚一场
SESSION_BLW = "multicam_20260920_010016301"
SESSION_YP = "multicam_20260920_020016301"
DAY_BLW = "data_raw/2026_9_20_bolangwang"
DAY_YP = "data_raw/2026_9_20_yingpeng"


def _mk(db, u, imu, cam, *, code=None, extra=None, day=DAY, session=SESSION):
    s = Sample(
        sample_code=code or f"{session}_imu{imu}",
        video_cam1_path=f"{day}/{session}_cam{cam}_imu{imu}_raw.mp4",
        imu_csv_path=f"{day}/{session}_cam{cam}_imu{imu}_raw.csv",
        session_date=date(2026, 9, 20),
        created_by=u.id,
    )
    for slot, path in (extra or {}).items():
        setattr(s, f"video_{slot}_path", path)
    db.add(s)
    return s


@pytest.fixture()
def setup(db, run):
    u = User(username="cm", password_hash="x", display_name="cm", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    # 狗场 1 号机那三间：imu9→1 号间，imu11→2 号间，imu13→3 号间。
    # 文件名按「录制机位」写，现在摄像头插反了：cam1 实际拍 2 号间，cam2 实际拍 1 号间
    a = _mk(db, u, 9, 1)
    b = _mk(db, u, 11, 2)
    c = _mk(db, u, 13, 3)
    run(db.commit())
    return u, a, b, c


def test_场次号从样本编号里去掉imu后缀():
    assert svc.session_key_of(f"{SESSION}_imu9") == SESSION
    assert svc.session_key_of(SESSION) == SESSION


def test_列出这一场的机位和当前对照(db, run, setup):
    _u, *_ = setup
    out = run(svc.list_sessions(db, "2026-09-20"))
    assert out["sessions"], out
    sess = out["sessions"][0]
    assert sess["session_key"] == SESSION
    assert sess["site"] == "gouchang"
    assert not sess["corrected"]
    assert {c["recorded_cam"]: c["real_cam"] for c in sess["cams"]} == {1: 1, 2: 2, 3: 3}
    assert {s["imu"]: s["room"] for s in sess["samples"]} == {9: 1, 11: 2, 13: 3}
    # 界面上要能选「1~6 号单间 + 天花板」
    assert {r["value"] for r in sess["rooms"]} == {1, 2, 3, 4, 5, 6, 7}


def test_把两路摄像头对调后每只狗拿到自己房间的画面(db, run, setup):
    _u, a, b, c = setup
    res = run(svc.save_mapping(db, SESSION, {"1": 2, "2": 1, "3": 3}, None))
    assert res["updated"] == 3
    assert res["missing_rooms"] == []

    # imu9 住 1 号间；1 号间的画面录在 cam2 那个文件里
    assert a.video_cam1_path.endswith("_cam2_imu11_raw.mp4")
    assert a.video_cams == {"cam1": 1}
    assert b.video_cam1_path.endswith("_cam1_imu9_raw.mp4")
    assert b.video_cams == {"cam1": 2}
    # 没动的那一路还是自己的
    assert c.video_cam1_path.endswith("_cam3_imu13_raw.mp4")

    # 分类要按人工结果：imu9 的 cam1 槽位是「自己那间」，不是别人的
    assert site_layout.classify(a.video_cam1_path, a.sample_code, DAY,
                                real_cam=a.video_cams["cam1"]) == "own"
    assert site_layout.classify(b.video_cam1_path, b.sample_code, DAY,
                                real_cam=b.video_cams["cam1"]) == "own"


def test_天花板那一路照旧挂上(db, run, setup):
    _u, a, _b, _c = setup
    # 本场有天花板那一路（录在 cam7）
    a.video_cam2_path = f"{DAY}/{SESSION}_cam7_raw.mp4"
    run(db.commit())
    run(svc.save_mapping(db, SESSION, {"1": 2, "2": 1, "3": 3}, None))
    assert a.video_cams == {"cam1": 1, "cam2": 7}
    assert a.video_cam2_path.endswith("_cam7_raw.mp4")
    assert site_layout.classify(a.video_cam2_path, a.sample_code, DAY,
                                real_cam=7) == "public"


def test_两路摄像头不能对应同一个房间(db, run, setup):
    with pytest.raises(ValueError, match="同一个房间"):
        run(svc.save_mapping(db, SESSION, {"1": 2, "2": 2, "3": 3}, None))


def test_不属于这个场地的机位号不接受(db, run, setup):
    with pytest.raises(ValueError, match="不属于这个场地"):
        run(svc.save_mapping(db, SESSION, {"1": 9, "2": 2, "3": 3}, None))


def test_恢复默认后按文件名算回去(db, run, setup):
    _u, a, b, _c = setup
    run(svc.save_mapping(db, SESSION, {"1": 2, "2": 1, "3": 3}, None))
    run(svc.reset_mapping(db, SESSION))
    assert a.video_cam1_path.endswith("_cam1_imu9_raw.mp4")
    assert b.video_cam1_path.endswith("_cam2_imu11_raw.mp4")
    assert a.video_cams is None and b.video_cams is None

    out = run(svc.list_sessions(db, "2026-09-20"))
    assert not out["sessions"][0]["corrected"]


def test_影棚全是公共区不出现(db, run, setup):
    _u, *_ = setup
    _mk(db, _u, 1, 1, day=DAY_YP, session=SESSION_YP)
    run(db.commit())
    out = run(svc.list_sessions(db, "2026-09-20"))
    assert out["sessions"], out
    assert all(s["site"] != "yingpeng" for s in out["sessions"])
    # 场地下拉里也没有影棚
    assert {s["key"] for s in out["sites"]} == {"gouchang", "bolangwang"}


def test_按场地筛只看选中的场地(db, run, setup):
    _u, *_ = setup
    _mk(db, _u, 9, 1, day=DAY_BLW, session=SESSION_BLW)
    run(db.commit())
    out = run(svc.list_sessions(db, "2026-09-20", site="bolangwang"))
    assert out["sessions"] and all(s["site"] == "bolangwang" for s in out["sessions"])
    # 不筛时两个场地都在
    out_all = run(svc.list_sessions(db, "2026-09-20"))
    assert {s["site"] for s in out_all["sessions"]} == {"gouchang", "bolangwang"}


def test_只有影棚数据的日期不进日期列表(db, run, setup):
    _u, *_ = setup
    s = _mk(db, _u, 1, 1, day="data_raw/2026_9_21_yingpeng", session=SESSION_YP)
    s.session_date = date(2026, 9, 21)
    run(db.commit())
    out = run(svc.list_sessions(db, None))
    assert out["date"] == "2026-09-20"
    assert "2026-09-21" not in out["dates"]


def test_拿影棚当筛选条件直接拒绝(db, run, setup):
    with pytest.raises(ValueError, match="公共区"):
        run(svc.list_sessions(db, "2026-09-20", site="yingpeng"))


def test_批量把一套对照应用到一天多场(db, run, setup):
    _u, a, *_ = setup
    _mk(db, _u, 9, 1, session=SESSION_BLW)
    _mk(db, _u, 11, 2, session=SESSION_BLW)
    run(db.commit())
    res = run(svc.save_batch(db, "2026-09-20", {"1": 2, "2": 1, "3": 3}, [SESSION, SESSION_BLW], None))
    assert res["updated"] == 5
    assert res["failed"] == []
    assert [r["session_key"] for r in res["results"]] == [SESSION, SESSION_BLW]

    # 第一场照旧按人工结果挂
    run(db.refresh(a))
    assert a.video_cam1_path.endswith("_cam2_imu11_raw.mp4")
    assert a.video_cams == {"cam1": 1}
    # 第二场也一起改了：imu9 住 1 号间，1 号间的画面在 cam2 文件里
    out = run(svc.list_sessions(db, "2026-09-20"))
    assert all(s["corrected"] for s in out["sessions"])
    sess_b = next(s for s in out["sessions"] if s["session_key"] == SESSION_BLW)
    assert {c["recorded_cam"]: c["real_cam"] for c in sess_b["cams"]} == {1: 2, 2: 1}


def test_批量某场校验不过其他场照常改(db, run, setup):
    _u, a, *_ = setup
    # 博朗旺一场：它没有公共区，mapping 里 cam1→7 对它是非法的；
    # 狗场那一场 7 = 天花板，合法
    _mk(db, _u, 9, 1, day=DAY_BLW, session=SESSION_BLW)
    run(db.commit())
    res = run(svc.save_batch(db, "2026-09-20", {"1": 7, "2": 2, "3": 3}, [SESSION, SESSION_BLW], None))
    assert [f["session_key"] for f in res["failed"]] == [SESSION_BLW]
    assert [r["session_key"] for r in res["results"]] == [SESSION]
    run(db.refresh(a))
    assert a.video_cams == {"cam1": 7}


def test_批量一个都没选中的场会拒绝(db, run, setup):
    with pytest.raises(ValueError, match="没有可核对"):
        run(svc.save_batch(db, "2026-09-20", {"1": 2}, ["multicam_20260920_999999999"], None))
