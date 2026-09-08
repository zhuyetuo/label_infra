"""
狗档案。样本扫描时按文件名里的 dog 编号自动建档（见 sample_import_service.py），
这里再补一套手动管理：新建/改名字品种备注/删除，以及在样本页手动把一个样本
关联到某只狗（采集端还没在文件名里带 dog 编号之前，只能靠这个手动关联）。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import BigInteger, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from datetime import date

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.dog import Dog
from app.models.dog_measurement import DogMeasurement
from app.models.sample import Sample
from app.models.user import User, UserRole
from app.schemas.dog import DogCreate, DogOut, DogUpdate, MeasurementIn, MeasurementOut
from app.schemas.envelope import ok

router = APIRouter(
    prefix="/dogs", tags=["dogs"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))]
)


def age_text(birth: date | None, today: date | None = None) -> str | None:
    """
    出生日期 → 「2岁3个月」。年龄不存数字存生日，就是为了它能自己长——
    存「3岁」的话第二年就错了，而且没人会记得回来改。
    """
    if birth is None:
        return None
    today = today or date.today()
    if birth > today:
        return None
    months = (today.year - birth.year) * 12 + (today.month - birth.month)
    if today.day < birth.day:
        months -= 1
    months = max(0, months)
    y, m = divmod(months, 12)
    if y and m:
        return f"{y}岁{m}个月"
    if y:
        return f"{y}岁"
    return f"{m}个月" if m else "不足1个月"


async def _decorate(db: AsyncSession, dogs: list[Dog]) -> list[dict]:
    """给每只狗补上算出来的年龄和最新一次的体重/颈围。

    体重是按次记录的（会变），列表里显示最新那条 + 量的日期；一只狗的记录
    一次查完，不要每行一次查询。
    """
    out: list[dict] = []
    latest: dict[int, DogMeasurement] = {}
    counts: dict[int, int] = {}
    if dogs:
        rows = (
            await db.execute(
                select(DogMeasurement)
                .where(DogMeasurement.dog_id.in_([d.id for d in dogs]))
                .order_by(DogMeasurement.measured_on.asc(), DogMeasurement.id.asc())
            )
        ).scalars().all()
        for r in rows:
            counts[r.dog_id] = counts.get(r.dog_id, 0) + 1
            latest[r.dog_id] = r  # 按日期升序遍历，最后留下的就是最新那条
    for d in dogs:
        item = DogOut.model_validate(d).model_dump()
        m = latest.get(d.id)
        item.update(
            age_text=age_text(d.birth_date),
            latest_weight_kg=m.weight_kg if m else None,
            latest_neck_cm=m.neck_cm if m else None,
            latest_measured_on=m.measured_on if m else None,
            n_measurements=counts.get(d.id, 0),
        )
        out.append(item)
    return out


@router.get("/{dog_id}/measurements")
async def list_measurements(dog_id: int, db: AsyncSession = Depends(get_db)):
    """这只狗的体重/颈围记录，新的在前。"""
    rows = (
        await db.execute(
            select(DogMeasurement)
            .where(DogMeasurement.dog_id == dog_id)
            .order_by(DogMeasurement.measured_on.desc(), DogMeasurement.id.desc())
        )
    ).scalars().all()
    return ok([MeasurementOut.model_validate(r).model_dump() for r in rows])


@router.post("/{dog_id}/measurements")
async def add_measurement(
    dog_id: int, body: MeasurementIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    dog = await db.get(Dog, dog_id)
    if dog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "狗不存在")
    if body.weight_kg is None and body.neck_cm is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "体重和颈围至少填一个")
    row = DogMeasurement(dog_id=dog_id, created_by=user.id, **body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return ok(MeasurementOut.model_validate(row).model_dump())


@router.delete("/{dog_id}/measurements/{measurement_id}")
async def delete_measurement(dog_id: int, measurement_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(DogMeasurement, measurement_id)
    if row is None or row.dog_id != dog_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "记录不存在")
    await db.delete(row)
    await db.commit()
    return ok(msg="已删除")


@router.get("")
async def list_dogs(db: AsyncSession = Depends(get_db)):
    # dog_code 是字符串列，直接按它排会得到 1,10,2,3…；先按数值排、再按文本排，
    # 纯数字编号就是自然顺序，带字母的编号（CAST 成 0）会归到最前面并按文本排
    result = await db.execute(select(Dog).order_by(cast(Dog.dog_code, BigInteger), Dog.dog_code))
    return ok(await _decorate(db, list(result.scalars().all())))


@router.post("")
async def create_dog(body: DogCreate, db: AsyncSession = Depends(get_db)):
    exists = await db.execute(select(Dog).where(Dog.dog_code == body.dog_code))
    if exists.scalar_one_or_none() is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "该编号已存在")
    dog = Dog(**body.model_dump())
    db.add(dog)
    await db.commit()
    await db.refresh(dog)
    return ok(DogOut.model_validate(dog).model_dump())


@router.patch("/{dog_id}")
async def update_dog(dog_id: int, body: DogUpdate, db: AsyncSession = Depends(get_db)):
    dog = await db.get(Dog, dog_id)
    if dog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "狗不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(dog, field, value)
    await db.commit()
    await db.refresh(dog)
    return ok(DogOut.model_validate(dog).model_dump())


@router.delete("/{dog_id}")
async def delete_dog(dog_id: int, db: AsyncSession = Depends(get_db)):
    dog = await db.get(Dog, dog_id)
    if dog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "狗不存在")
    linked = (
        await db.execute(select(func.count()).select_from(Sample).where(Sample.dog_id == dog_id))
    ).scalar_one()
    if linked:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"还有 {linked} 个样本关联着这只狗，不能删除")
    await db.delete(dog)
    await db.commit()
    return ok(msg="已删除")
