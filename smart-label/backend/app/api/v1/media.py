from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.core.media_token import issue_media_token, verify_media_token
from app.db.session import get_db
from app.models.media_file import MediaFile
from app.models.user import User
from app.schemas.envelope import ok
from app.services.media_resolver import PathTraversalError, resolve_nas_path
from app.services.range_stream import stream_file

router = APIRouter(prefix="/media", tags=["media"])


@router.post("/{file_id}/token")
async def get_media_token(
    file_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """
    <video>/<img> 标签无法带 Authorization 头，前端进入任务页时先换一个短期媒体token，
    再拼进 <video src="/api/media/{id}/stream?token=..."> 里。

    TODO: 当前只校验"已登录"，未校验 user 是否真的有权限访问 file_id 对应的样本/任务
    （需要 media_files 关联回 sample_id/task_id，再走 apply_task_scope 同一套规则校验）。
    """
    media = await db.get(MediaFile, file_id)
    if media is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在")
    token = issue_media_token(file_id)
    return ok({"token": token})


@router.get("/{file_id}/stream")
async def stream_media(file_id: int, token: str, request: Request, db: AsyncSession = Depends(get_db)):
    # 注意：这个端点不走 Authorization 头鉴权（<video>标签做不到），
    # 完全依赖 URL 上的短期签名 media token，验签纯本地不查库。
    if not verify_media_token(file_id, token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "media token 无效或已过期")

    media = await db.get(MediaFile, file_id)
    if media is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在")

    try:
        real_path = resolve_nas_path(media.relative_path)
    except PathTraversalError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "非法路径") from None

    return await stream_file(request, real_path, media.content_type)
