"""
样本导入/查询（admin）。TODO：对接 scripts/import_samples_from_nas.py 扫描结果，
校验4个原始文件是否存在（import_status: pending -> verified/error）。
"""

from fastapi import APIRouter, Depends

from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok

router = APIRouter(prefix="/samples", tags=["samples"], dependencies=[Depends(require_role(UserRole.admin))])


@router.get("")
async def list_samples():
    return ok([], msg="TODO: 样本列表分页查询")
