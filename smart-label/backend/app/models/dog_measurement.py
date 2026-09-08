from datetime import date as _date
from datetime import datetime

from sqlalchemy import BigInteger, Date, DateTime, Float, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DogMeasurement(Base):
    """
    一次称重/量围度的记录。

    体重不是狗的固定属性——它会变，而且「什么时候几公斤」本身就是要看的东西
    （掉秤、长胖都跟皮肤状况有关系）。所以不能在 dogs 表上放一个 weight 字段
    覆盖来覆盖去，得一次一条存着，档案里显示最新一条、展开能看变化。

    颈围同理（项圈松紧、会不会蹭到皮肤都跟它有关），没量就留空，不强制。
    """

    __tablename__ = "dog_measurements"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dog_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("dogs.id"), nullable=False, index=True)
    # 量的那天，不是录入那天——补录以前的数据时这两个不是一回事
    measured_on: Mapped[_date] = mapped_column(Date, nullable=False)
    weight_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    neck_cm: Mapped[float | None] = mapped_column(Float, nullable=True, comment="脖子围度")
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)

    created_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
