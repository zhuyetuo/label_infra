import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.core.security import hash_password
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.task import Task
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


@router.post("/{user_id}/reset-password", dependencies=[Depends(require_role(UserRole.admin))])
async def reset_password(user_id: int, db: AsyncSession = Depends(get_db)):
    """
    重置密码，返回一次性临时密码交给本人。

    注意：系统里存的是 bcrypt 哈希，设计上就不可逆，所以任何人（包括管理员）
    都看不到别人的原始密码——这不是没做，是不能做：库一旦泄露，明文密码等于
    把所有账号连同用户在别处复用的密码一起交出去。需要帮人恢复访问时走这里，
    发一个临时密码，对方登录后会被强制改掉。
    """
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "账号不存在")

    temp_password = secrets.token_urlsafe(9)
    user.password_hash = hash_password(temp_password)
    user.must_change_password = True
    # 改密码要把该账号已经发出去的 token 全部作废，否则原会话还能继续用
    user.token_version += 1
    await db.commit()
    return ok({"username": user.username, "temp_password": temp_password})


@router.delete("/{user_id}", dependencies=[Depends(require_role(UserRole.admin))])
async def delete_user(user_id: int, db: AsyncSession = Depends(get_db), me: User = Depends(get_current_user)):
    """
    删除账号。已经产生过工作记录的账号不能真删——任务、标注、审核记录里都记着
    是谁干的，删了这些记录要么变成孤儿要么得连坐删掉，历史就查不清了。
    这种情况请用「禁用」：禁用后无法登录，但历史记录仍然可追溯。
    """
    if user_id == me.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能删除当前登录的账号")

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "账号不存在")

    if user.role == UserRole.admin:
        admin_count = (
            await db.execute(
                select(func.count()).select_from(User).where(User.role == UserRole.admin, User.is_active.is_(True))
            )
        ).scalar_one()
        if admin_count <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "至少要保留一个启用中的管理员")

    # 这些表用 NOT NULL 外键记着"是谁创建/审核的"，有引用就不能物理删除
    blockers: list[str] = []
    for label, stmt in (
        ("任务", select(func.count()).select_from(Task).where(
            or_(Task.created_by == user_id, Task.assigned_to == user_id, Task.reviewer_id == user_id))),
        ("样本", select(func.count()).select_from(Sample).where(Sample.created_by == user_id)),
        ("项目", select(func.count()).select_from(Project).where(Project.created_by == user_id)),
        ("标签", select(func.count()).select_from(LabelDefinition).where(LabelDefinition.created_by == user_id)),
        ("审核记录", select(func.count()).select_from(ReviewRecord).where(ReviewRecord.reviewer_id == user_id)),
    ):
        count = (await db.execute(stmt)).scalar_one()
        if count:
            blockers.append(f"{label} {count} 条")
    if blockers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"该账号已产生工作记录（{'、'.join(blockers)}），删除会让历史无法追溯；请改用「禁用」",
        )

    # 审计日志允许留痕但可空，断开引用即可
    await db.execute(update(AuditLog).where(AuditLog.user_id == user_id).values(user_id=None))
    await db.delete(user)
    await db.commit()
    return ok(msg="账号已删除")


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
