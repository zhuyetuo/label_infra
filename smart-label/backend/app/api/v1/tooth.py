"""
牙齿识别页：浏览素材库 NAS 上的口腔照片（按 日期目录/狗 归类）、看图、跑 YOLO 检测、
看检测结果。检测本身在 imu_train/label_service（tooth_health 那套 YOLO），这边只是
目录浏览 + 转发 + 结果落库。管理员/超管可用。
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.tooth_photo import ToothPhotoResult
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import tooth_service as svc
from app.services.range_stream import stream_file

router = APIRouter(prefix="/tooth", tags=["tooth"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
# <img> 标签带不了 Authorization 头，图片流走 URL 上的短期路径签名 token（跟 media stream 一样）
stream_router = APIRouter(prefix="/tooth", tags=["tooth"])

_CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp"}


@router.get("/photos")
async def list_photos(db: AsyncSession = Depends(get_db)):
    """目录树 + 每张图最近一次检测结果（有的话）"""
    try:
        tree = svc.list_photos()
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    rows = (await db.execute(select(ToothPhotoResult))).scalars().all()
    by_path = {r.rel_path: svc.result_to_dict(r) for r in rows}
    for folder in tree:
        for dog in folder["dogs"]:
            for p in dog["photos"]:
                p["result"] = by_path.get(p["rel_path"])
    return ok({"root": svc.oral_root(), "folders": tree})


@router.post("/photos/token")
async def photo_token(body: dict):
    rel_path = body.get("path") or ""
    try:
        svc.resolve_photo(rel_path)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    return ok({"token": svc.issue_photo_token(rel_path)})


@stream_router.get("/photos/stream")
async def photo_stream(path: str, token: str, request: Request):
    if not svc.verify_photo_token(path, token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "token 无效或已过期")
    try:
        full = svc.resolve_photo(path)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    ext = full[full.rfind("."):].lower()
    return await stream_file(request, full, _CONTENT_TYPES.get(ext, "application/octet-stream"))


class DetectIn(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=500, description="相对 口腔验证/ 的路径")
    conf: float | None = Field(None, ge=0.0, le=0.95, description="置信度阈值，0 = 全部检出都返回")
    with_image: bool = Field(False, description="只有单张查看时才要带框图，批量跑不要")
    top_k: int = Field(1, ge=0, le=50, description="每张图最多保留几个框，默认 1（一张嘴一个结论）；0 = 不限")


@router.post("/detect")
async def detect(body: DetectIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """逐张调 AI 服务检测并落库；单张失败不影响其它，逐项带回 ok/error。
    with_image=true 时把带框图（base64）一并返回给前端直接显示。"""
    results = []
    for rel_path in body.paths:
        try:
            svc.resolve_photo(rel_path)
            data = await svc.detect_remote(rel_path, body.conf, body.with_image, body.top_k)
        except svc.ToothError as e:
            results.append({"rel_path": rel_path, "ok": False, "error": str(e)})
            continue
        dets = data.get("detections") or []
        top_class, top_conf = svc.summarize(dets)
        folder, dog_folder = rel_path.split("/")[0], (rel_path.split("/")[1] if rel_path.count("/") >= 2 else "")
        row = (await db.execute(select(ToothPhotoResult).where(ToothPhotoResult.rel_path == rel_path))).scalar_one_or_none()
        if row is None:
            row = ToothPhotoResult(rel_path=rel_path, folder=folder, dog_folder=dog_folder, detections="[]", model_conf=0)
            db.add(row)
        row.detections = json.dumps(dets, ensure_ascii=False)
        row.n_detections = len(dets)
        row.top_class, row.top_conf = top_class, top_conf
        row.model_conf = float(data.get("conf") or 0)
        row.width, row.height = data.get("width"), data.get("height")
        row.detected_by = user.id
        await db.flush()
        # detected_at 是数据库端 now() 默认值，flush 后是过期属性；不显式 refresh 的话
        # result_to_dict 里一读它就触发同步懒加载 → async 下报 MissingGreenlet
        await db.refresh(row)
        results.append({"rel_path": rel_path, "ok": True, "result": svc.result_to_dict(row),
                        "annotated_jpeg_b64": data.get("annotated_jpeg_b64"), "class_names": data.get("class_names")})
    await db.commit()
    return ok(results)


@router.get("/status")
async def tooth_status():
    """AI 服务那边牙齿模型在不在"""
    import httpx
    from app.core.config import settings
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/tooth/status"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url)
        return ok(resp.json())
    except Exception as e:  # noqa: BLE001
        return ok({"available": False, "error": f"无法连接 AI 服务: {e}"})
