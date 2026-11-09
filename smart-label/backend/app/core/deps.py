from collections.abc import Callable

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core import permissions
from app.core.security import decode_token
from app.db.session import get_db
from app.models.user import User, UserRole

_bearer = HTTPBearer(auto_error=False)

# 访客能用的非 GET 接口：改自己的密码、退出登录，外加几个只是"算一下给你看"、不写库的 POST
VIEWER_ALLOWED_POSTS = (
    "/auth/change-password",
    "/auth/logout",
    "/model-eval/compare",
    "/data-pool/compare-preview",
    "/skin/ml/preview",
    "/candidates/similar/preview",
)
_SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def _viewer_gate(request: Request | None, user: User) -> None:
    """访客 = 只读的管理员。

    · 改东西的请求（POST / PUT / PATCH / DELETE）一律 403，上面那几个除外；
    · 看东西的请求当成管理员处理：项目、任务、统计……管理员能看的都能看。

    为什么不是到处加 viewer 判断：「管理员才能看」的判断散在几十个接口和服务里，
    挨个加既容易漏、以后新接口也会忘。这里把角色在本次请求里临时当成 admin——
    用 set_committed_value，不算改动，就算这次请求里有 commit 也不会把 admin 写回库。
    原来的角色记在 user.read_only 上，/users/me 靠它告诉前端这是访客。
    """
    if user.role != UserRole.viewer:
        return
    method = request.method if request is not None else "GET"
    path = request.url.path if request is not None else ""
    if method not in _SAFE_METHODS:
        if not any(path.endswith(p) for p in VIEWER_ALLOWED_POSTS):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "访客账号只能查看，不能修改")
        return
    user.read_only = True
    set_committed_value(user, "role", UserRole.admin)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token类型错误")
        user_id = int(payload["sub"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "无效token") from None

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不存在或已禁用")
    _viewer_gate(request, user)
    return user


def require_role(*roles: UserRole) -> Callable:
    """依赖注入方式的角色校验：Depends(require_role(UserRole.admin))"""

    async def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "权限不足")
        return user

    return _checker


def require_feature(*keys: str) -> Callable:
    """管理员，或者单独开了其中任意一项功能的账号：Depends(require_feature("dogs_view"))"""
    unknown = set(keys) - permissions.FEATURES.keys()
    assert not unknown, f"没有登记的功能键：{unknown}"   # 写错键名在启动时就炸，别等到线上 403

    async def _checker(user: User = Depends(get_current_user)) -> User:
        if not permissions.has(user, *keys):
            names = "、".join(permissions.FEATURES[k][0] for k in keys)
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"权限不足：需要「{names}」，请找管理员开通")
        return user

    return _checker
