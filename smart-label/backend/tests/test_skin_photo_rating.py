"""皮肤照片评级：每人各评各的、能改能撤销、档位校验；口腔相册标注员看不了。"""

import pytest
from fastapi import HTTPException

from app.api.v1 import material as api

from tests.test_segment_review import _world


def test_rating_upsert_and_list(db, run):
    w = _world(db, run)
    body = dict(folder="博朗旺-狗场合作/博朗旺20261103", dog_folder="002拉布拉多小七")
    run(api.put_rating("skin", api.RatingIn(**body, grade="S1", note="耳后发红"), db, w.ann))
    run(api.put_rating("skin", api.RatingIn(**body, grade="S2"), db, w.rev))
    run(api.put_rating("skin", api.RatingIn(**body, grade="S0"), db, w.ann))          # 改
    # 管理员看所有人的；兽医 / 实习生只看到自己的（看得到别人的会被带着走）
    rows = run(api.list_ratings("skin", db, w.admin))["data"]
    got = {r["user_id"]: (r["grade"], r["note"]) for r in rows}
    assert got == {w.ann.id: ("S0", None), w.rev.id: ("S2", None)}
    assert [r["user_id"] for r in run(api.list_ratings("skin", db, w.ann))["data"]] == [w.ann.id]
    run(api.put_rating("skin", api.RatingIn(**body, grade=None), db, w.rev))          # 撤销
    assert len(run(api.list_ratings("skin", db, w.admin))["data"]) == 1
    assert run(api.list_ratings("skin", db, w.rev))["data"] == []
    with pytest.raises(HTTPException):
        run(api.put_rating("skin", api.RatingIn(**body, grade="S9"), db, w.ann))
    with pytest.raises(HTTPException):
        run(api.list_ratings("oral", db, w.ann))                                      # 口腔相册只给管理员
