from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LabelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    display_name: str
    color: str | None
    parent_id: int | None
    sort_order: int
    is_active: bool
    created_at: datetime


class LabelCreate(BaseModel):
    code: str
    display_name: str
    color: str | None = None
    sort_order: int = 0


class LabelUpdate(BaseModel):
    display_name: str | None = None
    color: str | None = None
    sort_order: int | None = None
    is_active: bool | None = None
