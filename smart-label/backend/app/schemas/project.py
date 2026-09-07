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


class ProjectPrelabelRequest(BaseModel):
    """项目级批量 AI 预标注。task_ids 留空 = 项目下全部符合条件的任务。"""

    task_ids: list[int] | None = None
    # 连已经有 AI 片段（但没人改过/确认过）的任务也重新跑，比如换了模型想刷新
    overwrite_ai: bool = False
    # stable=稳定版 / raw=调试版，留空用 settings.algo_infer_mode
    mode: str | None = None
