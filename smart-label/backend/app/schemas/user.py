from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.core import permissions as perms
from app.models.user import UserRole


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    email: str | None
    role: UserRole
    is_outsourced: bool
    is_active: bool
    must_change_password: bool
    remark: str | None
    # 单独开的功能（不含管理员的"全部"——管理员前端按角色判断）
    permissions: list[str] = []
    last_login_at: datetime | None
    created_at: datetime

    @field_validator("permissions", mode="before")
    @classmethod
    def _split(cls, v):
        return perms.parse(v) if isinstance(v, str) or v is None else v


class UserCreate(BaseModel):
    username: str
    display_name: str
    email: str | None = None
    role: UserRole
    is_outsourced: bool = False
    remark: str | None = None


class UserCreateOut(BaseModel):
    user: UserOut
    temp_password: str


class UserUpdate(BaseModel):
    # 用户名是登录名，只有超级管理员能改（接口里再校验）
    username: str | None = None
    display_name: str | None = None
    email: str | None = None
    role: UserRole | None = None
    is_outsourced: bool | None = None
    is_active: bool | None = None
    remark: str | None = None
    permissions: list[str] | None = None

    @field_validator("permissions")
    @classmethod
    def _known(cls, v):
        if v is not None:
            perms.dump(v)          # 有不认识的键直接 422，别存进去
        return v
