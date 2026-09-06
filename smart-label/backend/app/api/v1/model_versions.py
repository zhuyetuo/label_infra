"""
模型训练：提交训练任务给 algo_service，本地存一行 model_versions 记录
（algo_job_id 关联 algo_service 那边的任务），之后可以主动轮询刷新状态，
也可以等 algo_service 训练完主动回调 /model-versions/{algo_job_id}/callback。

跟"样本扫描"（app/services/sample_import_service.py）提交任务→轮询进度条
是同一个模式，区别是训练任务本身在 algo_service 那台机器上跑，这边只是
存一条记录、转发轮询。
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.model_version import ModelTrainStatus, ModelVersion
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.model_version import ModelVersionOut, TrainSubmitIn
from app.services import algo_client

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
    return ok([ModelVersionOut.model_validate(r).model_dump() for r in rows])


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
