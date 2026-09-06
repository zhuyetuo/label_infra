from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Dog(Base):
    """
    狗的档案。dog_code 是采集端/文件名里用的那个编号（比如文件名里 _dog7 的 "7"），
    现在的文件名还没带这个信息，等采集端加上之后，扫描导入时碰到没见过的 dog_code
    会在这里自动建档（先只有编号，名字/品种之类的信息后续在管理页面补）。
    """

    __tablename__ = "dogs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    dog_code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    breed: Mapped[str | None] = mapped_column(String(100), nullable=True)
    remark: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
