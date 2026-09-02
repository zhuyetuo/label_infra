from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.task import TaskStatus, TaskType


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    sample_id: int
    task_type: TaskType
    status: TaskStatus
    round_no: int
    segment_start_ms: int | None
    segment_end_ms: int | None
    parent_task_id: int | None
    assigned_to: int | None
    reviewer_id: int | None
    locked_by: int | None
    lock_expires_at: datetime | None
    created_at: datetime


class LabelItemIn(BaseModel):
    label_id: int
    start_time_ms: int
    end_time_ms: int
    # 若这条标签是在编辑一条已存在的记录（AI生成或之前保存过的），前端带上原记录id；
    # 留空代表这是本次新增的标签。用于正确计算 source_type/is_modified（AI标签修改比例统计依赖这个）。
    origin_item_id: int | None = None


class LabelItemOut(LabelItemIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_type: str
    is_modified: bool
    ai_confidence: float | None
    created_by: int | None


class DraftSaveRequest(BaseModel):
    items: list[LabelItemIn]


class DraftOut(BaseModel):
    round_no: int
    items: list[LabelItemOut]


class TaskCreate(BaseModel):
    project_id: int
    sample_id: int
    task_type: TaskType
    # 留空 = 整段样本的长任务；都填 = 样本内子时间段的短任务（决策②，两者可并存）
    segment_start_ms: int | None = None
    segment_end_ms: int | None = None
    assigned_to: int | None = None  # 预指派给某标注员；留空 = 开放任务池


class ReopenRequest(BaseModel):
    """退回重标时可以附一句原因，记进 audit_logs 方便追溯。"""

    comment: str | None = None
