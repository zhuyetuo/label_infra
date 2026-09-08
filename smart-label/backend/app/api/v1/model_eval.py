"""
模型评测：同一批数据，不同模型/不同版本跟人工标注比一比，看谁准、哪里退步了。

评测集（golden set）就是「一批冻结下来的样本」：挑一批已经人工审完的存成一个
名字，以后每训一个模型都对这同一批跑一遍——数据不变，指标才可比。存在
audit_logs 里，跟批量预标注的运行记录一个做法：这种东西不值得单开一张表，
用一次就查一次，量也小。
"""

import datetime as _dt
import json

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services.model_eval_service import evaluate, eval_run_progress, list_runs, start_eval_run

router = APIRouter(
    prefix="/model-eval",
    tags=["model-eval"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)

_EVAL_SET_ACTION = "model_eval.set"


@router.get("/runs")
async def available_runs(db: AsyncSession = Depends(get_db)):
    """有哪些 (模型, 版本) 跑过、各覆盖多少样本——对比页的下拉。"""
    return ok(await list_runs(db))


class EvalSetIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    # 不传就按日期范围里"有人工标注过的样本"自动挑
    sample_ids: list[int] | None = None
    note: str | None = None


@router.post("/sets")
async def create_set(body: EvalSetIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """
    冻结一批样本当评测集。

    冻结的意义在于「同一批数据」——每次训完模型都拿它跑一遍，指标才有可比性。
    要是每次评测的数据都不一样，指标涨跌根本说不清是模型变好了还是这批数据简单。
    """
    ids = body.sample_ids
    if not ids:
        if not (body.date_from and body.date_to):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要么直接给 sample_ids，要么给日期范围")
        rows = await db.execute(
            select(Sample.id)
            .join(Task, Task.sample_id == Sample.id)
            .where(
                Sample.session_date >= body.date_from,
                Sample.session_date <= body.date_to,
                Task.status.in_([TaskStatus.SUBMITTED, TaskStatus.APPROVED]),
            )
            .distinct()
        )
        ids = [r[0] for r in rows.all()]
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这个范围里没有人工审核过的样本，没法当评测集")
    detail = {
        "name": body.name,
        "sample_ids": ids,
        "note": body.note,
        "date_from": body.date_from.isoformat() if body.date_from else None,
        "date_to": body.date_to.isoformat() if body.date_to else None,
    }
    db.add(
        AuditLog(
            user_id=user.id,
            action=_EVAL_SET_ACTION,
            target_type="model_eval",
            target_id=0,
            detail=json.dumps(detail, ensure_ascii=False),
        )
    )
    await db.commit()
    return ok({"name": body.name, "n_samples": len(ids)})


@router.get("/sets")
async def list_sets(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(AuditLog).where(AuditLog.action == _EVAL_SET_ACTION).order_by(AuditLog.id.desc()).limit(50)
        )
    ).scalars().all()
    out = []
    for r in rows:
        try:
            d = json.loads(r.detail or "{}")
        except ValueError:
            continue
        out.append(
            {
                "id": r.id,
                "name": d.get("name"),
                "n_samples": len(d.get("sample_ids") or []),
                "sample_ids": d.get("sample_ids") or [],
                "note": d.get("note"),
                "created_at": r.created_at.isoformat(sep=" ", timespec="seconds") if r.created_at else None,
            }
        )
    return ok(out)


class VersionRef(BaseModel):
    model_tag: str
    mode: str


class CompareIn(BaseModel):
    # 三选一：评测集 id / 直接给样本 / 日期范围
    set_id: int | None = None
    sample_ids: list[int] | None = None
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    versions: list[VersionRef] = Field(..., min_length=1)
    label: str = "抓挠"
    # 配对判定：重叠多少算"同一段"。0.3 比较宽松，起止差一点也认；
    # 想严格考察边界就调到 0.5+
    iou_min: float = 0.3
    conf_min: float = 0.0


@router.post("/compare")
async def compare(body: CompareIn, db: AsyncSession = Depends(get_db)):
    ids = body.sample_ids or []
    if body.set_id:
        row = await db.get(AuditLog, body.set_id)
        if row is None or row.action != _EVAL_SET_ACTION:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "评测集不存在")
        ids = (json.loads(row.detail or "{}") or {}).get("sample_ids") or []
    if not ids and body.date_from and body.date_to:
        rows = await db.execute(
            select(Sample.id).where(Sample.session_date >= body.date_from, Sample.session_date <= body.date_to)
        )
        ids = [r[0] for r in rows.all()]
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "没有选中样本：给 set_id、sample_ids 或日期范围")
    return ok(
        await evaluate(
            db,
            ids,
            [v.model_dump() for v in body.versions],
            label=body.label,
            iou_min=body.iou_min,
            conf_min=body.conf_min,
        )
    )


class EvalRunIn(BaseModel):
    set_id: int | None = None
    sample_ids: list[int] | None = None
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    # 要跑哪几个版本，一次可以全跑：["stable", "viterbi", "raw"]
    modes: list[str] = Field(..., min_length=1)


@router.post("/run")
async def run_eval(body: EvalRunIn, db: AsyncSession = Depends(get_db)):
    """
    几个版本对同一批样本各跑一遍，结果按 (模型, 版本) 分开存，不写任何草稿。

    跟项目页的「批量 AI 预标注」是两回事：那个是给标注员铺草稿（一个任务只能
    有一份），这个纯粹攒对比数据，几个版本并存。
    """
    ids = body.sample_ids or []
    if body.set_id:
        row = await db.get(AuditLog, body.set_id)
        if row is None or row.action != _EVAL_SET_ACTION:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "评测集不存在")
        ids = (json.loads(row.detail or "{}") or {}).get("sample_ids") or []
    if not ids and body.date_from and body.date_to:
        rows = await db.execute(
            select(Sample.id).where(Sample.session_date >= body.date_from, Sample.session_date <= body.date_to)
        )
        ids = [r[0] for r in rows.all()]
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "没有选中样本")
    started = await start_eval_run(ids, body.modes)
    return ok({"started": started, "n_samples": len(ids), "modes": body.modes})


@router.get("/run/progress")
async def run_progress():
    return ok(eval_run_progress())
