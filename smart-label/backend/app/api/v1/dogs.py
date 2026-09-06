"""
狗档案。现在只有只读列表——狗档案目前全靠样本扫描时按文件名里的 dog 编号
自动建档（见 sample_import_service.py），采集端还没开始带这个信息之前
这张表基本是空的。管理页面（改名字/品种/备注）后续再补，不差这一版。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.dog import Dog
from app.models.user import UserRole
from app.schemas.dog import DogOut
from app.schemas.envelope import ok

router = APIRouter(
    prefix="/dogs", tags=["dogs"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))]
)


@router.get("")
async def list_dogs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Dog).order_by(Dog.dog_code))
    dogs = result.scalars().all()
    return ok([DogOut.model_validate(d).model_dump() for d in dogs])
