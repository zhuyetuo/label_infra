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


def _mk(db, u, imu, cam, *, code=None, extra=None):
    s = Sample(
        sample_code=code or f"{SESSION}_imu{imu}",
        video_cam1_path=f"{DAY}/{SESSION}_cam{cam}_imu{imu}_raw.mp4",
        imu_csv_path=f"{DAY}/{SESSION}_cam{cam}_imu{imu}_raw.csv",
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
