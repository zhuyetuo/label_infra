"""
狗档案。样本扫描时按文件名里的 dog 编号自动建档（见 sample_import_service.py），
这里再补一套手动管理：新建/改名字品种备注/删除，以及在样本页手动把一个样本
关联到某只狗（采集端还没在文件名里带 dog 编号之前，只能靠这个手动关联）。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import BigInteger, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.dog import Dog
from app.models.sample import Sample
from app.models.user import UserRole
from app.schemas.dog import DogCreate, DogOut, DogUpdate
from app.schemas.envelope import ok

router = APIRouter(
    prefix="/dogs", tags=["dogs"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))]
)


@router.get("")
async def list_dogs(db: AsyncSession = Depends(get_db)):
    # dog_code 是字符串列，直接按它排会得到 1,10,2,3…；先按数值排、再按文本排，
    # 纯数字编号就是自然顺序，带字母的编号（CAST 成 0）会归到最前面并按文本排
    result = await db.execute(select(Dog).order_by(cast(Dog.dog_code, BigInteger), Dog.dog_code))
    dogs = result.scalars().all()
    return ok([DogOut.model_validate(d).model_dump() for d in dogs])


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
