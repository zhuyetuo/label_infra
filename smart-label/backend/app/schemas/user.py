from datetime import datetime

from pydantic import BaseModel, ConfigDict

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
    last_login_at: datetime | None
    created_at: datetime


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
    display_name: str | None = None
    email: str | None = None
    role: UserRole | None = None
    is_outsourced: bool | None = None
    is_active: bool | None = None
    remark: str | None = None
