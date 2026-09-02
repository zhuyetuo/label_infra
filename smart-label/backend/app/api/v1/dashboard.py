"""统计看板（admin）。TODO：工作量/完成率/驳回率/AI标签修改比例，实时SQL聚合，
数据量级不大暂不建预聚合表（决策见架构文档"其余子系统"一节）。"""

from fastapi import APIRouter, Depends

from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok

router = APIRouter(prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(require_role(UserRole.admin))])


@router.get("/summary")
async def get_summary():
    return ok(None, msg="TODO: 工作量/完成率/驳回率/AI标签修改比例")
