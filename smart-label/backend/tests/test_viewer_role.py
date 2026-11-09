"""访客账号：管理员能看的都能看，改东西一律 403；数据库里的角色不会被改成 admin。"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.core.security import create_access_token
from app.db.session import get_db
from app.main import app
from app.models.user import User, UserRole
from app.schemas.user import UserOut


class _Db:
    """get 返回访客本人；其他任何查库都报错（放行的请求走到处理函数里撞上它，返回 500 而不是 403）"""

    def __init__(self, user):
        self.user = user

    async def get(self, model, pk):
        return self.user

    def __getattr__(self, name):
        raise RuntimeError("测试里不该真的查库")


def _viewer():
    return User(id=7, username="pm", display_name="新产品经理", role=UserRole.viewer, permissions=None,
                is_active=True, is_outsourced=False, must_change_password=False, token_version=0,
                created_at=datetime(2026, 11, 9), remark=None, email=None, last_login_at=None)


@pytest.fixture
def client():
    u = _viewer()
    app.dependency_overrides[get_db] = lambda: _Db(u)
    c = TestClient(app, raise_server_exceptions=False)
    c.headers["Authorization"] = f"Bearer {create_access_token(u.id, u.role.value)}"
    yield c, u
    app.dependency_overrides.clear()


@pytest.mark.parametrize("path", ["/api/v1/samples", "/api/v1/users", "/api/v1/dogs", "/api/v1/tooth/photos"])
def test_管理员才能看的页面_访客也能看(client, path):
    c, _ = client
    assert c.get(path).status_code != 403


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/v1/dogs"), ("PATCH", "/api/v1/dogs/1"), ("DELETE", "/api/v1/dogs/1"),
    ("POST", "/api/v1/projects"), ("POST", "/api/v1/users"), ("PATCH", "/api/v1/users/1"),
    ("POST", "/api/v1/users/1/reset-password"),
])
def test_改东西一律不行(client, method, path):
    c, _ = client
    r = c.request(method, path, json={})
    assert r.status_code == 403 and "访客" in r.json().get("msg", r.text)


def test_能改自己的密码(client):
    c, _ = client
    assert c.post("/api/v1/auth/change-password", json={"old_password": "x", "new_password": "y" * 8}).status_code != 403


def test_me_告诉前端是访客_角色本身没被改成管理员(client):
    c, u = client
    me = c.get("/api/v1/users/me").json()["data"]
    assert me["role"] == "viewer" and me["read_only"] is True
    # 请求里临时当 admin 用，但不算改动：不会被 commit 写回库
    from sqlalchemy import inspect
    assert not inspect(u).attrs.role.history.has_changes()


def test_列表里的访客显示成访客():
    u = _viewer()
    assert UserOut.model_validate(u).role == UserRole.viewer
    assert UserOut.model_validate(u).read_only is True
