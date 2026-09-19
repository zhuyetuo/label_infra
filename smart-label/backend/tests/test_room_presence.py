"""狗场单间在场时长：房间和狗都从视频文件名读、同一段视频只算一次（两个 IMU / 错误导入
挂到别的狗名下 / 原始和重采样两份）、没扫的不算在场、天花板公用机位不算、影棚不算。"""

from __future__ import annotations

import json
from datetime import date

from app.models.dog import Dog
from app.models.sample import Sample
from app.models.sample_vision_scan import SampleVisionScan
from app.models.user import User, UserRole
from app.services import room_presence_service as svc

DAY = "data_raw/2026_9_17_gouchang"
BASE = f"{DAY}/multicam_20260917_030015023"


def _sample(db, run, u, code, cam1, cam2=None, cam3=None, dur=3600):
    s = Sample(sample_code=code, session_date=date(2026, 9, 17), created_by=u.id,
               video_cam1_path=cam1, video_cam2_path=cam2, video_cam3_path=cam3,
               imu_csv_path=f"{BASE}_x.csv", video_duration_sec=dur)
    db.add(s)
    run(db.flush())
    return s


def _scan(db, run, s, cam="cam1", n_dog=None, state="ok", every=5.0, dur=3600):
    tl = json.dumps([[i * every, n] for i, n in enumerate(n_dog)]) if n_dog is not None else None
    db.add(SampleVisionScan(sample_id=s.id, cam=cam, state=state, verdict="has_dog", timeline=tl,
                            every_sec=every, duration_sec=dur))
    run(db.flush())


def test_parse_room_video():
    assert svc.parse_room_video("d/multicam_20260917_030015023_cam4_imu15_raw.mp4") == (4, 15, "20260917_030015023_cam4")
    assert svc.parse_room_video("d/multicam_20260917_030015023_cam4_imu15_resampled16hz.mp4") == (4, 15, "20260917_030015023_cam4")
    assert svc.parse_room_video("d/multicam_20260917_030015023_cam7_raw.mp4") is None      # 天花板
    assert svc.parse_room_video("d/multi_cam1.mp4") is None


def test_present_seconds_from_timeline_or_ratio():
    assert svc.present_seconds([[0, 1], [5, 0], [10, 2]], 5.0, None, None) == 10.0
    assert svc.present_seconds([], 5.0, 0.25, 100.0) == 75.0
    assert svc.present_seconds([], 5.0, None, 100.0) is None


def test_按文件名归房间_去重_没扫不算在场_影棚不算(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    db.add(Dog(dog_code="wangcai", name="旺财", imu="IMU15,IMU16"))
    db.add(Dog(dog_code="dajinmao", name="大金毛", imu="IMU17,IMU18"))
    run(db.flush())
    v4 = f"{BASE}_cam4_imu15_raw.mp4"
    v5 = f"{BASE}_cam5_imu17_raw.mp4"
    ceiling = f"{BASE}_cam7_raw.mp4"
    a = _sample(db, run, u, "20260917_gouchang_imu15", v4, ceiling)                   # 旺财当班项圈
    b = _sample(db, run, u, "20260917_gouchang_imu16", v4, ceiling)                   # 轮换的另一个，同一段画面
    # 错误导入的老样本：把所有房间的画面都挂到了 17 号狗名下，还带一份重采样的重复文件
    c = _sample(db, run, u, "20260917_gouchang_imu17", v5, v4, f"{BASE}_cam5_imu17_resampled16hz.mp4")
    _sample(db, run, u, "20260910_studio_imu3", "data_raw/2026_9_10/multi_cam1.mp4")   # 影棚
    _scan(db, run, a, n_dog=[1] * 600 + [0] * 120)      # 4 号间：3000 秒有狗
    _scan(db, run, b, state="failed")
    _scan(db, run, c, cam="cam2", n_dog=[1] * 720)       # c 上挂的 cam4 画面也扫过：不能算第二次
    run(db.commit())

    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    by = {r["cam"]: r for r in rows}
    assert set(by) == {"cam4", "cam5"}
    r4 = by["cam4"]
    assert r4["dog_name"] == "旺财" and r4["imus"] == ["IMU15"]        # 狗按文件名，不按样本
    assert r4["n_videos"] == 1 and r4["recorded_seconds"] == 3600 and r4["present_seconds"] == 3000
    assert r4["n_scanned"] == 1 and r4["n_unscanned"] == 0 and not r4["over_day"]
    vid = r4["videos"][0]
    assert vid["sample_id"] == a.id and vid["start"] == "03:00:15" and vid["scanned"]
    assert vid["also_on"] == ["20260917_gouchang_imu16", "20260917_gouchang_imu17"]
    r5 = by["cam5"]
    assert r5["dog_name"] == "大金毛" and r5["n_videos"] == 1              # 原始 + 重采样 = 一段
    assert r5["recorded_seconds"] == 3600 and r5["present_seconds"] == 0 and r5["n_unscanned"] == 1
