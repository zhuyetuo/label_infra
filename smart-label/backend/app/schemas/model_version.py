from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.model_version import ModelTrainStatus


class DatasetSpecIn(BaseModel):
    date: str
    extra_date: list[str] = []
    missing_strategy: str | None = None
    skip_syn: bool = False


class TrainSubmitIn(BaseModel):
    dataset: DatasetSpecIn
    model_type: str = "rf"
    tag: str | None = None


class ModelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    algo_job_id: int
    status: ModelTrainStatus
    model_type: str
    model_version: str | None
    model_path: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime


class PrelabelEvent(BaseModel):
    behavior_type: int
    behavior_name: str
    start_time: int
    end_time: int
    confidence: float


class PrelabelResult(BaseModel):
    sample_id: int
    ai_label_path: str
    events: list[PrelabelEvent]
    scratch_count: int
