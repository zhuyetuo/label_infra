"""按账号单独开的功能权限。

角色（admin / annotator / reviewer）管的是一大块：管理员页面整页只给管理员。
可有时候只想把其中一两样交给某个人——比如实习生每天整理狗的皮肤、口腔照片，
需要看狗档案、看口腔照片，但不该碰样本、训练、账号这些。给他升管理员太多，
不给又干不了活，所以加这一层：管理员在「账号管理」里一项项勾。

规则：
- 管理员 / 超级管理员不受这张表限制，什么都能用（跟以前一样）。
- 其他账号按勾选的功能放行；没勾的照旧 403。
- 存在 users.permissions 里，逗号分隔的功能键。每次请求都从数据库读用户，
  所以勾上 / 取消立刻生效，不用重新登录。

加新功能：在 FEATURES 里加一行，在对应接口上挂 require_feature，前端菜单
（AppLayout 的 feature 字段）和账号管理页的勾选框会跟着出来。
"""

from __future__ import annotations

from app.models.user import User, UserRole

# 功能键 → (名字, 说明)。顺序就是账号管理页上勾选框的顺序
FEATURES: dict[str, tuple[str, str]] = {
    "dogs_view": ("狗档案·查看", "看狗档案列表、照片、体重颈围记录"),
    "dogs_edit": ("狗档案·编辑", "新建和修改狗档案、上传照片、记体重颈围（含查看；删除狗档案仍只给管理员）"),
    "tooth": ("牙齿识别", "看口腔照片、跑牙齿检测"),
    # 不放行任何接口，只是个身份标记：皮肤「准确率」对照、真实标签重训模型 B 时，
    # 只拿勾了这一项的人的照片评级当标准答案；其他人（实习生）的拿来跟兽医比
    "skin_vet": ("兽医（皮肤评级以他为准）", "皮肤照片评级当标准答案用：准确率对照、训练模型都以兽医的评级为准，实习生的评级拿来跟兽医比"),
}


def is_vet(user_permissions: str | None) -> bool:
    """看账号自己勾没勾「兽医」——不走 granted()，管理员默认什么都有，但不默认是兽医"""
    return "skin_vet" in parse(user_permissions)

# 勾了前者就等于有后者
IMPLIES: dict[str, set[str]] = {"dogs_edit": {"dogs_view"}}

_ADMIN_ROLES = (UserRole.admin, UserRole.super_admin)


def parse(raw: str | None) -> list[str]:
    """数据库里那一列 → 功能键列表。认不出的键（功能被删了）丢掉。"""
    return [k for k in (p.strip() for p in (raw or "").split(",")) if k in FEATURES]


def dump(keys: list[str] | None) -> str | None:
    """功能键列表 → 存进数据库的样子。按 FEATURES 的顺序、去重；空的存 NULL。"""
    want = set(keys or ())
    unknown = want - FEATURES.keys()
    if unknown:
        raise ValueError(f"没有这些功能：{'、'.join(sorted(unknown))}")
    out = [k for k in FEATURES if k in want]
    return ",".join(out) or None


def granted(user: User) -> set[str]:
    """这个账号实际能用的功能（含 IMPLIES 推出来的）。管理员是全部。"""
    if user.role in _ADMIN_ROLES:
        return set(FEATURES)
    keys = set(parse(user.permissions))
    for k in list(keys):
        keys |= IMPLIES.get(k, set())
    return keys


def has(user: User, *keys: str) -> bool:
    """有其中任意一项就算有。"""
    return bool(granted(user) & set(keys))
