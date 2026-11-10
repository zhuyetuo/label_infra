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
