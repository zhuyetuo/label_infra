"""样本导入/查询（admin）。扫描 NAS data_raw/ 目录，按会话分组3路视频+IMU CSV写入 samples 表。"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.sample import Sample
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.sample import SampleOut
from app.services.sample_import_service import scan_and_import

router = APIRouter(prefix="/samples", tags=["samples"], dependencies=[Depends(require_role(UserRole.admin))])


@router.get("")
async def list_samples(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Sample).order_by(Sample.created_at.desc()))
    samples = result.scalars().all()
    return ok([SampleOut.model_validate(s).model_dump() for s in samples])


@router.post("/import-scan")
async def import_scan(db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)):
    """
    扫描 NAS_ROOT/data_raw/ 下的原始文件，按会话前缀分组，新会话写入 samples 表
    （已存在 sample_code 的会话会被跳过，可反复调用做增量导入）。
    """
    result = await scan_and_import(db, settings.nas_root, admin)
    return ok(result.model_dump())
