"""按账号单独开的功能权限：管理员照旧全开；其他账号只放行勾了的功能。

起因：实习生每天整理狗的皮肤 / 口腔照片，要看狗档案、看口腔照片，但不该碰样本、
训练、账号。给他升管理员太多，不给又干不了活。

这里不连数据库：当前用户直接替换掉，数据库会话换成一个一碰就报错的假货。
被权限挡下的请求根本走不到处理函数，返回 403；放行的会走进去、碰到假数据库报错，
返回 500——所以"不是 403"就说明权限这一层放行了。
"""

import pytest
from fastapi.testclient import TestClient

from app.core import permissions as P
from app.core.deps import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.user import User, UserRole
from app.schemas.user import UserOut, UserUpdate


class _NoDb:
    def __getattr__(self, name):
        raise RuntimeError("测试里不该真的查库")


def _user(role=UserRole.annotator, permissions=None):
    return User(id=1, username="intern", display_name="实习生", role=role,
                permissions=permissions, is_active=True, is_outsourced=False,
                must_change_password=False, token_version=0)


@pytest.fixture
def as_user():
    client = TestClient(app, raise_server_exceptions=False)

    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_db] = lambda: _NoDb()
        return client

    yield _set
    app.dependency_overrides.clear()


# (方法, 路径, 需要的功能)；None = 只给管理员
_ROUTES = [
    ("GET", "/api/v1/dogs", "dogs_view"),
    ("GET", "/api/v1/dogs/1/photos", "dogs_view"),
    ("POST", "/api/v1/dogs", "dogs_edit"),
    ("PATCH", "/api/v1/dogs/1", "dogs_edit"),
    ("POST", "/api/v1/dogs/1/measurements", "dogs_edit"),
    ("DELETE", "/api/v1/dogs/1/photos/a.jpg", "dogs_edit"),
    ("DELETE", "/api/v1/dogs/1", None),
    ("GET", "/api/v1/tooth/photos", "tooth"),
    ("GET", "/api/v1/samples", None),
    ("GET", "/api/v1/users", None),
]


def _status(client, method, path):
    return client.request(method, path, json={}).status_code


@pytest.mark.parametrize("method,path,need", _ROUTES)
def test_没开任何功能的普通账号_这些都进不去(as_user, method, path, need):
    assert _status(as_user(_user()), method, path) == 403


@pytest.mark.parametrize("method,path,need", _ROUTES)
def test_管理员不受影响(as_user, method, path, need):
    assert _status(as_user(_user(UserRole.admin)), method, path) != 403


@pytest.mark.parametrize("method,path,need", _ROUTES)
def test_只开查看_能看不能改(as_user, method, path, need):
    code = _status(as_user(_user(permissions="dogs_view")), method, path)
    assert (code != 403) == (need == "dogs_view"), (method, path, code)


@pytest.mark.parametrize("method,path,need", _ROUTES)
def test_开编辑就带查看_删狗和别的页面仍然不行(as_user, method, path, need):
    code = _status(as_user(_user(permissions="dogs_edit,tooth")), method, path)
    assert (code != 403) == (need in ("dogs_view", "dogs_edit", "tooth")), (method, path, code)


def test_403_说清楚缺哪一项(as_user):
    r = as_user(_user()).get("/api/v1/tooth/photos")
    assert "牙齿识别" in r.text, r.text


# ── 存取 ────────────────────────────────────────────────────────────────

def test_存的时候按清单顺序去重_空的存NULL():
    assert P.dump(["tooth", "dogs_view", "tooth"]) == "dogs_view,tooth"
    assert P.dump([]) is None and P.dump(None) is None
    with pytest.raises(ValueError):
        P.dump(["shanchu_quanbu"])


def test_读的时候丢掉已经下线的功能键():
    """功能哪天从清单里删了，老账号上残留的键不能让接口炸，也不能还算数。"""
    assert P.parse("dogs_view, 早就删了的功能 ,tooth") == ["dogs_view", "tooth"]
    assert P.granted(_user(permissions="早就删了的功能")) == set()


def test_接口返回列表_不认识的键改的时候直接拒():
    out = UserOut.model_validate(_user(permissions="tooth,dogs_view").__dict__ | {"created_at": "2026-10-28T00:00:00", "last_login_at": None, "email": None, "remark": None})
    assert out.permissions == ["tooth", "dogs_view"]
    with pytest.raises(ValueError):
        UserUpdate(permissions=["没有这个"])
    assert UserUpdate(permissions=[]).permissions == []


# ── 标注员打开任务时自动调的接口，不能是管理员专用 ─────────────────────────

@pytest.mark.parametrize("path", [
    "/api/v1/samples/1/media",
    "/api/v1/samples/1/ai-label-info",
    # 标注工作台一打开就调（顶部"IMU 在抓挠时画面里有没有狗"那条）。以前挂在管理员
    # 路由上，标注员每进一个任务都弹「权限不足」
    "/api/v1/samples/1/scratch-crosscheck",
])
def test_标注工作台自动调的接口_标注员不被角色挡掉(as_user, path):
    """角色这一层放行；看不看得到这份样本，再按任务范围在接口里判（要查库，这里不测）。"""
    assert as_user(_user()).get(path).status_code != 403


def test_样本管理本身仍然只给管理员(as_user):
    assert as_user(_user()).get("/api/v1/samples").status_code == 403
