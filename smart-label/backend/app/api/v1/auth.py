from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.auth import ChangePasswordRequest, LoginRequest, RefreshRequest, TokenPair
from app.schemas.bootstrap import BootstrapAdminRequest
from app.schemas.envelope import ok

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/bootstrap-status")
async def bootstrap_status(db: AsyncSession = Depends(get_db)):
    """前端可用这个接口判断：要不要显示"创建首个管理员"引导页，还是正常登录页。"""
    count = (await db.execute(select(User.id).limit(1))).scalar_one_or_none()
    return ok({"needs_bootstrap": count is None})


@router.post("/bootstrap-admin")
async def bootstrap_admin(body: BootstrapAdminRequest, db: AsyncSession = Depends(get_db)):
    """
    只有数据库里一个用户都没有时才能调用，成功一次后永久失效（决策⑥的安全版本：
    不是"谁先注册谁是管理员"，而是"部署后自己立刻调一次，之后这个接口对任何人都返回403"）。
    """
    exists = (await db.execute(select(User.id).limit(1))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "已存在账号，无法再创建首个管理员")

    admin = User(
        username=body.username,
        display_name=body.display_name,
        role=UserRole.admin,
        password_hash=hash_password(body.password),
        must_change_password=False,
    )
    db.add(admin)
    await db.commit()
    return ok(msg="首个管理员创建成功，请使用该账号登录")


@router.post("/login")
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "账号已被禁用，请联系管理员")

    user.last_login_at = datetime.now(UTC)
    await db.commit()

    access = create_access_token(user.id, user.role.value)
    refresh = create_refresh_token(user.id, user.token_version)
    return ok(
        TokenPair(
            access_token=access,
            refresh_token=refresh,
            must_change_password=user.must_change_password,
        ).model_dump()
    )


@router.post("/refresh")
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token类型错误")
        user_id = int(payload["sub"])
        token_ver = payload["ver"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录") from None
    except (jwt.InvalidTokenError, KeyError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "无效token") from None

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不存在或已禁用")
    if user.token_version != token_ver:
        # 密码被改过 / 被管理员强制下线，此前签发的所有 refresh token 一律失效
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录状态已失效，请重新登录")

    access = create_access_token(user.id, user.role.value)
    new_refresh = create_refresh_token(user.id, user.token_version)
    return ok(
        TokenPair(
            access_token=access,
            refresh_token=new_refresh,
            must_change_password=user.must_change_password,
        ).model_dump()
    )


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "原密码错误")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.token_version += 1  # 强制所有旧 refresh token 失效，需重新登录
    await db.commit()
    return ok(msg="密码已修改，请重新登录")


@router.post("/logout")
async def logout(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    user.token_version += 1
    await db.commit()
    return ok(msg="已退出登录")
