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


def _floats(v: str | None) -> list[float] | None:
    return [float(x) for x in v.split(",") if x.strip()] if v else None


def _qfilter(project_ids: str | None = None, dog_ids: str | None = None, task_ids: str | None = None,
             date_from: date | None = None, date_to: date | None = None, sample_hz: str | None = None,
             min_sec: float | None = None, label_names: str | None = None) -> data_pool.PoolFilter:
    """GET 的筛选参数：多个值逗号分隔"""
    return data_pool.PoolFilter(
        project_ids=_ids(project_ids), dog_ids=_ids(dog_ids), task_ids=_ids(task_ids),
        date_from=date_from, date_to=date_to, sample_hz=_floats(sample_hz), min_sec=min_sec,
        label_names=[x for x in label_names.split(",") if x.strip()] if label_names else None)


@router.get("/summary")
async def get_summary(f: data_pool.PoolFilter = Depends(_qfilter),
                      db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return ok(await data_pool.summary(db, f))


@router.get("/items")
async def get_items(f: data_pool.PoolFilter = Depends(_qfilter), sort: str = "long", page: int = 1, page_size: int = 50,
                    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """池里一条一条的片段（分页）"""
    return ok(await data_pool.list_items(db, f, sort, page, page_size))


class PoolFilterIn(BaseModel):
    project_ids: list[int] | None = None
    dog_ids: list[int] | None = None
    task_ids: list[int] | None = None
    date_from: date | None = None
    date_to: date | None = None
    sample_hz: list[float] | None = None
    min_sec: float | None = None
    label_names: list[str] | None = None

    def to_filter(self) -> data_pool.PoolFilter:
        return data_pool.PoolFilter(**self.model_dump(include=set(data_pool.PoolFilter.__dataclass_fields__)))


class PoolAddIn(PoolFilterIn):
    # reviewed = 人确认过 / 改过 / 人工加的；approved_tasks = 审核通过的任务整份；
    # submitted = 已提交 / 通过的任务整份；all = 全部（一般配 task_ids）
    source: str = "reviewed"


class PoolRemoveIn(PoolFilterIn):
    item_ids: list[int] | None = None


@router.post("/add")
async def post_add(body: PoolAddIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _require_curator(user)
    f = body.to_filter()
    if not f.any():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "整批加入要先选任务 / 项目 / 狗 / 日期，别一下子把全部加进去")
    try:
        n = await data_pool.add(db, body.source, f)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    return ok({"added": n})


@router.post("/remove")
async def post_remove(body: PoolRemoveIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _require_curator(user)
    f = body.to_filter()
    if not (body.item_ids or f.any()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "移出要指定片段或条件")
    n = await data_pool.remove(db, f, body.item_ids)
    return ok({"removed": n})


class CompareIn(BaseModel):
    a: list[str]
    b: list[str]
    project_ids: list[int] | None = None
    pool_only: bool = True
    win_s: float = 10.0
    max_segments: int = 80


@router.post("/compare")
async def post_compare(body: CompareIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """两类片段的原始 IMU 数据逐个维度对比（见 services/class_compare）"""
    from app.services import class_compare

    _require_curator(user)
    if not body.a or not body.b:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "两边都要选类别")
    win_s = min(max(body.win_s, 1.0), 120.0)
    n = min(max(body.max_segments, 5), 300)
    return ok(await class_compare.compare(db, body.a, body.b, body.project_ids, body.pool_only, win_s, n))


@router.post("/compare-preview")
async def post_compare_preview(body: CompareIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """对比之前先看两类各有多少数据能用（不读 CSV，很快）"""
    from app.services import class_compare

    _require_curator(user)
    win_s = min(max(body.win_s, 1.0), 120.0)
    return ok({
        "a": await class_compare.preview(db, body.a, body.project_ids, body.pool_only, win_s),
        "b": await class_compare.preview(db, body.b, body.project_ids, body.pool_only, win_s),
    })
