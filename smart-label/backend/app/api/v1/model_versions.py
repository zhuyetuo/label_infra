"""
模型训练：提交训练任务给 algo_service，本地存一行 model_versions 记录
（algo_job_id 关联 algo_service 那边的任务），之后可以主动轮询刷新状态，
也可以等 algo_service 训练完主动回调 /model-versions/{algo_job_id}/callback。

跟"样本扫描"（app/services/sample_import_service.py）提交任务→轮询进度条
是同一个模式，区别是训练任务本身在 algo_service 那台机器上跑，这边只是
存一条记录、转发轮询。
"""

import asyncio
import datetime as _dt
from datetime import datetime
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.model_version import ModelTrainStatus, ModelVersion
from app.models.sample import Sample
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.model_version import ModelVersionOut, TrainSubmitIn
from app.services.ai_prelabel_service import _csv_start_of
from app.services import algo_client
from app.services.training_export_service import (
    TrainingExportError,
    delete_dataset,
    check_dataset,
    export_dataset,
    list_datasets,
    label_stats,
    read_segments,
)

router = APIRouter(
    prefix="/model-versions", tags=["model-versions"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)
# algo_service 训练完成后主动回调这个地址——是内部服务间调用，不经过用户登录，
# 单独开一个不挂管理员权限校验的路由，部署时应该只在内网/docker网络里可达，
# 不对公网暴露（跟 docker-compose 里 algo-service 只在内部网络能访问后端是
# 同一个信任边界，见 label_infra README 关于 ALGO_SERVICE_URL 的部署说明）
callback_router = APIRouter(prefix="/model-versions", tags=["model-versions"])

_logger = logging.getLogger("smart-label.model_versions")


class DatasetExportIn(BaseModel):
    name: str
    # 日期和项目都可以不给。项目名跟日期本来就不是一回事——从 Label Studio 导进来
    # 的项目名是日期区间（2026_7_17-2026_7_29_old），还有按狗命名的
    # （2026_8_28_imu4_xiaoman_unwear_old），只按日期圈根本圈不准。
    # 两个条件同时给就是"且"，都不给就是全部。
    date_from: _dt.date | None = None
    date_to: _dt.date | None = None
    project_ids: list[int] | None = None
    # 兼容老调用方：单个 project_id 还认，内部并进 project_ids
    project_id: int | None = None
    # 只用「已通过」最稳；赶时间可以把「待审核」也算上，但那部分还没人复核
    include_submitted: bool = False
    # approved = 整份审完的任务才算；reviewed = 不看任务状态，只取人确认过的片段
    # （点过「通过」/ 改过 / 人自己画的；只是打开看过没点的不算）
    scope: str = "approved"
    # 分了互斥轨的项目：按优先级折叠成"一个时刻一个标签"（默认 行为 > 运动 > 姿态）。
    # 不折叠就各轨原样导，给分轨训练用。没分轨的项目两种一样
    flatten: bool = True
    track_priority: list[str] | None = None


@router.get("/datasets")
async def get_datasets():
    """NAS 上已经导出过的训练数据集（data_train/<name>/meta.json）。"""
    return ok(list_datasets())


@router.post("/datasets")
async def create_dataset(body: DatasetExportIn, db: AsyncSession = Depends(get_db)):
    """
    把这段日期里审核通过的任务的当前片段导成 Label Studio 格式，落到 NAS 的
    data_train/<name>/，然后就能选它提交训练。
    """
    try:
        meta = await export_dataset(
            db, body.name, body.date_from, body.date_to,
            (body.project_ids or ([body.project_id] if body.project_id is not None else None)),
            body.include_submitted,
            scope=body.scope, flatten=body.flatten, track_priority=body.track_priority,
        )
    except TrainingExportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return ok(meta)


@router.get("/dataset-stats")
async def dataset_label_stats(names: str = ""):
    """按类别统计一批数据集的段数/时长/占比，用来判断类别均不均衡。

    names 是逗号分隔的数据集名；不传就统计全部。
    路由必须放在 /datasets/{name} 系列之前——不然 "dataset-stats" 会被当成
    某个数据集的名字匹配进去。
    """
    picked = [x for x in (n.strip() for n in names.split(",")) if x]
    if not picked:
        picked = [d["name"] for d in await asyncio.to_thread(list_datasets)]
    try:
        return ok(await asyncio.to_thread(label_stats, picked))
    except TrainingExportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/train-remap")
async def train_remap():
    """训练时那张类别重映射表。界面拿它写清"这一类最后会变成什么、会不会被丢掉"。

    路由放在 /datasets/{name} 系列之前——不然会被当成某个数据集的名字匹配进去
    （跟 dataset-stats 同一个坑）。
    """
    return ok(await algo_client.get_remap())


@router.get("/datasets/{name}/segments")
async def dataset_segments(name: str, limit: int = 5000, db: AsyncSession = Depends(get_db)):
    """这份导出里到底装了哪些片段——直接读最终喂给训练的那个 json。

    start_ms 是后加的字段，早先导出的数据集里没有，而「去修」要靠它把工作台开到
    那一刻。没有就现算：导出里存着绝对时间，减掉样本 CSV 的起点就是相对毫秒。
    按样本缓存，一份数据集通常只有十几个样本，多读十几个文件头而已。

    为什么不让人重导一次了事：重导会换掉训练集的内容（这中间标注可能已经改过），
    而这里只是想点开看一眼。为了看一眼就把数据集换掉，代价和目的完全不成比例。
    """
    try:
        data = await asyncio.to_thread(read_segments, name, limit)
    except TrainingExportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    need = {r["sample_code"] for r in data["rows"] if r.get("start_ms") is None and r.get("sample_code")}
    if need:
        rows = (await db.execute(select(Sample).where(Sample.sample_code.in_(need)))).scalars().all()
        starts: dict[str, datetime] = {}
        for s in rows:
            try:
                starts[s.sample_code] = await _csv_start_of(s)
            except Exception:  # noqa: BLE001 读不到就这条不补，不影响别的行
                continue
        for r in data["rows"]:
            if r.get("start_ms") is not None:
                continue
            base = starts.get(r.get("sample_code") or "")
            if base is None:
                continue
            for key, src in (("start_ms", "start"), ("end_ms", "end")):
                try:
                    dt = datetime.strptime(r[src], "%Y-%m-%d %H:%M:%S.%f")
                except (ValueError, KeyError, TypeError):
                    continue
                r[key] = int(round((dt - base).total_seconds() * 1000))
    return ok(data)


@router.get("/datasets/{name}/check")
async def dataset_check(name: str):
    """体检：有没有完全重复的段、时间压在一起的段、同一个样本进了两个任务。"""
    try:
        return ok(await asyncio.to_thread(check_dataset, name))
    except TrainingExportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/datasets/{name}")
async def remove_dataset(name: str):
    """删掉 NAS 上这份导出（data_train/<名字>/）。训练记录不动——那是另一回事。"""
    try:
        await asyncio.to_thread(delete_dataset, name)
    except TrainingExportError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return ok(msg="已删除")


@router.post("/{version_id}/listed")
async def set_listed(version_id: int, on: bool = True, db: AsyncSession = Depends(get_db)):
    """启用/停用：只决定它出不出现在项目的「版本」下拉里，不动 AI 服务的默认模型。"""
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")
    if on and not row.model_path:
        raise HTTPException(status_code=400, detail="这条记录还没有模型文件（训练没完成或失败）")
    row.listed = bool(on)
    out = {"id": row.id, "listed": row.listed}
    await db.commit()
    return ok(out)


@router.post("/{version_id}/activate")
async def activate_model(version_id: int, db: AsyncSession = Depends(get_db)):
    """让 AI 服务立刻用这个训练产出的模型跑推理（重建进程池，正在跑的推理会中断）。"""
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")
    if not row.model_path:
        raise HTTPException(status_code=400, detail="这条记录还没有模型文件（训练没完成或失败）")
    try:
        info = await algo_client.switch_model(row.model_path)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return ok(info)


@router.post("/train")
async def submit_train(
    body: TrainSubmitIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dataset_spec = body.dataset.model_dump()
    try:
        algo_job_id = await algo_client.start_train(dataset_spec, body.model_type, body.tag)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    row = ModelVersion(
        algo_job_id=algo_job_id,
        status=ModelTrainStatus.queued,
        model_type=body.model_type,
        dataset_spec=json.dumps(dataset_spec, ensure_ascii=False),
        created_by=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return ok(ModelVersionOut.model_validate(row).model_dump())


@router.get("")
async def list_model_versions(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ModelVersion).order_by(ModelVersion.created_at.desc()))
    rows = result.scalars().all()
    # 还在排队/在跑的，顺手去算法机问一下现在到哪了。以前只有手动点「刷新」
    # 才会去问，于是前端 10 秒刷一次列表也只是反复拿到同一个「排队中」——
    # 训练早就挂了，界面上还一直排着队（2026-09-23 第一次网页训练就是这样）
    pending = [r for r in rows if r.status in (ModelTrainStatus.queued, ModelTrainStatus.running)]
    if pending:
        async def _sync(r: ModelVersion) -> None:
            try:
                _apply_status(r, await algo_client.poll_train(r.algo_job_id))
            except Exception:  # noqa: BLE001 问不到就算了，列表照样给
                pass
        await asyncio.gather(*(_sync(r) for r in pending))
    # **先序列化，再 commit。** updated_at 是 onupdate=func.now()，值是数据库那边
    # 算的：更新过的行一 flush，SQLAlchemy 就把这个字段标成"得回库里重读"（跟
    # expire_on_commit 无关）。commit 之后再序列化，读 updated_at 就触发一次隐式
    # 查库——异步会话里那是 MissingGreenlet，整个列表接口 500。界面上就是一个
    # 「ValidationError」弹窗，列表停在旧状态，删除按钮一直灰着。
    # 同步夹具里隐式查库是合法的，所以这个只有用真的异步会话才测得出来
    out = [ModelVersionOut.model_validate(r).model_dump() for r in rows]
    if pending:
        await db.commit()
    return ok(out)


@router.post("/{version_id}/refresh")
async def refresh_model_version(version_id: int, db: AsyncSession = Depends(get_db)):
    """手动轮询一次 algo_service，更新这一行的状态——没配回调、或者想立刻看结果
    不想等下一次轮询周期时用。"""
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")

    try:
        status_data = await algo_client.poll_train(row.algo_job_id)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    _apply_status(row, status_data)
    await db.commit()
    await db.refresh(row)
    return ok(ModelVersionOut.model_validate(row).model_dump())


@router.get("/{version_id}/log")
async def model_version_log(version_id: int, offset: int = 0, db: AsyncSession = Depends(get_db)):
    """训练日志，从 offset 往后一段。前端每隔几秒接着要，拼起来就是实时滚动的日志。

    顺手把状态也更新了：日志里看到训练结束，表格那一行却还挂着「训练中」，
    得人再去点「刷新」——那就不叫实时了。
    """
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")
    try:
        r = await algo_client.train_log(row.algo_job_id, offset)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    algo_status = r.get("status")
    if algo_status and algo_status != (row.status.value if hasattr(row.status, "value") else row.status):
        try:
            _apply_status(row, await algo_client.poll_train(row.algo_job_id))
            await db.commit()
        except algo_client.AlgoServiceError:
            pass            # 状态同步是顺带的，日志照样给
    return ok(r)


@router.post("/{version_id}/cancel")
async def cancel_model_version(version_id: int, db: AsyncSession = Depends(get_db)):
    """停掉这一版的训练。停了之后状态是失败（原因「手动停止」），就能删了。"""
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")
    try:
        status_data = await algo_client.cancel_train(row.algo_job_id)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    _apply_status(row, status_data)
    # 跟列表那里同一个坑：先序列化再 commit（updated_at 是数据库那边算的）
    out = ModelVersionOut.model_validate(row).model_dump()
    await db.commit()
    return ok(out)


@router.delete("/{version_id}")
async def delete_model_version(version_id: int, db: AsyncSession = Depends(get_db)):
    """删掉这一版：算法机上的模型/预处理数据/日志，再删这边的记录。

    **先删算法机那边，成功了才删记录。** 反过来的话，算法机连不上时记录没了、
    文件还躺在那儿——界面上再也找不到它，那些文件就成了没人管的孤儿。

    还在跑的、模型正是现在推理在用的，算法服务会拒绝（409），原因原样给人看。
    """
    row = await db.get(ModelVersion, version_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"model_version #{version_id} 不存在")
    try:
        r = await algo_client.delete_train(row.algo_job_id)
    except algo_client.AlgoConflict as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status_code=502, detail=f"算法机那边没删成，记录先留着：{e}") from e
    await db.delete(row)
    await db.commit()
    return ok({"deleted": r.get("deleted", [])})


def _apply_status(row: ModelVersion, status_data: dict) -> None:
    row.status = ModelTrainStatus(status_data["status"])
    row.model_version = status_data.get("model_version")
    row.model_path = status_data.get("model_path")
    metrics = status_data.get("metrics")
    row.metrics = json.dumps(metrics, ensure_ascii=False) if metrics else None
    row.error = status_data.get("error")


@callback_router.post("/{algo_job_id}/callback")
async def train_callback(algo_job_id: int, body: dict, db: AsyncSession = Depends(get_db)):
    """algo_service 训练完成/失败后主动推过来的回调，内容跟 GET /train/{job_id}
    的轮询响应同一个格式（见 algo_service modules/label_pipeline/trainer.py
    的 _notify_callback）。回调失败不影响 algo_service 那边的任务状态，
    label_infra 这边随时可以用 /model-versions/{id}/refresh 补一次轮询兜底，
    所以这里找不到匹配行只记日志、不报错，避免 algo_service 因为回调失败重试。"""
    result = await db.execute(select(ModelVersion).where(ModelVersion.algo_job_id == algo_job_id))
    row = result.scalar_one_or_none()
    if row is None:
        _logger.warning("收到未知 algo_job_id=%s 的训练回调，忽略", algo_job_id)
        return ok(None, msg="未找到对应记录，已忽略")

    _apply_status(row, body)
    await db.commit()
    return ok(None)
