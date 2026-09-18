from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LabelTemplateItemIn(BaseModel):
    code: str
    display_name: str
    color: str | None = None
    sort_order: int = 0
    # 上级标签的 code（同一模板里的另一条）。层级标签：舔身体 → 前爪 → 前左爪
    parent_code: str | None = None


class LabelTemplateItemOut(LabelTemplateItemIn):
    model_config = ConfigDict(from_attributes=True)

    id: int


class LabelTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    created_by: int
    created_at: datetime
    items: list[LabelTemplateItemOut] = []


class LabelTemplateCreate(BaseModel):
    name: str
    description: str | None = None
    items: list[LabelTemplateItemIn] = []


class LabelTemplateUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    """传了就整组替换模板里的标签；不传则只改名称/说明。"""
    items: list[LabelTemplateItemIn] | None = None


class SaveAsTemplateRequest(BaseModel):
    """把某个项目现有的标签存成模板。"""

    project_id: int
    name: str
    description: str | None = None


class ApplyTemplateResult(BaseModel):
    created: int
    skipped: int
    skipped_codes: list[str]
    # 项目里本来就有、这次按模板补上了上级的标签数（老项目升级成层级用）
    linked: int = 0
