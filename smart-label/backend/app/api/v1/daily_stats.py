"""日常统计：每只狗每天各类行为多久、多少次。

跟皮肤评估平级，不是它的子页——那个回答"皮肤有没有风险"，这个回答
"这只狗今天过得怎么样"。详见 services/daily_stats_service.py 开头。
"""

import datetime as _dt

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.user import UserRole
from app.schemas.envelope import ok
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.core.deps import get_current_user
from app.core.media_token import issue_media_token, verify_media_token
from app.models.cam_region import CamRegion
from app.models.sample import Sample
from app.models.user import User
from app.services import daily_stats_service as svc
from app.services import room_presence_service as room_svc
from app.services import vision_sam_client

router = APIRouter(
    prefix="/daily-stats",
    tags=["daily-stats"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


@router.get("/versions")
async def list_versions(db: AsyncSession = Depends(get_db)):
    """跑过哪些 (模型, 版本)。前端拿它做下拉，不写死。"""
    return ok(await svc.versions(db))


@router.get("/dogs")
async def list_dogs(db: AsyncSession = Depends(get_db)):
    """能筛的狗（含它们的设备号）。"""
    return ok(await svc.dogs(db))


@router.get("/rooms")
async def rooms(
    date_from: _dt.date = Query(...),
    date_to: _dt.date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """狗场单间：按摄像头算录了多久、画面里有狗多久。不按 IMU 算——一只狗两个项圈
    同时录，按样本加就是双倍。同一段视频只算一次。见 room_presence_service.py。"""
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "日期范围反了")
    if (date_to - date_from).days > 400:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "一次最多查 400 天")
    return ok(await room_svc.rooms(db, date_from, date_to))


@router.post("/rooms/scan")
async def rooms_scan(date_from: _dt.date = Query(...), date_to: _dt.date = Query(...),
                     force: bool = Query(False, description="连扫过的也重扫")):
    """后台把这段日期里没扫过的单间画面扫一遍（几路并行，一段几秒）。已有在跑的不重复起。"""
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "日期范围反了")
    return ok(await room_svc.start_scan(date_from, date_to, force=force))


@router.get("/rooms/scan/status")
async def rooms_scan_status():
    return ok(room_svc.scan_status())


@router.post("/rooms/scan/pause")
async def rooms_scan_pause():
    """暂停：正在扫的那几段扫完就停，不再取下一段。"""
    return ok(room_svc.pause_scan())


@router.post("/rooms/scan/resume")
async def rooms_scan_resume():
    return ok(room_svc.resume_scan())


@router.post("/rooms/scan/cancel")
async def rooms_scan_cancel():
    """取消：正在扫的那几段扫完就收，剩下的不扫；已扫完的结果留着。"""
    return ok(room_svc.cancel_scan())


@router.post("/rooms/scan-one")
async def rooms_scan_one(sample_id: int = Query(...), slot: str = Query("cam1"), db: AsyncSession = Depends(get_db)):
    """单独扫一段：同步等结果，一小时的视频几秒钟。"""
    if slot not in ("cam1", "cam2", "cam3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "slot 只能是 cam1 / cam2 / cam3")
    try:
        return ok(await room_svc.scan_one(db, sample_id, slot))
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    except Exception as e:  # noqa: BLE001 视觉服务的错原样带给人看
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"扫描失败：{type(e).__name__}: {e}") from e


# ── 公用机位（天花板 cam7）画面里每个单间占哪一块 ────────────────────────────

class RegionIn(BaseModel):
    room: int = Field(..., ge=1, le=99)
    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)
    w: float = Field(..., gt=0, le=1)
    h: float = Field(..., gt=0, le=1)


class RegionsIn(BaseModel):
    site: str = Field("gouchang", max_length=20)
    cam: int = Field(..., ge=1, le=99)
    regions: list[RegionIn] = Field(default_factory=list, max_length=50)


@router.get("/rooms/regions")
async def get_regions(site: str = "gouchang", db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(CamRegion).where(CamRegion.site == site).order_by(CamRegion.cam, CamRegion.room))).scalars().all()
    return ok([{"site": r.site, "cam": r.cam, "room": r.room, "x": r.x, "y": r.y, "w": r.w, "h": r.h} for r in rows])


@router.put("/rooms/regions")
async def put_regions(body: RegionsIn, db: AsyncSession = Depends(get_db)):
    """整组替换这个场地这个公用机位的区域划分。"""
    rooms_seen = {r.room for r in body.regions}
    if len(rooms_seen) != len(body.regions):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "同一个房间画了两块")
    await db.execute(delete(CamRegion).where(CamRegion.site == body.site, CamRegion.cam == body.cam))
    for r in body.regions:
        db.add(CamRegion(site=body.site, cam=body.cam, room=r.room, x=r.x, y=r.y, w=r.w, h=r.h))
    await db.commit()
    return ok({"saved": len(body.regions)})


@router.post("/rooms/frame-token")
async def frame_token(sample_id: int = Query(...), user: User = Depends(get_current_user)):
    """<img> 带不了 Authorization：换个短期 token 拼进取帧地址里。"""
    return ok({"token": issue_media_token(sample_id)})


# <img> 带不上 Authorization 头，取帧走 token 校验，不能挂在要角色的 router 上
open_router = APIRouter(prefix="/daily-stats", tags=["daily-stats"])


@open_router.get("/rooms/frame")
async def frame(sample_id: int = Query(...), slot: str = Query("cam1"), t: float = Query(0.0, ge=0),
                token: str = Query(...), db: AsyncSession = Depends(get_db)):
    """某份样本某一路某一秒的整帧（带狗框），给划区域用。"""
    from fastapi.responses import Response

    if not verify_media_token(sample_id, token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token 无效或过期")
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")
    path = {"cam1": sample.video_cam1_path, "cam2": sample.video_cam2_path, "cam3": sample.video_cam3_path}.get(slot)
    if not path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"这份样本没有 {slot} 这一路")
    try:
        data = await vision_sam_client.embed_thumb(path, t, crop=False, max_side=1280)
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.get("")
async def daily(
    date_from: _dt.date = Query(...),
    date_to: _dt.date = Query(...),
    model_tag: str = Query(..., description="哪个模型，从 /versions 拿"),
    mode: str = Query(..., description="哪个版本（stable/viterbi/raw/board）"),
    imus: str = Query("", description="设备号，逗号分隔（IMU5 或 5 都认）；空 = 全部狗"),
    db: AsyncSession = Depends(get_db),
):
    """按 (日期, 狗) 汇总。

    **必须指定模型和版本**，不给默认值：一天里的样本可能是不同版本跑的，
    混着加起来会得到一个悄悄把两个版本平均掉的数字，而它看起来完全正常。
    """
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "日期范围反了")
    if (date_to - date_from).days > 400:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "一次最多查 400 天")
    keys = [x.strip() for x in imus.split(",") if x.strip()]
    return ok(await svc.daily(db, date_from, date_to, model_tag, mode, keys or None))
