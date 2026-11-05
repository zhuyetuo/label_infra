"""设备调试页：浏览器直连项圈收到的原始采样，送到 AI 服务跑模型，跟板子的识别结果对比。只给管理员。"""

from __future__ import annotations

import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok
from app.services import algo_client

router = APIRouter(prefix="/device-debug", tags=["device-debug"],
                   dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])


@router.get("/models")
async def models():
    """AI 服务挂着哪些模型（给「服务端预测」选模型用）"""
    return ok(await algo_client.models())


@router.get("/time")
async def server_time():
    """服务器现在几点（Unix 毫秒）。设备调试页拿它跟电脑时间、板上时间比"""
    return ok({"server_ms": time.time() * 1000})


class InferIn(BaseModel):
    t_ms: list[int] = Field(..., min_length=2, max_length=60_000)
    acc: list[list[float]]
    gyro: list[list[float]] | None = None
    hz: float = Field(..., gt=0)
    mode: str = "raw"
    model: str | None = None


@router.post("/infer")
async def infer(body: InferIn):
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/label/infer_samples"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as c:
            r = await c.post(url, json=body.model_dump())
    except httpx.RequestError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"连不上 AI 服务：{e}") from e
    if r.status_code == 404:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "AI 服务还是旧版本，没有 infer_samples：更新 imu_train 后重启 label_service")
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI 服务返回 {r.status_code}：{r.text[:300]}")
    return ok(r.json())
