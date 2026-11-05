"""设备调试页：浏览器直连项圈收到的原始采样，送到 AI 服务跑模型，跟板子的识别结果对比。只给管理员。"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.deps import require_role
from app.models.user import UserRole
from app.schemas.envelope import ok
from app.services import algo_client, edge_client

router = APIRouter(prefix="/device-debug", tags=["device-debug"],
                   dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])


@router.get("/models")
async def models():
    """AI 服务挂着哪些模型（给「服务端预测」选模型用）"""
    return ok(await algo_client.models())


@router.get("/edge-models")
async def edge_models():
    """端侧服务（跑的是板上那份 C）挂着哪些模型。没配 / 连不上就是空列表，这一行不显示"""
    if not edge_client.enabled():
        return ok({"enabled": False, "models": []})
    return ok({"enabled": True, "models": await edge_client.available()})


class InferIn(BaseModel):
    t_ms: list[int] = Field(..., min_length=2, max_length=60_000)
    acc: list[list[float]]
    gyro: list[list[float]] | None = None
    hz: float = Field(..., gt=0)
    mode: str = "raw"   # 服务端：raw / viterbi；端侧：raw / board（板上那份后处理 C）
    model: str | None = None
    # 端侧才用：同一批窗口 C 特征 / Python 特征交叉比，查端侧跟服务端为什么不一样
    diagnose: bool = False


@router.post("/infer")
async def infer(body: InferIn):
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/label/infer_samples"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as c:
            r = await c.post(url, json=body.model_dump(exclude={"diagnose"}))
    except httpx.RequestError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"连不上 AI 服务：{e}") from e
    if r.status_code == 404:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "AI 服务还是旧版本，没有 infer_samples：更新 imu_train 后重启 label_service")
    if r.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"AI 服务返回 {r.status_code}：{r.text[:300]}")
    return ok(r.json())


@router.post("/edge-infer")
async def edge_infer(body: InferIn):
    """同一段原始采样送端侧服务：服务器上跑板子那份 C（同一个端侧工程），
    跟板子自己报的比，差异只剩「板子上的实时环境」；跟服务端模型比，差异是「量化 / 移植到 C」"""
    if not edge_client.enabled():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没配端侧服务（EDGE_SERVICE_URL）")
    url = f"{settings.edge_service_url.rstrip('/')}/api/v1/label/infer_samples"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as c:
            r = await c.post(url, json=body.model_dump())
    except httpx.RequestError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"连不上端侧服务：{e}") from e
    if r.status_code == 404:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "端侧服务还是旧版本，没有 infer_samples：更新 algo_tinyml 后重启 edge_service")
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200 or data.get("error"):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"端侧服务：{data.get('error') or r.text[:300]}")
    return ok(data)
