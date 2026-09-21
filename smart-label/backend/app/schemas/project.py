from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


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


class ProjectVisionSeekRequest(BaseModel):
    """大模型看视频找动作（视觉大模型走 API）。task_ids 留空 = 项目下待认领/标注中的全部任务。"""

    task_ids: list[int] | None = None
    # 只找这几个父类（舔身体/啃身体/抓挠/蹭身体）；留空 = 项目里有的全找
    labels: list[str] | None = None
    # 部位送到第几层（相对父类）：0 = 不问部位，1 = 大区域（头颈耳），2 = 具体部位（耳/耳后），
    # 3 = 连左右。层数深了选项几十个、几帧俯拍也分不出左右，反而把模型带偏
    part_depth: int = Field(2, ge=0, le=3)
    cam: str = "cam1"
    # 只跑这几个「场地·机位」（如「狗场2/cam4」）。空 = 不限。
    # 跟 cam 正交：cam 是配对规则，这个是范围
    scopes: list[str] = Field(default_factory=list, max_length=100)
    # 每个视频最多送多少段去问模型——这是花费的上限
    max_clips: int = 120
    min_conf: float = 0.5
    # 只做本地筛选、不问模型、不写候选：先看会送多少段
    dry_run: bool = False
    # 用哪家（anthropic / openai / doubao / gemini）的哪个模型，在「大模型 API」页配。
    # 留空 = 视觉服务环境变量里那把 Claude key（老方式）
    provider: str | None = None
    model: str | None = None
    # 先筛一遍再写：跑完不直接写候选，把找到的段摆成一屏让人过一眼，勾中的才写。
    # 模型一次能出几千段，错的直接进候选列表的话，人得跨几十个任务一条条排除
    review: bool = False
