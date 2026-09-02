"""
框选生成clip。TODO：
- POST /clips/requests   框选时间段，立即202返回group_id（不阻塞请求线程），
                         按(sample,source,camera_channel,时间段)幂等去重写入 clip_jobs
- GET  /clips/requests/{group_id}         轮询兜底
- GET  /clips/requests/{group_id}/events  SSE，worker完成后推送（决策①）
"""

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.schemas.envelope import ok

router = APIRouter(prefix="/clips", tags=["clips"], dependencies=[Depends(get_current_user)])


@router.get("/requests/{group_id}")
async def get_clip_status(group_id: str):
    return ok(None, msg="TODO: clip任务状态查询")
