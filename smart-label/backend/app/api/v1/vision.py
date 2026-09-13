"""
视觉标注工作台（雏形）：在素材库的口腔/皮肤照片上画框、打类别、填属性。

跟现有模块的关系：照片列表和图片流完全复用 /material/{album}/*（一行没改），
标注结果落自己的两张表（vision_assets / vision_annotations），不碰 samples /
tasks / annotation_* 任何一张。所以这个页面坏掉不会影响任何现有功能，反过来也一样。

权限跟牙齿识别页一致：admin / super_admin。雏形阶段先不放给标注员——放开要动
task_scope 那一层，那是现有模块。
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.user import User, UserRole
from app.models.vision_annotation import VisionAnnotation, VisionAsset
from app.schemas.envelope import ok
from app.services import tooth_service, vision_service as svc

router = APIRouter(
    prefix="/vision",
    tags=["vision"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


@router.get("/labels")
async def get_labels(album: str = Query("oral")):
    """这个相册用哪套类别、每个框能填哪些属性、图级属性有哪些"""
    try:
        return ok(svc.catalog(album))
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e


@router.get("/photos")
async def list_photos(album: str = Query("oral"), db: AsyncSession = Depends(get_db)):
    """相册目录树，每张图挂上「标了几个框、状态是什么」。

    照片本身走 tooth_service.list_photos（跟 /material 同一个函数），这里只是把
    标注进度贴上去。
    """
    try:
        svc.domain_of(album)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    try:
        folders = tooth_service.list_photos(album)
    except tooth_service.ToothError as e:  # 目录不存在 / 素材库 NAS 没挂上
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e

    counts = dict(
        (
            await db.execute(
                select(VisionAnnotation.rel_path, func.count(VisionAnnotation.id))
                .where(VisionAnnotation.album == album)
                .group_by(VisionAnnotation.rel_path)
            )
        ).all()
    )
    states = {
        r.rel_path: r.state
        for r in (await db.execute(select(VisionAsset).where(VisionAsset.album == album))).scalars().all()
    }
    for folder in folders:
        for dog in folder["dogs"]:
            for p in dog["photos"]:
                p["n_boxes"] = int(counts.get(p["rel_path"], 0))
                p["state"] = states.get(p["rel_path"], "todo")
    return ok({"album": album, "folders": folders})


@router.get("/annotations")
async def get_annotations(album: str = Query("oral"), path: str = Query(...), db: AsyncSession = Depends(get_db)):
    """一张照片上已有的框 + 这张图的状态和图级属性"""
    try:
        svc.check_photo(album, path)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    rows = (
        await db.execute(
            select(VisionAnnotation)
            .where(VisionAnnotation.album == album, VisionAnnotation.rel_path == path)
            .order_by(VisionAnnotation.id)
        )
    ).scalars().all()
    asset = (
        await db.execute(select(VisionAsset).where(VisionAsset.album == album, VisionAsset.rel_path == path))
    ).scalar_one_or_none()
    return ok({
        "items": [svc.annotation_to_dict(r) for r in rows],
        "asset": svc.asset_to_dict(asset) if asset else {
            "album": album, "rel_path": path, "state": "todo",
            "skip_reason": None, "attrs": {}, "width": None, "height": None, "updated_at": None,
        },
    })


class ItemIn(BaseModel):
    label_code: str
    bbox: list[float] = Field(..., min_length=4, max_length=4, description="[x, y, w, h] 归一化 0-1")
    attrs: dict | None = None


class SaveIn(BaseModel):
    album: str = "oral"
    path: str
    items: list[ItemIn] = Field(default_factory=list, max_length=500)
    state: str = Field("done", description="todo / done / skipped")
    skip_reason: str | None = None
    asset_attrs: dict | None = None
    width: int | None = None
    height: int | None = None


@router.put("/annotations")
async def save_annotations(body: SaveIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_role(UserRole.admin, UserRole.super_admin))):
    """整张图的框一次性覆盖保存。

    为什么是整张覆盖而不是逐条增删改：一张图撑死几十个框，整存整取省掉了前端维护
    临时 id、后端做增量 diff 的全部复杂度，也就没有「删了一半网断了」这种半截状态。
    等一张图上百个框了再说。
    """
    try:
        svc.check_photo(body.album, body.path)
        allowed = svc.valid_label_codes(body.album)
        if body.state not in svc.ASSET_STATES:
            raise svc.VisionError(f"state 只能是 {', '.join(svc.ASSET_STATES)}")
        prepared = []
        for it in body.items:
            if it.label_code not in allowed:
                raise svc.VisionError(f"这个相册没有类别 {it.label_code}")
            prepared.append((it.label_code, svc.normalize_bbox(it.bbox), svc.clean_attrs(it.attrs)))
        asset_attrs = svc.clean_attrs(body.asset_attrs)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    await db.execute(
        delete(VisionAnnotation).where(
            VisionAnnotation.album == body.album, VisionAnnotation.rel_path == body.path
        )
    )
    for label_code, bbox, attrs in prepared:
        db.add(VisionAnnotation(
            album=body.album, rel_path=body.path, label_code=label_code,
            bbox=json.dumps(bbox), attrs=attrs,
            source="human", created_by=user.id,
        ))

    asset = (
        await db.execute(select(VisionAsset).where(VisionAsset.album == body.album, VisionAsset.rel_path == body.path))
    ).scalar_one_or_none()
    if asset is None:
        asset = VisionAsset(album=body.album, rel_path=body.path)
        db.add(asset)
    asset.state = body.state
    asset.skip_reason = body.skip_reason
    asset.attrs = asset_attrs
    if body.width:
        asset.width = body.width
    if body.height:
        asset.height = body.height
    asset.updated_by = user.id

    await db.commit()
    return ok({"saved": len(prepared), "state": body.state})


@router.get("/stats")
async def stats(album: str = Query("oral"), db: AsyncSession = Depends(get_db)):
    """标了多少、各类别各多少。看进度用，也是导出前的一眼体检。"""
    try:
        svc.domain_of(album)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    by_label = (
        await db.execute(
            select(VisionAnnotation.label_code, func.count(VisionAnnotation.id))
            .where(VisionAnnotation.album == album)
            .group_by(VisionAnnotation.label_code)
        )
    ).all()
    by_state = (
        await db.execute(
            select(VisionAsset.state, func.count(VisionAsset.id))
            .where(VisionAsset.album == album)
            .group_by(VisionAsset.state)
        )
    ).all()
    return ok({
        "by_label": [{"label_code": c, "n": int(n)} for c, n in by_label],
        "by_state": [{"state": s, "n": int(n)} for s, n in by_state],
        "total_boxes": sum(int(n) for _, n in by_label),
    })
