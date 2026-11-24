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
from app.services import algo_client, edge_client
from app.services.model_eval_service import (
    diff_versions,
    evaluate,
    eval_run_progress,
    get_test_set_recorded_runs,
    list_runs,
    remove_test_set_run,
    start_eval_run,
)

router = APIRouter(
    prefix="/model-eval",
    tags=["model-eval"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)

_EVAL_SET_ACTION = "model_eval.set"


async def _reviewed_in_range(db: AsyncSession, date_from: _dt.date, date_to: _dt.date) -> list[int]:
    """日期范围里**人工审过**的样本。没审过的样本没有正确答案，拿来评测的话
    模型在上面标的每一段都会被算成误报——冻结、跑批、出报告三处必须是同一批。"""
    rows = await db.execute(
        select(Sample.id)
        .join(Task, Task.sample_id == Sample.id)
        .where(
            Sample.session_date >= date_from,
            Sample.session_date <= date_to,
            Task.status.in_([TaskStatus.SUBMITTED, TaskStatus.APPROVED]),
        )
        .distinct()
    )
    return [r[0] for r in rows.all()]


async def _scope_ids(
    db: AsyncSession,
    set_id: int | None,
    sample_ids: list[int] | None,
    date_from: _dt.date | None,
    date_to: _dt.date | None,
    project_ids: list[int] | None = None,
    all_projects: bool = False,
) -> list[int]:
    if set_id:
        row = await db.get(AuditLog, set_id)
        if row is None or row.action != _EVAL_SET_ACTION:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "评测集不存在")
        return (json.loads(row.detail or "{}") or {}).get("sample_ids") or []
    if sample_ids:
        return sample_ids
    # 项目范围：不要求人工审过。两版互比看的是"两个模型对同一批数据答得一样不一样"，
    # 不需要正确答案，所以待认领的任务也能比——那恰恰是最需要先看一眼的时候
    if project_ids:
        rows = await db.execute(
            select(Task.sample_id).where(Task.project_id.in_(project_ids)).distinct()
        )
        return [r[0] for r in rows.all()]
    if all_projects:
        rows = await db.execute(select(Task.sample_id).distinct())
        return [r[0] for r in rows.all()]
    if date_from and date_to:
        return await _reviewed_in_range(db, date_from, date_to)
    return []


@router.get("/runs")
async def available_runs(
    set_id: int | None = None,
    test_set_id: int | None = None,
    test_set_ids: str | None = None,
    date_from: _dt.date | None = None,
    date_to: _dt.date | None = None,
    # 逗号分隔："1,2,3"。前端 GET 用 join，避免 axios 把数组拼成 project_ids[]
    # 而 FastAPI 认的是重复键
    project_ids: str | None = None,
    all_projects: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """有哪些 (模型, 版本) 跑过、各覆盖多少样本——对比页的下拉。
    test_set_id / test_set_ids：严格只返回用户在该测试集上明确跑过并记录的模型，未操作过的一概不列。"""
    tids = (
        [test_set_id]
        if test_set_id
        else ([int(x) for x in test_set_ids.split(",") if x.strip().isdigit()] if test_set_ids else [])
    )
    if tids:
        from app.models.model_test import ModelTestItem
        ids = list((await db.execute(
            select(ModelTestItem.sample_id).where(ModelTestItem.set_id.in_(tids)).distinct()
        )).scalars().all())
        recorded = await get_test_set_recorded_runs(db, tids)
        runs = await list_runs(db, ids, allowed_keys=recorded) if (ids and recorded) else []
        return ok({"n_scope": len(ids), "runs": runs})
    pids = [int(x) for x in project_ids.split(",") if x.strip().isdigit()] if project_ids else None
    if set_id or (date_from and date_to) or pids or all_projects:
        ids = await _scope_ids(db, set_id, None, date_from, date_to, pids, all_projects)
        runs = await list_runs(db, ids) if ids else []
        return ok({"n_scope": len(ids), "runs": runs})
    return ok({"n_scope": None, "runs": await list_runs(db)})


@router.delete("/runs/test-set/{test_set_id}")
async def delete_test_set_run(
    test_set_id: int,
    version_key: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """从某测试集的已跑记录中移除某个（或全部）模型，不再出现在对比下拉里。"""
    remaining = await remove_test_set_run(db, test_set_id, version_key)
    return ok({"runs": remaining})


@router.get("/edge-models")
async def edge_models():
    """端侧服务现在挂着哪些模型，跑批时可以选。

    **问服务，不读配置**：配置跟服务不同步的话，界面上会出现一个选了就报错
    的选项，而错误是"没有这个端侧模型"，绕一圈才知道是配置的事。

    端侧服务没配或者连不上时返回空列表，不是报错——它是可选的，
    没有它整个模型对比功能照常用。
    """
    models = await edge_client.available()
    return ok({
        "enabled": edge_client.enabled(),
        # spec 就是跑批时要传的那个字符串，前端不用自己拼前缀。
        # spec 走跟线上「稳定版 v2」同一份后处理（比的才只是模型）；
        # spec_raw 是端上没有后处理时真实会报的样子，更碎。
        "models": [{
            **m,
            "spec": f"{edge_client.EDGE_PREFIX}{m['tag']}",
            "spec_raw": f"{edge_client.EDGE_PREFIX}{m['tag']}@raw",
            # 整条链都是板上那份 C（模型 + 推理 + 后处理）。
            # 没有板子的时候，这一列才是"板子会报什么"
            "spec_board": f"{edge_client.EDGE_PREFIX}{m['tag']}@board",
        } for m in models],
    })


@router.get("/server-models")
async def server_models():
    """AI 服务（imu_train 的 label_service）现在挂着哪些模型。

    跟 /edge-models 是**两回事**：那边跑的是烧进项圈的那份 C，这边跑的是
    服务器上的 sklearn。一个只用加速计的实验模型属于这边，不属于那边——
    放错组的话，人会以为它是板子会跑的东西。

    默认那个模型（is_default）就是界面上「线上模型」那三行用的，
    **不用在下拉里重复列一遍**；这里列出来是为了让人知道默认的是哪一份。

    服务是老版本（没有 /models 这个端点）时返回空列表，不是报错——
    多模型是可选功能，没有它下拉跟以前一模一样。
    """
    models = await algo_client.models()
    return ok({
        # spec 就是跑批时要传的那个字符串，前端不用自己拼前缀。
        # 默认模型不给 spec：它就是「稳定版 / 稳定版 v2 / 调试版」那三行，
        # 再给一个 srv:default 会变成同一个东西有两种写法，
        # 而两种写法存进库里是两个不同的 model_tag，对比表里会分成两列
        "models": [{
            **m,
            "spec": None if m.get("is_default")
                    else f"{algo_client.SRV_PREFIX}{m['tag']}",
            "spec_raw": None if m.get("is_default")
                        else f"{algo_client.SRV_PREFIX}{m['tag']}@raw",
            "spec_stable": None if m.get("is_default")
                           else f"{algo_client.SRV_PREFIX}{m['tag']}@stable",
        } for m in models],
    })


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
        ids = await _reviewed_in_range(db, body.date_from, body.date_to)
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这个范围里没有人工审核过的样本，没法当评测集")
    detail = {
        "name": body.name,
        "sample_ids": ids,
        "note": body.note,
        "date_from": body.date_from.isoformat() if body.date_from else None,
        "date_to": body.date_to.isoformat() if body.date_to else None,
    }
    row = AuditLog(
        user_id=user.id,
        action=_EVAL_SET_ACTION,
        target_type="model_eval",
        target_id=0,
        detail=json.dumps(detail, ensure_ascii=False),
    )
    db.add(row)
    await db.commit()
    # 带上 id：前端冻完直接选中它，不用再去下拉里找
    return ok({"id": row.id, "name": body.name, "n_samples": len(ids)})


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


class WindowIn(BaseModel):
    sample_id: int
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


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
    # 给了就只算这些时间窗口里的（模型测试集：挑的是样本里的一段）
    windows: list[WindowIn] | None = None
    # 给了就只拿这些任务的标注当正确答案（模型测试集自己的任务；同一个样本在别的项目里的不算）
    task_ids: list[int] | None = None
    include_curve: bool = True


def _windows_of(ws: list[WindowIn] | None) -> dict[int, list[tuple[int, int]]] | None:
    if ws is None:
        return None
    out: dict[int, list[tuple[int, int]]] = {}
    for w in ws:
        if w.end_ms > w.start_ms:
            out.setdefault(w.sample_id, []).append((w.start_ms, w.end_ms))
    return out


@router.post("/compare")
async def compare(body: CompareIn, db: AsyncSession = Depends(get_db)):
    ids = await _scope_ids(db, body.set_id, body.sample_ids, body.date_from, body.date_to)
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "没有选中样本：选评测集，或者换个有人工审核过样本的日期范围")
    return ok(
        await evaluate(
            db,
            ids,
            [v.model_dump() for v in body.versions],
            label=body.label,
            iou_min=body.iou_min,
            conf_min=body.conf_min,
            windows=_windows_of(body.windows),
            truth_task_ids=body.task_ids,
            include_curve=body.include_curve,
        )
    )


class EvalRunIn(BaseModel):
    set_id: int | None = None
    test_set_id: int | None = None
    sample_ids: list[int] | None = None
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    # 按项目圈范围：单个项目、多选项目、或者全部项目。两版互比不用人工标注，
    # 所以这个范围不要求任务已经审过
    project_ids: list[int] | None = None
    all_projects: bool = False
    # 要跑哪几个版本，一次可以全跑：["stable", "viterbi", "raw"]。
    # 端侧模型也写在这里，形如 "edge:edge_cnn_i8"——它跟 mode 是平级的，
    # 都是"同一批样本、另一种算法"，对比逻辑完全一样。
    # 可选的标签从 GET /model-eval/edge-models 拿。
    modes: list[str] = Field(..., min_length=1)


@router.post("/run")
async def run_eval(
    body: EvalRunIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    几个版本对同一批样本各跑一遍，结果按 (模型, 版本) 分开存，不写任何草稿。

    跟项目页的「批量 AI 预标注」是两回事：那个是给标注员铺草稿（一个任务只能
    有一份），这个纯粹攒对比数据，几个版本并存。
    """
    ids = await _scope_ids(
        db, body.set_id, body.sample_ids, body.date_from, body.date_to,
        body.project_ids, body.all_projects,
    )
    if not ids and body.test_set_id:
        from app.models.model_test import ModelTestItem
        ids = list((await db.execute(
            select(ModelTestItem.sample_id).where(ModelTestItem.set_id == body.test_set_id).distinct()
        )).scalars().all())
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "没有选中样本：选评测集、日期范围或者项目")
    started = await start_eval_run(ids, body.modes, test_set_id=body.test_set_id, user_id=user.id)
    return ok({"started": started, "n_samples": len(ids), "modes": body.modes})


@router.get("/run/progress")
async def run_progress():
    return ok(eval_run_progress())


class ABDiffIn(BaseModel):
    """两版互比：同一批样本，模型 A/B 各跑一遍，看两边答得一样不一样。

    不需要人工标注——A 和 B 互相就是参照物。所以范围可以是任意项目，
    包括一条都还没审过的项目。
    """
    set_id: int | None = None
    sample_ids: list[int] | None = None
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    project_ids: list[int] | None = None
    all_projects: bool = False
    a: VersionRef
    b: VersionRef
    # 不传 = 比全部类别。只看一个类别的话比不出"类别一不一致"
    label: str | None = None
    # 两边片段重叠多少算"同一段"。0.3 宽松；想专门看边界就把这个调高
    iou_min: float = 0.3
    # 分歧样本最多列多少个（按分歧数排序）。全部项目三万多个样本全列出来
    # 浏览器也扛不住
    max_samples: int = Field(default=30, ge=1, le=200)


@router.post("/diff")
async def diff(body: ABDiffIn, db: AsyncSession = Depends(get_db)):
    ids = await _scope_ids(
        db, body.set_id, body.sample_ids, body.date_from, body.date_to,
        body.project_ids, body.all_projects,
    )
    if not ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "没有选中样本：选项目、评测集或者日期范围")
    return ok(
        await diff_versions(
            db,
            ids,
            body.a.model_dump(),
            body.b.model_dump(),
            label=body.label,
            iou_min=body.iou_min,
            max_samples=body.max_samples,
        )
    )
