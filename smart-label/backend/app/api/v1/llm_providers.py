"""
「大模型 API」页：各家的 key / 模型列表 / 默认模型，网页上配。

key 只写不读：GET 只给"配没配 + 末四位"，没有任何接口把整串吐回来。
「测试」是让视觉服务用这把 key 发一句最短的话（不带图，几乎不花钱），
看 key 和模型名对不对——配错了在这里就知道，不用等找片段跑了半天才报错。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import llm_call_service
from app.services import llm_provider_service as svc
from app.services import vision_sam_client

router = APIRouter(
    prefix="/llm-providers",
    tags=["llm-providers"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)


class ModelIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    price_in: float = Field(0.0, ge=0)
    price_out: float = Field(0.0, ge=0)


class ProviderUpdate(BaseModel):
    """没传的字段不动；api_key 传空串 = 清掉。"""
    api_key: str | None = None
    base_url: str | None = None
    models: list[ModelIn] | None = None
    default_model: str | None = None
    enabled: bool | None = None


@router.get("")
async def list_providers(db: AsyncSession = Depends(get_db)):
    rows = await svc.ensure_rows(db)
    return ok([svc.to_out(r) for r in rows])


@router.put("/{provider}")
async def update_provider(provider: str, body: ProviderUpdate, db: AsyncSession = Depends(get_db),
                          admin: User = Depends(get_current_user)):
    await svc.ensure_rows(db)
    row = await svc.get_row(db, provider)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这一家")
    changed: list[str] = []
    data = body.model_dump(exclude_unset=True)
    if "api_key" in data:
        row.api_key = (data["api_key"] or "").strip() or None
        changed.append("api_key")
    if "base_url" in data:
        row.base_url = (data["base_url"] or "").strip().rstrip("/") or None
        changed.append("base_url")
    if "models" in data:
        import json

        row.models = json.dumps([m.model_dump() for m in body.models or []], ensure_ascii=False)
        changed.append("models")
    if "default_model" in data:
        row.default_model = (data["default_model"] or "").strip() or None
        changed.append("default_model")
    if "enabled" in data:
        row.enabled = bool(data["enabled"])
        changed.append("enabled")
    # 默认模型得在列表里；列表改了默认模型不在了就退回第一个
    names = [m["name"] for m in svc.parse_models(row.models)]
    if names and row.default_model not in names:
        row.default_model = names[0]
    row.updated_by = admin.id
    # 记一笔谁改了什么（不记 key 本身）
    db.add(AuditLog(user_id=admin.id, action="llm_provider.update", target_type="llm_provider",
                    target_id=row.id, detail=f'{{"provider": "{row.provider}", "changed": {changed}}}'))
    await db.commit()
    await db.refresh(row)
    return ok(svc.to_out(row))


class TestIn(BaseModel):
    model: str | None = None


@router.post("/{provider}/test")
async def test_provider(provider: str, body: TestIn, db: AsyncSession = Depends(get_db)):
    """用存着的 key 让视觉服务发一句最短的话。返回 {ok, latency_ms, reply, error}。"""
    try:
        llm = await svc.resolve(db, provider, body.model)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    try:
        r = await vision_sam_client.llm_test(llm)
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    # 测试也算一次调用，记进统计（几乎不花 token，但耗时有参考价值）
    u = r.get("usage") or {}
    llm_call_service.record_calls(db, llm["provider"], llm["model"], [{
        "input": u.get("input"), "output": u.get("output"), "latency_ms": r.get("latency_ms"),
        "ok": bool(r.get("ok")), "error": r.get("error"),
        "est_usd": (int(u.get("input") or 0) / 1e6 * float(llm.get("price_in") or 0)
                    + int(u.get("output") or 0) / 1e6 * float(llm.get("price_out") or 0)),
    }], purpose="test")
    await db.commit()
    return ok(r)


@router.get("/stats")
async def call_stats(days: int = 30, db: AsyncSession = Depends(get_db)):
    """调用统计：次数、token（总 / 单次）、花费、耗时（均值 / p50 / p90 / 最大），按家/模型、按天、最近几次。"""
    return ok(await llm_call_service.stats(db, days=max(1, min(365, days))))


# ── 本地模型（算法机上的狗检测 / SAM / 画面向量 / 姿态）────────────────

@router.get("/local-models")
async def local_models():
    """本地模型一张表：在不在、跑在哪、权重、错误、调用计数（视觉服务进程内存里，重启归零）。"""
    return ok(await vision_sam_client.models_overview())


class LocalModelActionIn(BaseModel):
    action: str = Field(..., pattern="^(load|unload|test)$")


@router.post("/local-models/{key}")
async def local_model_act(key: str, body: LocalModelActionIn, db: AsyncSession = Depends(get_db),
                          admin: User = Depends(get_current_user)):
    """加载（含预热）/ 卸载（释放显存）/ 测试（跑一次最小推理）。"""
    try:
        r = await vision_sam_client.models_act(key, body.action)
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    db.add(AuditLog(user_id=admin.id, action=f"local_model.{body.action}", target_type="local_model", target_id=None,
                    detail=f"{key}: ok={r.get('ok')} {r.get('error') or ''}"[:500]))
    await db.commit()
    return ok(r)


@router.get("/local-models/vllm/log")
async def local_vllm_log(n: int = 300):
    """vLLM 这次启动的日志（最后 n 行）和挑出来的报错行。"""
    try:
        return ok(await vision_sam_client.vllm_log(max(20, min(3000, n))))
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e


@router.get("/local-models/stats")
async def local_models_stats(days: int = 30, db: AsyncSession = Depends(get_db)):
    """本地模型最近 days 天的调用量，每个模型按天一行（平台每 5 分钟从视觉服务采一次计数）。"""
    from app.services import local_model_stats_service as lms

    return ok(await lms.stats(db, max(1, min(400, days))))


@router.get("/imu-models/stats")
async def imu_models_stats(days: int = 30, db: AsyncSession = Depends(get_db)):
    """IMU 预测模型（AI 预标注）最近 days 天的使用量：每个模型 / 版本按天跑了几份样本、多少窗口。"""
    from app.services import local_model_stats_service as lms

    return ok(await lms.imu_stats(db, max(1, min(400, days))))


@router.post("/local-models/meter/reset")
async def local_models_meter_reset():
    try:
        return ok(await vision_sam_client.models_meter_reset())
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
