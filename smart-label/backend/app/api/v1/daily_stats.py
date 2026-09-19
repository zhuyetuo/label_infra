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
from app.services import daily_stats_service as svc
from app.services import room_presence_service as room_svc

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
