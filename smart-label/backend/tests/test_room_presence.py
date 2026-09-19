"""狗场单间在场时长：按摄像头算、两个 IMU 共用一段视频只算一次、没扫的不算进在场、
天花板公用机位不算、影棚不算。"""

from __future__ import annotations

import json
from datetime import date

from app.models.sample import Sample
from app.models.sample_vision_scan import SampleVisionScan
from app.models.user import User, UserRole
from app.services import room_presence_service as svc


def _sample(db, run, u, code, day_dir, cam_no, imu, shared=True, dur=3600):
    base = f"{day_dir}/multicam_20260917_030015023"
    s = Sample(sample_code=code, session_date=date(2026, 9, 17), created_by=u.id,
               video_cam1_path=f"{base}_cam{cam_no}_imu{imu}_raw.mp4",
               video_cam2_path=f"{base}_cam7_raw.mp4" if shared else None,
               imu_csv_path=f"{base}_imu{imu}.csv", video_duration_sec=dur)
    db.add(s)
    run(db.flush())
    return s


def _scan(db, run, s, cam="cam1", n_dog=None, state="ok", every=5.0, ratio=None, dur=3600):
    tl = json.dumps([[i * every, n] for i, n in enumerate(n_dog)]) if n_dog is not None else None
    db.add(SampleVisionScan(sample_id=s.id, cam=cam, state=state, verdict="has_dog", timeline=tl,
                            every_sec=every, no_dog_ratio=ratio, duration_sec=dur))
    run(db.flush())


def test_room_video_picks_own_cam_not_ceiling():
    s = Sample(sample_code="x_gouchang_imu15", video_cam1_path="d/2026_9_17_gouchang/m_cam4_imu15_raw.mp4",
               video_cam2_path="d/2026_9_17_gouchang/m_cam7_raw.mp4", imu_csv_path="c", created_by=1)
    assert svc.room_video_of(s) == (4, "d/2026_9_17_gouchang/m_cam4_imu15_raw.mp4")
    s2 = Sample(sample_code="studio_imu3", video_cam1_path="d/2026_9_10/multi_cam1.mp4", imu_csv_path="c", created_by=1)
    assert svc.room_video_of(s2) is None


def test_present_seconds_from_timeline_or_ratio():
    assert svc.present_seconds([[0, 1], [5, 0], [10, 2]], 5.0, None, None) == 10.0
    assert svc.present_seconds([], 5.0, 0.25, 100.0) == 75.0
    assert svc.present_seconds([], 5.0, None, 100.0) is None


def test_两个IMU同一段视频只算一次_没扫的不算在场_影棚不算(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    day = "data_raw/2026_9_17_gouchang"
    a = _sample(db, run, u, "20260917_gouchang_imu15", day, 4, 15)
    b = _sample(db, run, u, "20260917_gouchang_imu16", day, 4, 16)     # 同一段画面、另一个项圈
    b.video_cam1_path = a.video_cam1_path
    c = _sample(db, run, u, "20260917_gouchang_imu17", day, 5, 17)     # 5 号单间，没扫
    _sample(db, run, u, "20260910_studio_imu3", "data_raw/2026_9_10", 1, 3, shared=False)  # 影棚
    # 4 号间：720 个点里 600 个有狗 → 3000 秒；imu16 那份扫失败，用 imu15 那份
    _scan(db, run, a, n_dog=[1] * 600 + [0] * 120)
    _scan(db, run, b, state="failed", n_dog=None)
    run(db.commit())

    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    by = {r["cam"]: r for r in rows}
    assert set(by) == {"cam4", "cam5"}
    r4 = by["cam4"]
    assert r4["n_videos"] == 1 and r4["imus"] == ["IMU15", "IMU16"]
    assert r4["recorded_seconds"] == 3600 and r4["present_seconds"] == 3000 and r4["scanned_seconds"] == 3600
    assert r4["n_scanned"] == 1 and r4["n_unscanned"] == 0
    r5 = by["cam5"]
    assert r5["recorded_seconds"] == 3600 and r5["present_seconds"] == 0 and r5["scanned_seconds"] == 0
    assert r5["n_unscanned"] == 1
    assert c.id  # 用到了 c
