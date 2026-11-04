"""一只狗两个项圈轮换：项目联动合成一行（IMU1+IMU2），抓挠 / 佩戴只算戴着的那个。"""

from datetime import date, datetime, timedelta

from sqlalchemy import select

from app.models.dog import Dog
from app.models.sample import Sample
from app.models.skin_daily import SkinDailyStat
from app.services import skin_link_service as svc

T0 = datetime(2026, 11, 1, 0, 0)
_FMT = "%Y-%m-%d %H:%M:%S.%f"


def _ai(worn_until_min: int | None, worn_from_min: int | None, scratch_at_min: list[int]):
    """一天 24 小时，每 30 秒一个窗口；戴着时未佩戴概率 0.1，充电座上 0.85"""
    wins = []
    for k in range(24 * 120):
        m = k / 2
        worn = (worn_until_min is not None and m < worn_until_min) or (worn_from_min is not None and m >= worn_from_min)
        wins.append({"ts": (T0 + timedelta(seconds=30 * k)).strftime(_FMT)[:-3],
                     "probs": {"未佩戴": 0.1 if worn else 0.85, "睡觉": 0.9 if worn else 0.15}})
    segs = [{"start_ts": (T0 + timedelta(minutes=m)).strftime(_FMT)[:-3],
             "end_ts": (T0 + timedelta(minutes=m, seconds=20)).strftime(_FMT)[:-3], "conf_mean": 0.9} for m in scratch_at_min]
    return {"mode": "viterbi", "windows": wins, "segments": {"抓挠": segs}}


def test_two_devices_merge_into_one_row(db, run, monkeypatch):
    from app.models.user import User, UserRole

    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    db.add(Dog(dog_code="1", name="bibi", imu="IMU1,IMU2", site="公司影棚"))
    for imu in ("1", "2"):
        db.add(Sample(sample_code=f"yingpeng_20261101_000000_imu{imu}", session_date=date(2026, 11, 1),
                      video_cam1_path="yingpeng/a.mp4", imu_csv_path=f"x/imu{imu}.csv", imu_row_count=100,
                      video_duration_sec=86400, created_by=u.id))
    run(db.commit())
    # 10:00 换项圈：IMU1 戴到 10 点，IMU2 10 点之后戴。IMU1 在充电座上的 15:00 也被误判了一次抓挠
    data = {"x/imu1.csv": _ai(600, None, [100, 900]), "x/imu2.csv": _ai(None, 600, [700])}
    monkeypatch.setattr(svc, "ai_label_relpath", lambda p: p)
    monkeypatch.setattr(svc, "_read_ai_json", lambda p: data[p])
    sent = {}

    async def fake_post(path, payload):
        if path == "stats/from-events":
            sent["rows"] = payload["rows"]
            return {"rows": [{"date": r["date"], "imu": r["imu"], "count": len(r["events"])} for r in payload["rows"]]}
        if path == "stats/to-c-inputs":
            return {}
        return {"total": 10, "tier": "C0", "red_flags": []}

    monkeypatch.setattr(svc, "_algo_post", fake_post)
    res = run(svc.collect_link_stats(db, date(2026, 11, 1), date(2026, 11, 1)))
    assert [r["imu"] for r in res["rows"]] == ["IMU1+IMU2"] and res["rows"][0]["dog_name"] == "bibi"
    row = sent["rows"][0]
    assert row["imu"] == "IMU1+IMU2"
    assert len(row["events"]) == 2                                   # 15:00 那次（充电座上）不算
    assert abs(row["wear_seconds"] - 86400) <= 600                   # 合起来一天，不是 48 小时
    devs = {d["imu"]: d["worn_s"] for d in res["rows"][0]["devices"]}
    assert abs(devs["IMU1"] - 36000) <= 600 and abs(devs["IMU2"] - 50400) <= 600
    stored = run(db.execute(select(SkinDailyStat))).scalars().all()
    assert {s.imu for s in stored} == {"IMU1+IMU2"} and stored[0].devices

    # 每日跟踪表：一只狗一行，带每个设备戴了多久
    from app.services import skin_tracking_service as trk

    async def fake_s(path, payload):
        return {"total": 5, "tier": "S0"}

    monkeypatch.setattr(trk, "_algo_post", fake_s)
    # 那天 bibi 有一份照片，两个人评了级
    from app.models.skin_photo_rating import SkinPhotoRating

    monkeypatch.setattr(trk, "_photo_index", lambda: [("2026-11-01", "bibi", 12, "2026-11-01-ok")])
    db.add(SkinPhotoRating(album="skin", folder="2026-11-01-ok", dog_folder="bibi", user_id=u.id, grade="S1"))
    run(db.commit())
    out = run(trk.daily_tracking(db, date(2026, 11, 1), date(2026, 11, 1)))
    assert [(r["imu"], r["dog_name"]) for r in out["rows"]] == [("IMU1+IMU2", "bibi")]
    row = out["rows"][0]
    assert {d["imu"] for d in row["devices"]} == {"IMU1", "IMU2"}
    assert row["photo_count"] == 12 and row["photo_folder"] == "2026-11-01-ok"
    assert row["photo_grade"] == "S1" and row["photo_ratings"][0]["grade"] == "S1"
    assert trk._consensus([{"grade": "S0"}, {"grade": "S2"}, {"grade": "unsure"}]) == "S2"
