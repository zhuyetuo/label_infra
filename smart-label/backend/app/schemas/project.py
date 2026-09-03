from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    is_active: bool
    created_by: int
    created_at: datetime


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None


class ProjectAssignRequest(BaseModel):
    """把项目下的任务一次性指派给某人。user_id 传 null 表示收回指派（回到公共池）。"""

    user_id: int | None = None
    """是否连已经有人在标/已提交的任务一起改派。默认只动还没被认领的，
    避免把别人正在做的活儿从手里抢走。"""
    include_claimed: bool = False


class ProjectAssignResult(BaseModel):
    assigned: int
    skipped: int
