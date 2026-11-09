import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions as perms
from app.core.deps import get_current_user, require_role
from app.core.security import hash_password
from app.core.temp_password import seal, unseal
from app.db.base import Base
from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.user import UserCreate, UserCreateOut, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

# 不提供任何公开的 /register 接口。账号只能由 admin 在这里创建（决策⑥）。


@router.get("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def list_users(db: AsyncSession = Depends(get_db)):
    # 离职（禁用）的排到最后
    result = await db.execute(select(User).order_by(User.is_active.desc(), User.created_at.desc()))
    users = result.scalars().all()
    return ok([UserOut.model_validate(u).model_dump() for u in users])


@router.post("/{user_id}/reset-password", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
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
    user.temp_password_enc = seal(temp_password)
    user.must_change_password = True
    # 改密码要把该账号已经发出去的 token 全部作废，否则原会话还能继续用
    user.token_version += 1
    await db.commit()
    return ok({"username": user.username, "temp_password": temp_password})


@router.get("/{user_id}/temp-password", dependencies=[Depends(require_role(UserRole.super_admin))])
async def get_temp_password(user_id: int, db: AsyncSession = Depends(get_db)):
    """超级管理员回看系统发的临时密码。本人改过密码就没有了——本人的密码谁都看不到，只能重置"""
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "账号不存在")
    return ok({"username": user.username, "temp_password": unseal(user.temp_password_enc)})


@router.delete("/{user_id}", dependencies=[Depends(require_role(UserRole.super_admin))])
async def delete_user(user_id: int, db: AsyncSession = Depends(get_db), me: User = Depends(get_current_user)):
    """
    删除账号。只有超级管理员能删账号，普通管理员没有这个权限（决策：
    删除是不可逆操作，收紧到只有超级管理员能做，其余权限管理员和超级管理员完全一样）。

    已经产生过工作记录的账号不能真删——任务、标注、审核记录里都记着
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

    # 哪些表引用了这个账号：**从表结构里现找**，不手写清单。手写的清单漏过一次——
    # 删一个在皮肤评估里填过记录的账号，检查放行了，最后在 db.delete 撞外键报 500
    # （IntegrityError）。以后加了新表也不用记得回来改这里。
    blockers: list[str] = []
    detach: list[tuple] = []
    for table, col in _user_refs():
        name = (table.name, col.name)
        count = (await db.execute(select(func.count()).select_from(table).where(col == user_id))).scalar_one()
        if not count:
            continue
        if name in _DETACH_REFS:
            detach.append((table, col))
        else:
            blockers.append(f"{_REF_LABELS.get(name, table.name)} {count} 条")
    if blockers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"该账号已产生工作记录（{'、'.join(blockers)}），删除会让历史无法追溯；请改用「禁用」",
        )

    # 只是"谁最后动过"的痕迹，不算工作成果：断开引用即可
    for table, col in detach:
        await db.execute(update(table).where(col == user_id).values({col.name: None}))
    await db.delete(user)
    try:
        await db.commit()
    except IntegrityError:
        # 兜底：上面没认出来的引用（比如数据库里有、模型里没声明的外键），
        # 也别报 500，给出能照着做的那句话
        await db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "该账号还被其他记录引用，删除会让历史无法追溯；请改用「禁用」") from None
    return ok(msg="账号已删除")


# 删账号时直接断开引用、不拦着的：只记了"谁最后动过 / 谁临时占着"，不是工作成果。
# 都是可空列（_user_refs 会核对，非空列放进来会在启动时报错）
_DETACH_REFS = {
    ("audit_logs", "user_id"),
    ("tasks", "locked_by"),
    ("llm_providers", "updated_by"),
    ("clip_jobs", "requested_by"),
}

# 提示里给人看的名字；没列的显示表名，不影响判断
_REF_LABELS = {
    ("tasks", "created_by"): "创建的任务", ("tasks", "assigned_to"): "指派的任务",
    ("tasks", "reviewer_id"): "审核的任务", ("samples", "created_by"): "样本",
    ("projects", "created_by"): "项目", ("label_definitions", "created_by"): "标签",
    ("label_templates", "created_by"): "标签模板", ("review_records", "reviewer_id"): "审核记录",
    ("vision_annotations", "created_by"): "视觉标注", ("vision_assets", "updated_by"): "视觉标注状态",
    ("vision_assignments", "assignee_id"): "视觉标注指派", ("vision_assignments", "reviewed_by"): "视觉标注审核",
    ("vision_assignments", "created_by"): "视觉标注派发", ("skin_records", "created_by"): "皮肤评估记录",
    ("skin_weekly_rows", "created_by"): "皮肤周报", ("model_versions", "created_by"): "模型版本",
    ("dog_measurements", "created_by"): "狗体重/颈围记录", ("tooth_photo_results", "detected_by"): "牙齿检测结果",
    ("ai_candidates", "decided_by"): "AI 候选确认", ("annotation_label_items", "created_by"): "标注片段",
    ("annotation_label_items", "touched_by"): "标注片段修改",
    ("annotation_label_items", "review_flag_by"): "审核标出的问题片段",
    ("ai_candidates", "review_flag_by"): "审核标出的问题疑似片段",
}


def _user_refs() -> list[tuple]:
    """所有外键指向 users.id 的 (表, 列)。app.models 的 __init__ 导入了全部模型，
    所以这里拿到的表结构是全的（本文件导入 app.models.user 时就已经触发）。"""
    out = []
    for table in Base.metadata.sorted_tables:
        for col in table.columns:
            if any(fk.column.table.name == "users" for fk in col.foreign_keys):
                if (table.name, col.name) in _DETACH_REFS and not col.nullable:
                    raise RuntimeError(f"{table.name}.{col.name} 不可空，不能在删账号时断开")
                out.append((table, col))
    return out


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
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
        remark=body.remark,
        password_hash=hash_password(temp_password),
        temp_password_enc=seal(temp_password),
        must_change_password=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # 临时密码加密存了一份，本人改密码前超级管理员能在账号管理里再看（见 core/temp_password.py）
    return ok(
        UserCreateOut(user=UserOut.model_validate(user), temp_password=temp_password).model_dump()
    )


@router.patch("/{user_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def update_user(user_id: int, body: UserUpdate, db: AsyncSession = Depends(get_db),
                      me: User = Depends(get_current_user)):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")

    updates = body.model_dump(exclude_unset=True)
    # 用户名 = 登录名，改了对方下次就得用新名字登录，只让超级管理员动；不能为空、不能重名
    if "username" in updates:
        if me.role != UserRole.super_admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "只有超级管理员能改用户名")
        new_name = (updates["username"] or "").strip()
        if not new_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "用户名不能为空")
        dup = (await db.execute(select(User).where(User.username == new_name, User.id != user_id))).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"用户名「{new_name}」已被占用")
        updates["username"] = new_name
    if "display_name" in updates:
        updates["display_name"] = (updates["display_name"] or "").strip()
        if not updates["display_name"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "显示名不能为空")
    new_role = updates.get("role", user.role)
    new_outsourced = updates.get("is_outsourced", user.is_outsourced)
    if new_outsourced and new_role != UserRole.annotator:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "外包账号只能是 annotator 角色")

    if "permissions" in updates:
        updates["permissions"] = perms.dump(updates["permissions"])

    for field, value in updates.items():
        setattr(user, field, value)
    if "is_active" in updates and not updates["is_active"]:
        user.token_version += 1  # 禁用账号时顺带让其现有 token 立即失效

    await db.commit()
    await db.refresh(user)
    return ok(UserOut.model_validate(user).model_dump())


@router.get("/features", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def list_features():
    """能单独开给账号的功能清单，账号管理页拿它出勾选框。"""
    return ok([{"key": k, "name": n, "description": d} for k, (n, d) in perms.FEATURES.items()])


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return ok(UserOut.model_validate(user).model_dump())
