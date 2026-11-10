"""单张照片拍摄不合格标记：标 / 改 / 取消，原因校验"""
import pytest
from fastapi import HTTPException

from app.api.v1 import material as api
from tests.test_segment_review import _world


def test_flag_标改取消(db, run):
    w = _world(db, run)
    key = dict(folder="博朗旺-狗场合作/博朗旺20261109", dog_folder="001东德牧羊犬奥迪", filename="a (4).jpg")
    run(api.put_flag("skin", api.FlagIn(**key, reason="blurry"), db, w.ann))
    run(api.put_flag("skin", api.FlagIn(**key, reason="dark", note="屋里没开灯"), db, w.rev))
    got = run(api.list_flags("skin", db, w.ann))["data"]
    assert len(got["flags"]) == 1
    f = got["flags"][0]
    assert f["reason"] == "dark" and f["note"] == "屋里没开灯" and f["user_name"] == "审核员"
    assert "blurry" in got["reasons"]
    run(api.put_flag("skin", api.FlagIn(**key, reason=None), db, w.ann))
    assert run(api.list_flags("skin", db, w.ann))["data"]["flags"] == []
    with pytest.raises(HTTPException):
        run(api.put_flag("skin", api.FlagIn(**key, reason="乱写"), db, w.ann))


def test_看图评级算进人力和标注统计(db, run):
    from datetime import date

    from app.services import annotator_work_service as aws
    from app.services import workforce_service as wf
    w = _world(db, run)
    for i in range(3):
        run(api.put_rating("skin", api.RatingIn(folder="博朗旺20261109", dog_folder=f"00{i}狗", grade="S1"), db, w.ann))
    run(api.put_flag("skin", api.FlagIn(folder="博朗旺20261109", dog_folder="000狗", filename="a (1).jpg", reason="blurry"), db, w.ann))
    from app.models.skin_photo_rating import SkinPhotoRating
    from sqlalchemy import select
    day = run(db.execute(select(SkinPhotoRating.created_at))).scalars().first().date()
    eff = run(wf.efficiency(db, day, day))
    me = next(u for u in eff if u["user_id"] == w.ann.id)
    d = me["days"][0]
    assert d["photo_ratings"] == 3 and d["photo_flags"] == 1
    assert any(p["project"] == wf.PHOTO_PROJECT and p["photo_ratings"] == 3 for p in d["projects"])
    work = run(aws.annotator_work(db, day, day, w.ann.id))
    assert len(work["photo_ratings"]) == 3 and work["photo_ratings"][0]["grade"] == "S1"
