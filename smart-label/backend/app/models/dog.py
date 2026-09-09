from datetime import date as _date
from datetime import datetime

from sqlalchemy import BigInteger, Date, DateTime, String, func
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
    # 这只狗戴的是哪个机位（IMU1…）。样本编号里只有机位号，皮肤评估那边的
    # 「比熊-BB」又是另一套叫法，靠这一列把两边对上
    imu: Mapped[str | None] = mapped_column(String(20), nullable=True, comment="机位号，如 IMU1")
    # 这只狗在哪个场所：影棚 / 狗场。以前塞在备注里，没法按场所筛选和统计
    site: Mapped[str | None] = mapped_column(String(50), nullable=True, comment="场所：影棚 / 狗场")
    # 体型：大 / 中 / 小。不按体重自动分——同样 13kg，法斗是中型，小体金毛是大型幼犬，
    # 光看数字分不出来；而抓挠的幅度和频率跟体型直接相关，得能按它分组看
    size: Mapped[str | None] = mapped_column(String(10), nullable=True, comment="体型：大 / 中 / 小")
    # 存出生日期而不是年龄：年龄天天在长，存下来第二天就不对了
    birth_date: Mapped[_date | None] = mapped_column(Date, nullable=True, comment="出生日期，年龄按它现算")
    # 别名，逗号分隔。NAS 上的照片目录名常常是另一种写法（bibi / Bali / 露露），
    # 匹配照片时任一别名对上就算同一只
    aliases: Mapped[str | None] = mapped_column(String(300), nullable=True, comment="别名，逗号分隔")
    remark: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
