"""工作台标题上「换狗」：老数据当时 IMU 戴在哪只狗身上要看画面才知道，同一天同一个 IMU 一起改。"""
from datetime import date

from app.api.v1 import samples as api
from app.models.dog import Dog
from app.models.sample import Sample
from app.models.user import User, UserRole


def _setup(db, run):
    u = User(username="boss", password_hash="x", display_name="管理员", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    dogs = [Dog(dog_code="1", name="bibi", imu="IMU1", site="公司影棚"), Dog(dog_code="2", name="巴利", imu="IMU4", site="公司影棚")]
    for x in dogs:
        db.add(x)
    d = date(2026, 8, 16)
    ss = [Sample(sample_code=f"yingpeng_20260816_{h}_imu4", session_date=d, video_cam1_path=f"yingpeng/20260816/{h}.mp4",
                 imu_csv_path="a.csv", created_by=u.id) for h in (12, 13)]
    ss.append(Sample(sample_code="yingpeng_20260816_12_imu1", session_date=d, video_cam1_path="yingpeng/x.mp4", imu_csv_path="b.csv", created_by=u.id))
    ss.append(Sample(sample_code="yingpeng_20260817_12_imu4", session_date=date(2026, 8, 17), video_cam1_path="yingpeng/y.mp4", imu_csv_path="c.csv", created_by=u.id))
    for x in ss:
        db.add(x)
    run(db.commit())
    return dogs, ss


def test_same_day_same_imu_changed_together(db, run, monkeypatch):
    async def _empty():
        return {}
    monkeypatch.setattr(api.dog_name_service, "imu_dog_map", _empty)
    monkeypatch.setattr(api.dog_name_service, "site_imu_dog_map", _empty)
    dogs, ss = _setup(db, run)
    r = run(api.pick_dog(ss[0].id, api.SampleDogPick(dog_id=dogs[0].id), db))["data"]
    assert r["updated"] == 2 and r["dog_label"] == "bibi（IMU4）"
    for s in ss:
        run(db.refresh(s))
    assert [s.dog_id for s in ss] == [dogs[0].id, dogs[0].id, None, None]   # 别的 IMU、别的日子不动
    r = run(api.pick_dog(ss[1].id, api.SampleDogPick(dog_id=None, same_day=False), db))["data"]
    assert r["updated"] == 1 and r["dog_label"] == "IMU4"                     # 清掉 = 回到按设备号猜
