from collections.abc import Callable

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.security import decode_token
from app.db.session import get_db
from app.models.user import User, UserRole

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
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
