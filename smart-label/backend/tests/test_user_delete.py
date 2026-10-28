"""删账号：引用了这个账号的地方从表结构里现找，不再手写清单。

起因：删一个在皮肤评估里填过记录的账号（产品经理），手写的检查清单里没有那张表，
检查放行了，最后在 db.delete 撞外键，页面上只有一句「服务器内部错误: IntegrityError」。
"""

import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import users as U
from app.models.audit_log import AuditLog
from app.models.dog import Dog
from app.models.dog_measurement import DogMeasurement
from app.models.user import User, UserRole


def _user(db, uid, role=UserRole.admin, name=None):
    u = User(id=uid, username=name or f"u{uid}", password_hash="x", display_name=name or f"u{uid}",
             role=role, is_active=True, is_outsourced=False, must_change_password=False, token_version=0)
    db.add(u)
    return u


@pytest.fixture()
def users(db, run):
    me = _user(db, 1, UserRole.super_admin, "toky")
    _user(db, 2, UserRole.admin, "leon")          # 留一个启用中的管理员，删 7 号不会撞"至少留一个"
    linda = _user(db, 7, UserRole.admin, "Linda")
    run(db.commit())
    return me, linda


def test_手写清单漏掉的表也会拦下来_给出能照着做的提示(db, run, users):
    me, linda = users
    db.add(Dog(id=1, dog_code="5"))
    run(db.flush())
    db.add(DogMeasurement(dog_id=1, measured_on=datetime.date(2026, 10, 1), created_by=linda.id))
    run(db.commit())
    with pytest.raises(HTTPException) as e:
        run(U.delete_user(linda.id, db=db, me=me))
    assert e.value.status_code == 400
    assert "狗体重/颈围记录 1 条" in e.value.detail and "禁用" in e.value.detail
    assert run(db.get(User, linda.id)) is not None, "被拦下时不能删"


def test_只有痕迹的账号能删_痕迹断开引用(db, run, users):
    me, linda = users
    db.add(AuditLog(user_id=linda.id, action="user.login"))
    run(db.commit())
    run(U.delete_user(linda.id, db=db, me=me))
    assert run(db.get(User, linda.id)) is None
    log = (run(db.execute(select(AuditLog)))).scalars().one()
    assert log.user_id is None, "审计日志要留着，只断开引用"


def test_所有引用账号的列都被检查到():
    """以后加了新表、新的外键列，自动算进来；这里守住那几张以前漏掉的。"""
    refs = {(t.name, c.name) for t, c in U._user_refs()}
    for must in [("skin_records", "created_by"), ("skin_weekly_rows", "created_by"),
                 ("model_versions", "created_by"), ("label_templates", "created_by"),
                 ("dog_measurements", "created_by"), ("annotation_label_items", "created_by")]:
        assert must in refs, must
    assert U._DETACH_REFS <= refs, "断开清单里有不存在的列（改名了？）"
