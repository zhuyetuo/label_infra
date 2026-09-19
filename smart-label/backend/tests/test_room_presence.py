"""狗场单间在场时长：房间和狗都从视频文件名读、同一段视频只算一次（两个 IMU / 错误导入
挂到别的狗名下 / 原始和重采样两份）、没扫的不算在场、天花板公用机位不算、影棚不算。"""

from __future__ import annotations

import asyncio
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
    assert set(by) == {"cam4", "cam5", "cam7"}
    assert by["cam7"]["shared"] and by["cam7"]["n_videos"] == 1 and by["cam7"]["n_unscanned"] == 1
    r4 = by["cam4"]
    assert r4["dog_name"] == "旺财" and r4["imus"] == ["IMU15"]        # 狗按文件名，不按样本
    assert r4["shared_cams"] == ["cam7"] and r4["present_shared_extra_seconds"] == 0
    assert r4["n_videos"] == 1 and r4["recorded_seconds"] == 3600 and r4["present_seconds"] == 3000
    assert r4["n_scanned"] == 1 and r4["n_unscanned"] == 0 and not r4["over_day"]
    vid = r4["videos"][0]
    assert vid["sample_id"] == a.id and vid["start"] == "03:00:15" and vid["scanned"]
    assert vid["also_on"] == ["20260917_gouchang_imu16", "20260917_gouchang_imu17"]
    r5 = by["cam5"]
    assert r5["dog_name"] == "大金毛" and r5["n_videos"] == 1              # 原始 + 重采样 = 一段
    assert r5["recorded_seconds"] == 3600 and r5["present_seconds"] == 0 and r5["n_unscanned"] == 1


def test_补扫_只扫没扫的_每段一次_进度能看(db, run, monkeypatch):
    u = User(username="b", password_hash="x", display_name="b", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    v4 = f"{BASE}_cam4_imu15_raw.mp4"
    v5 = f"{BASE}_cam5_imu17_raw.mp4"
    a = _sample(db, run, u, "20260917_gouchang_imu15", v4)
    _sample(db, run, u, "20260917_gouchang_imu16", v4)               # 同一段画面：不扫第二次
    c = _sample(db, run, u, "20260917_gouchang_imu17", v5)
    _scan(db, run, a, n_dog=[1] * 720)                                # 4 号间扫过了
    run(db.commit())

    class Ctx:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(svc, "SessionLocal", lambda: Ctx())
    calls = []

    async def fake_scan(path, every_sec=5.0, conf=0.35):
        calls.append(path)
        return {"verdict": "has_dog", "no_dog_ratio": 0.0, "max_dogs": 1, "sampled": 2, "frames_with_dog": 2,
                "duration_sec": 3600, "frames": [{"t": 0, "n_dogs": 1}, {"t": 5, "n_dogs": 1}], "every_sec": 5.0, "conf": conf}

    async def fake_status():
        return {"available": True, "weights": "yolo26x.pt"}

    monkeypatch.setattr(svc.vc, "scan_dog", fake_scan)
    monkeypatch.setattr(svc.vc, "dog_status", fake_status)

    async def go():
        r = await svc.start_scan(date(2026, 9, 1), date(2026, 9, 30))
        assert r["started"] and r["total"] == 1
        for _ in range(50):
            await asyncio.sleep(0.01)
            if svc.scan_status()["status"] == "done":
                break
        return svc.scan_status()

    import asyncio
    st = asyncio.run(go())
    assert st["status"] == "done" and st["done"] == 1 and st["failed"] == 0 and calls == [v5]
    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    r5 = next(r for r in rows if r["cam"] == "cam5")
    assert r5["n_scanned"] == 1 and r5["present_seconds"] == 10 and r5["videos"][0]["sample_id"] == c.id
    # 没有要扫的了
    assert asyncio.run(svc.start_scan(date(2026, 9, 1), date(2026, 9, 30)))["total"] == 0


def test_并行扫_暂停_取消(db, run, monkeypatch):
    """4 段并行扫；中途暂停就不再取下一段；取消后剩下的不扫、已扫的留着。"""
    u = User(username="c", password_hash="x", display_name="c", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    samples = []
    for i, cam in enumerate((1, 2, 3, 4, 5, 6)):
        samples.append(_sample(db, run, u, f"20260917_gouchang_imu{10 + i}", f"{BASE}_cam{cam}_imu{10 + i}_raw.mp4"))
    run(db.commit())

    class Ctx:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(svc, "SessionLocal", lambda: Ctx())
    monkeypatch.setattr(svc, "CONCURRENCY", 2)
    inflight = {"now": 0, "peak": 0}
    gate = asyncio.Event()

    async def fake_scan(path, every_sec=5.0, conf=0.35):
        inflight["now"] += 1
        inflight["peak"] = max(inflight["peak"], inflight["now"])
        await gate.wait()
        inflight["now"] -= 1
        return {"verdict": "has_dog", "no_dog_ratio": 0.0, "max_dogs": 1, "sampled": 1, "frames_with_dog": 1,
                "duration_sec": 3600, "frames": [{"t": 0, "n_dogs": 1, "boxes": [{"bbox": [0.1, 0.2, 0.3, 0.4], "conf": 0.9}]}],
                "every_sec": 5.0, "conf": conf}

    async def fake_status():
        return {"available": True, "weights": "w"}

    monkeypatch.setattr(svc.vc, "scan_dog", fake_scan)
    monkeypatch.setattr(svc.vc, "dog_status", fake_status)

    async def go():
        r = await svc.start_scan(date(2026, 9, 1), date(2026, 9, 30))
        assert r["started"] and r["total"] == 6
        await asyncio.sleep(0.02)
        st = svc.scan_status()
        assert st["status"] == "running" and inflight["peak"] == 2 and len(st["current"]) == 2
        assert (await svc.start_scan(date(2026, 9, 1), date(2026, 9, 30)))["already_running"]
        svc.pause_scan()
        gate.set()                              # 正在扫的两段扫完
        await asyncio.sleep(0.02)
        st = svc.scan_status()
        assert st["status"] == "paused" and st["done"] == 2 and inflight["now"] == 0
        gate.clear()
        svc.resume_scan()
        await asyncio.sleep(0.02)
        assert inflight["now"] == 2             # 又取了两段
        svc.cancel_scan()
        gate.set()
        await asyncio.sleep(0.05)
        return svc.scan_status()

    st = asyncio.run(go())
    assert st["status"] == "cancelled" and st["done"] == 4 and st["failed"] == 0
    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    assert sum(r["n_scanned"] for r in rows) == 4 and sum(r["n_unscanned"] for r in rows) == 2
    # 框存下来了
    from app.models.sample_vision_scan import SampleVisionScan as S
    from sqlalchemy import select as sel
    tl = run(db.execute(sel(S.timeline).where(S.state == "ok"))).scalars().first()
    assert json.loads(tl) == [[0, 1, [[0.1, 0.2, 0.3, 0.4, 0.9]]]]
    # 单段扫
    left = next(v for r in rows for v in r["videos"] if not v["scanned"])
    out = asyncio.run(svc.scan_one(db, left["sample_id"], left["slot"]))
    assert out["verdict"] == "has_dog"
    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    assert sum(r["n_unscanned"] for r in rows) == 1


def test_公共区补死角_按区域归房间_取并集(db, run):
    from app.models.cam_region import CamRegion
    u = User(username="d", password_hash="x", display_name="d", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    v4 = f"{BASE}_cam4_imu15_raw.mp4"
    ceiling = f"{BASE}_cam7_raw.mp4"
    a = _sample(db, run, u, "20260917_gouchang_imu15", v4, ceiling)
    # 单间机位：前 10 个点有狗（0~50s），后面没有
    _scan(db, run, a, n_dog=[1] * 10 + [0] * 710)
    # 公共区：同一时刻起录；第 8~20 个点有一只狗在 4 号间的区域里，第 30 个点有狗在别的区域
    pts = []
    for i in range(720):
        if 8 <= i < 20:
            pts.append([i * 5.0, 1, [[0.1, 0.1, 0.1, 0.1, 0.9]]])
        elif i == 30:
            pts.append([i * 5.0, 1, [[0.8, 0.8, 0.1, 0.1, 0.9]]])
        else:
            pts.append([i * 5.0, 0])
    db.add(SampleVisionScan(sample_id=a.id, cam="cam2", state="ok", verdict="has_dog", timeline=json.dumps(pts),
                            every_sec=5.0, duration_sec=3600))
    run(db.commit())

    # 还没划区域：cam7 不参与，只提示
    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    r4 = next(r for r in rows if r["cam"] == "cam4")
    assert r4["present_seconds"] == 50 and r4["regions_missing"] and r4["present_shared_extra_seconds"] == 0
    r7 = next(r for r in rows if r["cam"] == "cam7")
    assert r7["shared"] and r7["n_scanned"] == 1 and r7["present_own_seconds"] == 13 * 5

    # 划了区域：4 号间在画面左上角 → 8~20 个点补进来，30 那个点不算（在别的区域）
    db.add(CamRegion(site="gouchang", cam=7, room=4, x=0.0, y=0.0, w=0.5, h=0.5))
    run(db.commit())
    rows = run(svc.rooms(db, date(2026, 9, 1), date(2026, 9, 30)))
    r4 = next(r for r in rows if r["cam"] == "cam4")
    assert not r4["regions_missing"]
    assert r4["present_own_seconds"] == 50                  # 自己机位：0~9
    assert r4["present_shared_extra_seconds"] == 10 * 5     # cam7 补的：10~19（8、9 跟自己重叠不重复算）
    assert r4["present_seconds"] == 20 * 5                  # 并集 0~19
    assert svc.in_region([0.1, 0.1, 0.1, 0.1, 0.9], (0, 0, 0.5, 0.5)) and not svc.in_region([0.8, 0.8, 0.1, 0.1], (0, 0, 0.5, 0.5))


def test_预览时间线_按视频文件找扫描结果_公共区带区域(db, run):
    from app.api.v1.samples import vision_scan_timeline
    from app.models.cam_region import CamRegion
    u = User(username="e", password_hash="x", display_name="e", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    v6 = f"{BASE}_cam6_imu19_raw.mp4"
    ceiling = f"{BASE}_cam7_raw.mp4"
    a = _sample(db, run, u, "20260917_gouchang_imu19", v6, ceiling)
    b = _sample(db, run, u, "20260917_gouchang_imu20", v6, ceiling)     # 轮换项圈：同样两段画面
    _scan(db, run, a, cam="cam2", n_dog=[1, 0])                          # cam7 只在 a 上扫过
    db.add(CamRegion(site="gouchang", cam=7, room=6, x=0.7, y=0.5, w=0.2, h=0.3))
    run(db.commit())
    out = run(vision_scan_timeline(b.id, db=db))["data"]
    assert "cam1" not in out                                            # 单间那段谁都没扫
    assert out["cam2"]["scanned_on"] == a.id and out["cam2"]["points"][0][1] == 1
    assert out["cam2"]["regions"] == [{"label": "6 号", "x": 0.7, "y": 0.5, "w": 0.2, "h": 0.3}]
