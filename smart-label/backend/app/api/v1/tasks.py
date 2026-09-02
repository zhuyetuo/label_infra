"""
任务认领/心跳/草稿/提交。三角色共用，统一走 apply_task_scope() 过滤（services/task_scope.py），
不允许在这里各自写 WHERE 条件。

TODO 待实现的关键端点（对应架构文档决策②⑥⑧）：
- GET  /tasks                       列表，经 apply_task_scope 过滤
- POST /tasks/{id}/claim             认领：单条原子 UPDATE...WHERE status='PENDING_ASSIGN'，
                                      InnoDB 行锁防止两人抢同一任务
- PATCH /tasks/{id}/heartbeat        续期 lock_expires_at（决策⑦，30分钟一次）
- PUT  /tasks/{id}/draft             保存草稿，UPSERT annotation_records(task_id, round_no)
- POST /tasks/{id}/submit            提交：校验标签不重叠（决策③）后状态流转到 SUBMITTED
"""

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.envelope import ok

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
async def list_tasks(user: User = Depends(get_current_user)):
    return ok([], msg="TODO: 任务列表，经 apply_task_scope 按角色过滤")
