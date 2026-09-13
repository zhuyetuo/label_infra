"""
指派与审核，以及它带来的权限边界。

这是整个视觉模块唯一一次真正放开权限——之前只有管理员能进，现在标注员也能进来。
所以这里测的重点不是"流程能不能跑通"，而是**边界漏没漏**：

  - 标注员能不能看到没指派给他的图（列表里、拿 token、读标注，三条路都要堵）
  - 能不能改别人的组
  - 已通过（锁定）的组，管理员自己能不能绕过审核直接改
  - 打回之后能不能继续改

接口和数据库都是真的（见 conftest 的说明）。
"""

import pytest
from fastapi import HTTPException

from app.api.v1 import vision as api
from app.models.user import User, UserRole
from app.models.vision_annotation import VisionAssignment

_JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300" + "10" * 64 + "ffd9")
_G_BALI = "2026-09-01-ok/巴利"
_G_LULU = "2026-09-01-ok/lulu"
_BALI_1 = f"{_G_BALI}/a.jpg"
_BALI_2 = f"{_G_BALI}/b.jpg"
_LULU_1 = f"{_G_LULU}/c.jpg"


@pytest.fixture()
def album(tmp_path, monkeypatch):
    from app.core.config import settings

    material = tmp_path / "material"
    for rel in (_BALI_1, _BALI_2, _LULU_1):
        p = material / "口腔验证" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(_JPEG)
    monkeypatch.setattr(settings, "material_root", str(material))
    monkeypatch.setattr(settings, "oral_dir", "口腔验证")
    monkeypatch.setattr(settings, "nas_root", str(tmp_path / "nas"))
    return material


def _mk(db, run, username, role):
    u = User(username=username, display_name=username, password_hash="x", role=role, is_active=True)
    db.add(u)
    run(db.commit())
    return u


@pytest.fixture()
def people(db, run):
    return {
        "admin": _mk(db, run, "admin1", UserRole.admin),
        "reviewer": _mk(db, run, "rev1", UserRole.reviewer),
        "anna": _mk(db, run, "anna", UserRole.annotator),
        "ben": _mk(db, run, "ben", UserRole.annotator),
    }


def _assign(run, db, people, group, who="anna", album_name="oral"):
    return run(api.create_assignments(
        api.AssignIn(album=album_name, group_keys=[group], assignee_id=people[who].id),
        db=db, user=people["admin"],
    ))["data"]


def _save_one(run, db, user, path, boxes=1, state="done"):
    items = [{"label_code": "canine", "bbox": [0.1, 0.1, 0.2, 0.2]}] * boxes
    return run(api.save_annotations(
        api.SaveIn(album="oral", path=path, items=items, state=state), db=db, user=user,
    ))


# ── 可见性 ──────────────────────────────────────────────────────────────

def test_标注员只看得到指派给自己的组(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_LULU, "ben")

    got = run(api.list_photos(album="oral", db=db, user=people["anna"]))["data"]
    groups = {d["group_key"] for f in got["folders"] for d in f["dogs"]}
    assert groups == {_G_BALI}, "看到了别人的组"
    assert got["can_review"] is False


def test_没有任何指派的标注员看到空列表(album, db, run, people):
    got = run(api.list_photos(album="oral", db=db, user=people["anna"]))["data"]
    assert got["folders"] == []


def test_管理员和审核员看得到全部(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    for who in ("admin", "reviewer"):
        got = run(api.list_photos(album="oral", db=db, user=people[who]))["data"]
        groups = {d["group_key"] for f in got["folders"] for d in f["dogs"]}
        assert groups == {_G_BALI, _G_LULU}, who
        assert got["can_review"] is True


def test_标注员拿不到别人组照片的_token(album, db, run, people):
    """token 是这个页面对标注员开放之后唯一的取图入口，堵不住就等于没有边界"""
    _assign(run, db, people, _G_BALI, "anna")
    ok_token = run(api.photo_token({"album": "oral", "path": _BALI_1}, db=db, user=people["anna"]))
    assert ok_token["data"]["token"]

    with pytest.raises(HTTPException) as e:
        run(api.photo_token({"album": "oral", "path": _LULU_1}, db=db, user=people["anna"]))
    assert e.value.status_code == 404


def test_标注员读不到别人组的标注(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_LULU, "ben")
    _save_one(run, db, people["ben"], _LULU_1)

    with pytest.raises(HTTPException) as e:
        run(api.get_annotations(album="oral", path=_LULU_1, db=db, user=people["anna"]))
    assert e.value.status_code == 404


def test_标注员改不了别人组的图(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_LULU, "ben")
    with pytest.raises(HTTPException) as e:
        _save_one(run, db, people["anna"], _LULU_1)
    assert e.value.status_code == 404


def test_没指派的组标注员改不了(album, db, run, people):
    with pytest.raises(HTTPException) as e:
        _save_one(run, db, people["anna"], _BALI_1)
    assert e.value.status_code == 404


# ── 流程 ────────────────────────────────────────────────────────────────

def test_标完才能提交(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["anna"]))["data"][0]
    _save_one(run, db, people["anna"], _BALI_1)  # 这组有两张，只标了一张

    with pytest.raises(HTTPException) as e:
        run(api.submit_assignment(a["id"], db=db, user=people["anna"]))
    assert e.value.status_code == 409
    assert "1 张没表态" in str(e.value.detail)

    _save_one(run, db, people["anna"], _BALI_2, boxes=0, state="skipped")  # 跳过也算表态
    got = run(api.submit_assignment(a["id"], db=db, user=people["anna"]))["data"]
    assert got["state"] == "submitted"


def test_提交之后不能再改直到被打回(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["anna"]))["data"][0]
    _save_one(run, db, people["anna"], _BALI_1)
    _save_one(run, db, people["anna"], _BALI_2)
    run(api.submit_assignment(a["id"], db=db, user=people["anna"]))

    with pytest.raises(HTTPException) as e:
        _save_one(run, db, people["anna"], _BALI_1, boxes=2)
    assert e.value.status_code == 409

    run(api.review_assignment(a["id"], api.ReviewIn(approve=False, note="犬齿的框偏了"), db=db, user=people["reviewer"]))
    after = run(api.list_assignments(album="oral", db=db, user=people["anna"]))["data"][0]
    assert after["state"] == "rejected"
    assert after["review_note"] == "犬齿的框偏了"
    _save_one(run, db, people["anna"], _BALI_1, boxes=2)  # 打回后能继续改


def test_打回必须写意见(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"][0]
    with pytest.raises(HTTPException) as e:
        run(api.review_assignment(a["id"], api.ReviewIn(approve=False, note="   "), db=db, user=people["reviewer"]))
    assert e.value.status_code == 400


def test_通过之后锁定连管理员也不能直接改(album, db, run, people):
    """审过的结论被人静默改掉，审核就白做了。管理员要改也得先走打回。"""
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"][0]
    _save_one(run, db, people["anna"], _BALI_1)
    _save_one(run, db, people["anna"], _BALI_2)
    run(api.submit_assignment(a["id"], db=db, user=people["anna"]))
    run(api.review_assignment(a["id"], api.ReviewIn(approve=True, note=None), db=db, user=people["reviewer"]))

    for who in ("anna", "admin"):
        with pytest.raises(HTTPException) as e:
            _save_one(run, db, people[who], _BALI_1, boxes=3)
        assert e.value.status_code == 409, who

    run(api.review_assignment(a["id"], api.ReviewIn(approve=False, note="再补两颗"), db=db, user=people["reviewer"]))
    _save_one(run, db, people["anna"], _BALI_1, boxes=3)


def test_改派会重置状态但通过的组改派不了(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"][0]
    _save_one(run, db, people["anna"], _BALI_1)
    _save_one(run, db, people["anna"], _BALI_2)
    run(api.submit_assignment(a["id"], db=db, user=people["anna"]))

    res = _assign(run, db, people, _G_BALI, "ben")
    assert res["moved"] == 1
    moved = run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"][0]
    assert moved["assignee_id"] == people["ben"].id
    assert moved["state"] == "open", "改派之后应该回到可编辑状态"

    _save_one(run, db, people["ben"], _BALI_1)
    _save_one(run, db, people["ben"], _BALI_2)
    run(api.submit_assignment(moved["id"], db=db, user=people["ben"]))
    run(api.review_assignment(moved["id"], api.ReviewIn(approve=True, note=None), db=db, user=people["reviewer"]))

    res2 = _assign(run, db, people, _G_BALI, "anna")
    assert res2["locked"] == [_G_BALI] and res2["moved"] == 0


def test_一个组只能属于一个人(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_BALI, "ben")
    rows = run(db.execute(VisionAssignment.__table__.select())).all()
    assert len(rows) == 1, "同一个组指派了两条，两个人会互相覆盖对方的标注"


def test_标注员不能自己指派自己(album, db, run, people):
    from app.core.deps import require_role

    checker = require_role(*api._MANAGERS)
    with pytest.raises(HTTPException) as e:
        run(checker(user=people["anna"]))
    assert e.value.status_code == 403


def test_标注员看不到别人的指派列表(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_LULU, "ben")
    mine = run(api.list_assignments(album="oral", db=db, user=people["anna"]))["data"]
    assert [r["group_key"] for r in mine] == [_G_BALI]
    all_ = run(api.list_assignments(album="oral", db=db, user=people["reviewer"]))["data"]
    assert len(all_) == 2


def test_撤销指派不删标注(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    a = run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"][0]
    _save_one(run, db, people["anna"], _BALI_1)
    run(api.delete_assignment(a["id"], db=db, user=people["admin"]))

    assert run(api.list_assignments(album="oral", db=db, user=people["admin"]))["data"] == []
    got = run(api.get_annotations(album="oral", path=_BALI_1, db=db, user=people["admin"]))["data"]
    assert len(got["items"]) == 1, "撤销指派把已经标好的框也带走了"


def test_指派给不存在或已禁用的账号会被拒(album, db, run, people):
    with pytest.raises(HTTPException) as e:
        run(api.create_assignments(
            api.AssignIn(album="oral", group_keys=[_G_BALI], assignee_id=999999),
            db=db, user=people["admin"],
        ))
    assert e.value.status_code == 400

    people["ben"].is_active = False
    run(db.commit())
    with pytest.raises(HTTPException):
        _assign(run, db, people, _G_LULU, "ben")


def test_进度只统计自己那几组(album, db, run, people):
    _assign(run, db, people, _G_BALI, "anna")
    _assign(run, db, people, _G_LULU, "ben")
    _save_one(run, db, people["anna"], _BALI_1, boxes=2)
    _save_one(run, db, people["ben"], _LULU_1, boxes=3)

    anna = run(api.stats(album="oral", db=db, user=people["anna"]))["data"]
    assert anna["total_boxes"] == 2 and anna["scoped"] is True
    admin = run(api.stats(album="oral", db=db, user=people["admin"]))["data"]
    assert admin["total_boxes"] == 5 and admin["scoped"] is False


def test_迁移和模型的列必须一一对应():
    import ast

    src = open("alembic/versions/d1f4b82c6ae3_add_vision_assignments.py", encoding="utf-8").read()
    cols = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "create_table":
            cols = {
                a.args[0].value for a in node.args[1:]
                if isinstance(a, ast.Call) and getattr(a.func, "attr", "") == "Column"
            }
    assert cols == {c.name for c in VisionAssignment.__table__.columns}
