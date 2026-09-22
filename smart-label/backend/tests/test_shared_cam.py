"""把「看全场的那一路」补挂给同一天别的采集机录的样本。

要守住的：偏移的方向和大小要对（错了那一路上每条标注都差几秒，而且看不出来）；
不是同一场的不能挂；已经有公共区的不重复挂。
"""

from __future__ import annotations

from datetime import date

from app.models.sample import Sample
from app.models.user import User, UserRole
from app.services import shared_cam_service as svc


def test_开机时刻从文件名里读():
    assert svc.session_start_ms("d/2026_9_20_gouchang/multicam_20260920_000016301_cam1_imu14_raw.mp4") == 16301
    assert svc.session_start_ms("multicam_20260920_120012130_cam7_imu20_raw.mp4") == 12 * 3600_000 + 12130
    # 认不出来就 None，不猜——猜错了会挂上一场的画面
    assert svc.session_start_ms("随便一个名字.mp4") is None


def _mk(db, run, u, code, start, cam, imu, day="d/2026_9_20_gouchang", dur=3600):
    s = Sample(sample_code=code,
               video_cam1_path=f"{day}/multicam_20260920_{start}_cam{cam}_imu{imu}_raw.mp4",
               imu_csv_path=f"{day}/{code}.csv", session_date=date(2026, 9, 20),
               video_duration_sec=dur, created_by=u.id)
    db.add(s)
    return s


def test_补挂公共区_偏移方向和大小_不是同一场的不挂(db, run):
    u = User(username="sc", password_hash="x", display_name="sc", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    # 1 号机 00:00:16.301，只有单间那一路（imu14 → 3 号房，cam3）
    a = _mk(db, run, u, "s_imu14", "000016301", 3, 14)
    # 2 号机 00:00:12.130，单间 + 公共区
    b = _mk(db, run, u, "s_imu20", "000012130", 6, 20)
    b.video_cam2_path = "d/2026_9_20_gouchang/multicam_20260920_000012130_cam7_imu20_raw.mp4"
    # 隔壁场次：13:30 起，跟 00:00 那一场完全不重叠，不能拿它的公共区来挂
    c = _mk(db, run, u, "s_imu13_late", "013000000", 3, 13)
    run(db.commit())

    p = run(svc.plan(db))
    got = {i["sample_code"]: i for i in p["items"]}
    assert set(got) == {"s_imu14"}, p
    it = got["s_imu14"]
    # 公共区那一路比这份样本**早开** 4.171 秒 → 它的第 0 秒落在样本的 -4171ms
    assert it["offset_ms"] == 12130 - 16301 == -4171
    # 两台机器录的是同一段时间，重叠接近满
    assert it["coverage"] > 0.99
    assert it["slot"] == "cam2" and it["path"].endswith("_cam7_imu20_raw.mp4")
    # 已经有公共区的那份不重复挂；隔壁场次的如实说为什么没挂
    assert p["skipped"].get("已经有公共区那一路") == 1
    assert p["skipped"].get("最接近的那一路只盖住 0%，不像同一场") == 1
    assert c.video_cam2_path is None

    r = run(svc.apply(db))
    assert r["attached"] == 1
    run(db.refresh(a))
    assert a.video_cam2_path.endswith("_cam7_imu20_raw.mp4")
    # **偏移必须跟着挂上去**：只挂路径不记偏移，那一路的每条标注都差 4 秒
    assert a.video_offsets_ms == {"cam2": -4171}
    # 再跑一遍不会重复挂（这时它已经有公共区了）
    assert run(svc.plan(db))["items"] == []


def test_按盖没盖住挑_不是按开得近挑(db, run):
    """实测（2026-09-22）：两台机器是人手动开的，同一场能差 5~8 分钟，而隔壁场次
    可能差得更小——「开得近」根本分不出是不是同一场。

    真正要问的是「这一路盖住了这份样本的多少时间」：同一场重叠接近满，
    隔壁场次几乎不重叠。挂错场次的后果是人看到画面里那只狗在干别的，
    而根本想不到是挂错了场。
    """
    u = User(username="sc2", password_hash="x", display_name="sc2", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    # 这份样本 15:00:00 起，录 1 小时
    a = _mk(db, run, u, "s_late", "150000000", 3, 14)
    # 公共区 A：14:55 起录 1 小时 —— 开得早 5 分钟，但盖住了 91%
    b = _mk(db, run, u, "s_pub_ok", "145500000", 6, 20)
    b.video_cam2_path = "d/2026_9_20_gouchang/multicam_20260920_145500000_cam7_imu20_raw.mp4"
    # 公共区 B：15:02 起但只录了 3 分钟 —— **开得更近**，却几乎盖不住
    c = _mk(db, run, u, "s_pub_short", "150200000", 5, 19, dur=180)
    c.video_cam2_path = "d/2026_9_20_gouchang/multicam_20260920_150200000_cam7_imu19_raw.mp4"
    run(db.commit())

    items = {i["sample_code"]: i for i in run(svc.plan(db))["items"]}
    it = items["s_late"]
    # 按「开得近」会挑到只录 3 分钟的那一路（差 2 分钟 < 5 分钟）；按覆盖挑才对
    assert it["path"].endswith("_145500000_cam7_imu20_raw.mp4")
    assert it["offset_ms"] == -300_000 and 0.9 < it["coverage"] < 0.93
