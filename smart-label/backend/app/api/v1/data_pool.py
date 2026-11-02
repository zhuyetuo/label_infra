"""数据池：看池里有什么、整批手动加入 / 移出。从池里挑一批训练走 /model-versions/datasets（scope=pool）。"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import data_pool

router = APIRouter(prefix="/data-pool", tags=["data-pool"])


def _ids(v: str | None) -> list[int] | None:
    return [int(x) for x in v.split(",") if x.strip()] if v else None


def _require_curator(user: User) -> None:
    # 池子是高质量数据的把关：只有审核员 / 管理员能整批加入、移出
    if user.role not in (UserRole.admin, UserRole.super_admin, UserRole.reviewer):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能改数据池")


@router.get("/summary")
async def get_summary(project_ids: str | None = None, dog_ids: str | None = None,
                      date_from: date | None = None, date_to: date | None = None, sample_hz: str | None = None,
                      min_sec: float | None = None,
                      db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    hz = [float(x) for x in sample_hz.split(",") if x.strip()] if sample_hz else None
    return ok(await data_pool.summary(db, _ids(project_ids), _ids(dog_ids), date_from, date_to, hz, min_sec))


class PoolFilterIn(BaseModel):
    project_ids: list[int] | None = None
    dog_ids: list[int] | None = None
    date_from: date | None = None
    date_to: date | None = None


class PoolAddIn(PoolFilterIn):
    # reviewed = 人确认过 / 改过 / 人工加的；approved_tasks = 审核通过的任务整份
    source: str = "reviewed"


class PoolRemoveIn(PoolFilterIn):
    item_ids: list[int] | None = None
    label_ids: list[int] | None = None
    label_names: list[str] | None = None


@router.post("/add")
async def post_add(body: PoolAddIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _require_curator(user)
    if not body.project_ids and body.date_from is None and body.date_to is None and not body.dog_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "整批加入要先选项目 / 狗 / 日期，别一下子把全部加进去")
    try:
        n = await data_pool.add(db, body.source, body.project_ids, body.dog_ids, body.date_from, body.date_to)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    return ok({"added": n})


@router.post("/remove")
async def post_remove(body: PoolRemoveIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _require_curator(user)
    if not (body.item_ids or body.project_ids or body.dog_ids or body.label_ids or body.label_names
            or body.date_from is not None or body.date_to is not None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "移出要指定片段或条件")
    n = await data_pool.remove(db, body.item_ids, body.project_ids, body.dog_ids, body.date_from, body.date_to,
                               body.label_ids, body.label_names)
    return ok({"removed": n})
