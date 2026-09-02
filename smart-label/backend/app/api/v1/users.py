import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.core.security import hash_password
from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.user import UserCreate, UserCreateOut, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

# 不提供任何公开的 /register 接口。账号只能由 admin 在这里创建（决策⑥）。


@router.get("", dependencies=[Depends(require_role(UserRole.admin))])
async def list_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return ok([UserOut.model_validate(u).model_dump() for u in users])


@router.post("", dependencies=[Depends(require_role(UserRole.admin))])
async def create_user(body: UserCreate, db: AsyncSession = Depends(get_db)):
    if body.is_outsourced and body.role != UserRole.annotator:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "外包账号只能是 annotator 角色")

    exists = await db.execute(select(User).where(User.username == body.username))
    if exists.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "用户名已存在")

    temp_password = secrets.token_urlsafe(9)
    user = User(
        username=body.username,
        display_name=body.display_name,
        email=body.email,
        role=body.role,
        is_outsourced=body.is_outsourced,
        password_hash=hash_password(temp_password),
        must_change_password=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # 临时密码只在这一次响应里返回，管理员自行通过其他渠道告知本人，数据库/日志不留明文
    return ok(
        UserCreateOut(user=UserOut.model_validate(user), temp_password=temp_password).model_dump()
    )


@router.patch("/{user_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def update_user(user_id: int, body: UserUpdate, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")

    updates = body.model_dump(exclude_unset=True)
    new_role = updates.get("role", user.role)
    new_outsourced = updates.get("is_outsourced", user.is_outsourced)
    if new_outsourced and new_role != UserRole.annotator:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "外包账号只能是 annotator 角色")

    for field, value in updates.items():
        setattr(user, field, value)
    if "is_active" in updates and not updates["is_active"]:
        user.token_version += 1  # 禁用账号时顺带让其现有 token 立即失效

    await db.commit()
    await db.refresh(user)
    return ok(UserOut.model_validate(user).model_dump())


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return ok(UserOut.model_validate(user).model_dump())
