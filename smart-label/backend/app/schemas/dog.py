from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class DogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dog_code: str
    name: str | None
    breed: str | None
    imu: str | None
    aliases: str | None
    site: str | None
    size: str | None
    birth_date: date | None
    remark: str | None
    created_at: datetime
    # 下面几个是算出来/查出来的，不是 dogs 表上的列
    age_text: str | None = None
    latest_weight_kg: float | None = None
    latest_neck_cm: float | None = None
    latest_measured_on: date | None = None
    n_measurements: int = 0


class DogCreate(BaseModel):
    dog_code: str
    name: str | None = None
    breed: str | None = None
    imu: str | None = None
    aliases: str | None = None
    site: str | None = None
    size: str | None = None
    birth_date: date | None = None
    remark: str | None = None


class DogUpdate(BaseModel):
    name: str | None = None
    breed: str | None = None
    imu: str | None = None
    aliases: str | None = None
    site: str | None = None
    size: str | None = None
    birth_date: date | None = None
    remark: str | None = None


class MeasurementIn(BaseModel):
    """一次称重/量围度。两个数至少填一个，不然这条记录没意义。"""

    measured_on: date
    weight_kg: float | None = None
    neck_cm: float | None = None
    note: str | None = None


class MeasurementOut(MeasurementIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dog_id: int
    created_at: datetime
