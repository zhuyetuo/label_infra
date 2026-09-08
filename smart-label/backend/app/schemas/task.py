from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.annotation import LabelItemSource
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
    # 下面两个都只有 GET /tasks 列表接口会算，单条任务接口懒得为了这一两个
    # 字段多查一次
    has_draft: bool = False
    # 当前轮草稿里已经有多少段，0 = 认领了但还没动手
    draft_item_count: int = 0
    # 当前轮各类别的段数 {label_id: {n, ai_pending}}，ai_pending = AI 给的还没人确认/改过的
    label_counts: dict[int, dict[str, int]] = {}
    # 被驳回时审核员写的意见，方便标注员知道要改什么
    review_comment: str | None = None
    # 样本编号和指派人名字：标注员/审核员拿不到 /samples 和 /users，列表里只能看
    # 到一串 ID，按 imu 归目录也没法算，所以列表接口直接把这两个带出来
    sample_code: str | None = None
    video_duration_sec: int | None = None
    # IMU CSV 数据行数，0 = 文件是空的，打开工作台会报"CSV 没有数据行"，这种任务管理员该删掉
    imu_row_count: int | None = None
    assigned_to_name: str | None = None
    # 指派人角色，列表里按角色上色（超管/管理员/标注员/审核员一眼分开）
    assigned_to_role: str | None = None


class LabelItemIn(BaseModel):
    label_id: int
    start_time_ms: int
    end_time_ms: int
    # 若这条标签是在编辑一条已存在的记录（AI生成或之前保存过的），前端带上原记录id；
    # 留空代表这是本次新增的标签。用于正确计算 source_type/is_modified（AI标签修改比例统计依赖这个）。
    origin_item_id: int | None = None
    # 新增条目的来源：前端点"AI预标注"填进来的传 ai_generated（带置信度），
    # 人手画的不传。只对新增条目生效，已存在条目的来源不会被改写。
    source_type: LabelItemSource | None = None
    ai_confidence: float | None = None
    # AI 片段人工确认状态。不传 = 保持库里原值（但类别/起止被改动时会自动清成 False）
    ai_confirmed: bool | None = None
    # 待定：拿不准，保留记录但不参与训练。不传 = 保持库里原值
    uncertain: bool | None = None
    # 待定原因：no_view（画面里没拍到狗）/ ambiguous（拍到了但看不准）
    uncertain_reason: str | None = None


class LabelItemOut(LabelItemIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_type: str
    is_modified: bool
    ai_confidence: float | None
    ai_confirmed: bool
    uncertain: bool
    uncertain_reason: str | None
    from_candidate_id: int | None
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


class BulkTaskCreate(BaseModel):
    """
    批量建任务：给一批样本一次性各建一个长任务（覆盖整个样本），不用逐个点。
    典型用法是把某一天的样本一次性导进项目里（样本页按日期分组，一天一批）。
    """

    project_id: int
    sample_ids: list[int]
    task_type: TaskType
    assigned_to: int | None = None
    # ai_assisted 时自动跑预标注用哪个版本：stable / viterbi / raw，留空用配置默认
    infer_mode: str | None = None


class BulkTaskCreateResult(BaseModel):
    created: int
    skipped: int
    skipped_sample_ids: list[int]


class ReopenRequest(BaseModel):
    """退回重标时可以附一句原因，记进 audit_logs 方便追溯。"""

    comment: str | None = None


class TaskIdsRequest(BaseModel):
    task_ids: list[int]


class ProjectScopeRequest(BaseModel):
    """全部认领 / 全部放弃：只要一个项目 id"""

    project_id: int
