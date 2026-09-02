"""审核认领/通过/驳回。TODO：POST /reviews/{task_id}/decision，写 review_records，
驳回时 task.round_no += 1、清空 assigned_to、状态回 PENDING_ASSIGN，草稿保留（决策⑧）。"""

from fastapi import APIRouter, Depends

from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok

router = APIRouter(prefix="/reviews", tags=["reviews"], dependencies=[Depends(require_role(UserRole.reviewer, UserRole.admin))])


@router.get("/queue")
async def review_queue():
    return ok([], msg="TODO: 待审核队列")
