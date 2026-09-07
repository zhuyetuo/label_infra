"""
素材库相册浏览（只读）：album=oral 口腔照片 / skin 皮肤瘙痒问诊照片，两者在 NAS 上都是
{日期-ok}/{狗}/*.jpg 的结构，共用 tooth_service 里的扫描/路径签名逻辑。牙齿识别页用
/tooth/photos（带检测结果），皮肤评估页用这里的 /material/skin/photos（纯看图）。
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok
from app.services import tooth_service as svc
from app.services.range_stream import stream_file

router = APIRouter(prefix="/material", tags=["material"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
stream_router = APIRouter(prefix="/material", tags=["material"])

_CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp"}


@router.get("/{album}/photos")
async def list_photos(album: str):
    try:
        return ok({"root": svc.album_root(album), "folders": svc.list_photos(album)})
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e


@router.post("/{album}/photos/token")
async def photo_token(album: str, body: dict):
    rel_path = body.get("path") or ""
    try:
        svc.resolve_photo(rel_path, album)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    return ok({"token": svc.issue_photo_token(rel_path, album)})


@stream_router.get("/{album}/photos/stream")
async def photo_stream(album: str, path: str, token: str, request: Request):
    if not svc.verify_photo_token(path, token, album):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "token 无效或已过期")
    try:
        full = svc.resolve_photo(path, album)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    ext = full[full.rfind("."):].lower()
    return await stream_file(request, full, _CONTENT_TYPES.get(ext, "application/octet-stream"))
