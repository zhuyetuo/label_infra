"""机位核对：摄像头重插后，人看画面把「文件里的 camN」改回真实房间。

只给管理员：这一步改的是「这只狗配哪一路画面」，改错了标注员看不出来。
"""

from datetime import date as date_cls

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import cam_map_service

router = APIRouter(
    prefix="/cam-map",
    tags=["cam-map"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


class CamMapIn(BaseModel):
    # {"1": 2, "2": 1, "7": 7}：文件里是 cam1，实际拍的是 2 号单间
    mapping: dict[str, int] = Field(..., description="录制机位号 → 真实机位号")


class CamMapBatchIn(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD")
    # 跟单场同一套「录制机位号 → 真实机位号」，应用到选中的每一场
    mapping: dict[str, int] = Field(..., description="录制机位号 → 真实机位号")
    session_keys: list[str] = Field(..., description="要应用的场次")


@router.get("/sessions")
async def list_sessions(
    date: str | None = Query(None, description="YYYY-MM-DD，不给就用最近有样本的那一天"),
    site: str | None = Query(None, description="布局键（bolangwang / gouchang），不给就全部场地"),
    db: AsyncSession = Depends(get_db),
):
    """一天里每一场录制的机位对照，带画面缩略图需要的 media id。"""
    parsed: str | None = date
    if date:
        try:
            parsed = date_cls.fromisoformat(date).isoformat()
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "日期格式应为 YYYY-MM-DD") from None
    try:
        return ok(await cam_map_service.list_sessions(db, parsed, site))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None


@router.put("/batch")
async def save_batch_mapping(
    body: CamMapBatchIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.admin, UserRole.super_admin)),
):
    """把同一套机位对照一次应用到一天里选中的多场（一天 24 场一条条点太费时间）。"""
    if not body.session_keys:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "至少选一场")
    try:
        result = await cam_map_service.save_batch(db, body.date, body.mapping, body.session_keys, user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return ok(result)


@router.put("/sessions/{session_key}")
async def save_mapping(
    session_key: str,
    body: CamMapIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role(UserRole.admin, UserRole.super_admin)),
):
    """把这一场的机位对照存下来，并重挂这一场所有样本的画面。"""
    try:
        result = await cam_map_service.save_mapping(db, session_key, body.mapping, user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    return ok(result)


@router.delete("/sessions/{session_key}")
async def reset_mapping(session_key: str, db: AsyncSession = Depends(get_db)):
    """恢复成按文件名（采集端配置）算，清掉人工纠正。"""
    try:
        result = await cam_map_service.reset_mapping(db, session_key)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None
    return ok(result)
