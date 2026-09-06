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
