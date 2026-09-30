"""统计看板（admin）。TODO：工作量/完成率/驳回率/AI标签修改比例，实时SQL聚合，
数据量级不大暂不建预聚合表（决策见架构文档"其余子系统"一节）。"""

import datetime as _dt

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_role
from app.db.session import get_db
from app.models.user import UserRole
from app.schemas.envelope import ok
from app.services.annotator_work_service import annotator_work, project_progress

router = APIRouter(prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])


@router.get("/summary")
async def get_summary():
    return ok(None, msg="TODO: 工作量/完成率/驳回率/AI标签修改比例")


@router.get("/annotator-work")
async def get_annotator_work(date_from: _dt.date, date_to: _dt.date, user_id: int | None = None,
                             db: AsyncSession = Depends(get_db)):
    """标注员工作量明细：这段日期里每一条提交（谁、哪个任务、几点交的、用了多久、几段）。
    按分钟/小时/天怎么汇总交给前端，明细一条不少地给出去。"""
    return ok(await annotator_work(db, date_from, date_to, user_id))


@router.get("/project-progress")
async def get_project_progress(db: AsyncSession = Depends(get_db)):
    """每个启用中的项目：任务交了几个、抓挠片段还有几段没确认、疑似候选还有几条没判。"""
    return ok(await project_progress(db))
