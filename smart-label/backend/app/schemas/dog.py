from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dog_code: str
    name: str | None
    breed: str | None
    remark: str | None
    created_at: datetime


class DogCreate(BaseModel):
    dog_code: str
    name: str | None = None
    breed: str | None = None
    remark: str | None = None


class DogUpdate(BaseModel):
    name: str | None = None
    breed: str | None = None
    remark: str | None = None
