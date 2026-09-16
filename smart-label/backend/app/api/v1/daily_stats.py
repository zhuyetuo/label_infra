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

router = APIRouter(
    prefix="/daily-stats",
    tags=["daily-stats"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


@router.get("/versions")
async def list_versions(db: AsyncSession = Depends(get_db)):
    """跑过哪些 (模型, 版本)。前端拿它做下拉，不写死。"""
    return ok(await svc.versions(db))


@router.get("")
async def daily(
    date_from: _dt.date = Query(...),
    date_to: _dt.date = Query(...),
    model_tag: str = Query(..., description="哪个模型，从 /versions 拿"),
    mode: str = Query(..., description="哪个版本（stable/viterbi/raw/board）"),
    dog_ids: str = Query("", description="逗号分隔；空 = 全部"),
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
    ids = [int(x) for x in dog_ids.split(",") if x.strip().isdigit()]
    return ok(await svc.daily(db, date_from, date_to, model_tag, mode, ids or None))
