"""
大模型 API 配置：几家各一行，网页上配 key、模型列表、默认模型。

给「画面找片段」用：跑之前按 (provider, model) 取出这一行，连 key 一起带给视觉服务。
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.llm_provider import LlmProvider

# 固定几家，顺序就是页面上的顺序。models 是初始建议，网页上随便改
PROVIDERS: list[dict] = [
    {"provider": "anthropic", "display_name": "Anthropic Claude", "base_url": None,
     "models": [{"name": "claude-opus-5", "price_in": 5.0, "price_out": 25.0},
                {"name": "claude-sonnet-5", "price_in": 2.0, "price_out": 10.0},
                {"name": "claude-haiku-4-5", "price_in": 1.0, "price_out": 5.0}],
     "default_model": "claude-opus-5"},
    {"provider": "openai", "display_name": "OpenAI GPT", "base_url": "https://api.openai.com/v1",
     "models": [{"name": "gpt-5", "price_in": 0.0, "price_out": 0.0},
                {"name": "gpt-5-mini", "price_in": 0.0, "price_out": 0.0}],
     "default_model": "gpt-5"},
    {"provider": "doubao", "display_name": "火山引擎 豆包", "base_url": "https://ark.cn-beijing.volces.com/api/v3",
     "models": [{"name": "doubao-seed-1-6-vision-250815", "price_in": 0.0, "price_out": 0.0}],
     "default_model": "doubao-seed-1-6-vision-250815"},
    {"provider": "gemini", "display_name": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta",
     "models": [{"name": "gemini-2.5-pro", "price_in": 0.0, "price_out": 0.0},
                {"name": "gemini-2.5-flash", "price_in": 0.0, "price_out": 0.0}],
     "default_model": "gemini-2.5-flash"},
    # 智谱 GLM：OpenAI 同一套协议。视觉模型 glm-4.5v（新）/ glm-4v-plus；价格以后台为准
    {"provider": "zhipu", "display_name": "智谱 GLM", "base_url": "https://open.bigmodel.cn/api/paas/v4",
     "models": [{"name": "glm-4.5v", "price_in": 0.0, "price_out": 0.0},
                {"name": "glm-4v-plus", "price_in": 0.0, "price_out": 0.0}],
     "default_model": "glm-4.5v"},
    # 本地起的服务：vLLM / SGLang / Ollama 都能开 OpenAI 兼容口。key 可不填。
    # 5090 32G 单卡：Qwen2.5-VL-7B 的 AWQ 量化版跑得动，先从这个试
    # 端口用 8386（挨着 vision_service 的 8385）：8000 太常用，机器上多半被别的东西占着
    {"provider": "local", "display_name": "本地服务（vLLM，OpenAI 兼容）", "base_url": "http://127.0.0.1:8386/v1",
     "models": [{"name": "Qwen/Qwen2.5-VL-7B-Instruct-AWQ", "price_in": 0.0, "price_out": 0.0}],
     "default_model": "Qwen/Qwen2.5-VL-7B-Instruct-AWQ"},
]
# 不需要 key 的提供方
KEY_OPTIONAL = {"local"}
PROVIDER_IDS = [p["provider"] for p in PROVIDERS]


def parse_models(raw: str | None) -> list[dict]:
    """库里的 JSON → [{name, price_in, price_out}]。坏数据当空，不炸页面。"""
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        return []
    out = []
    for m in data if isinstance(data, list) else []:
        if isinstance(m, str):
            m = {"name": m}
        if not isinstance(m, dict) or not str(m.get("name") or "").strip():
            continue
        out.append({"name": str(m["name"]).strip(),
                    "price_in": _num(m.get("price_in")), "price_out": _num(m.get("price_out"))})
    return out


def _num(v) -> float:
    try:
        return max(0.0, float(v or 0))
    except (TypeError, ValueError):
        return 0.0


def mask_key(key: str | None) -> str | None:
    """只露末四位。key 只写不读。"""
    if not key:
        return None
    return ("*" * 6) + key[-4:] if len(key) > 4 else "*" * len(key)


def to_out(row: LlmProvider) -> dict:
    return {
        "provider": row.provider,
        "display_name": row.display_name,
        "has_key": bool(row.api_key),
        "key_optional": row.provider in KEY_OPTIONAL,
        "key_hint": mask_key(row.api_key),
        "base_url": row.base_url,
        "models": parse_models(row.models),
        "default_model": row.default_model,
        "enabled": row.enabled,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def ensure_rows(db: AsyncSession) -> list[LlmProvider]:
    """没有的补上（不带 key）。返回按固定顺序的几行。"""
    rows = {r.provider: r for r in (await db.execute(select(LlmProvider))).scalars().all()}
    created = False
    # 老默认地址（8000）没人改过的话换成新默认；人改过的不动
    loc = rows.get("local")
    if loc is not None and loc.base_url == "http://127.0.0.1:8000/v1":
        loc.base_url = "http://127.0.0.1:8386/v1"
        created = True
    for spec in PROVIDERS:
        if spec["provider"] in rows:
            continue
        r = LlmProvider(provider=spec["provider"], display_name=spec["display_name"], base_url=spec["base_url"],
                        models=json.dumps(spec["models"], ensure_ascii=False), default_model=spec["default_model"],
                        enabled=True)
        db.add(r)
        rows[spec["provider"]] = r
        created = True
    if created:
        await db.commit()
    return [rows[p] for p in PROVIDER_IDS]


async def get_row(db: AsyncSession, provider: str) -> LlmProvider | None:
    return (await db.execute(select(LlmProvider).where(LlmProvider.provider == provider))).scalar_one_or_none()


async def resolve(db: AsyncSession, provider: str, model: str | None) -> dict:
    """给视觉服务的 llm 字段：{provider, model, api_key, base_url, price_in, price_out}。

    没配 key / 停用 / 模型不在列表里 → ValueError，让调用方给人一句话。
    """
    row = await get_row(db, provider)
    if row is None:
        raise ValueError(f"没有「{provider}」这一家，先去「大模型 API」页看看")
    if not row.enabled:
        raise ValueError(f"{row.display_name} 被停用了")
    if not row.api_key and row.provider not in KEY_OPTIONAL:
        raise ValueError(f"{row.display_name} 还没配 API key，去「大模型 API」页填")
    models = parse_models(row.models)
    name = (model or row.default_model or (models[0]["name"] if models else "")).strip()
    if not name:
        raise ValueError(f"{row.display_name} 没有可用的模型，去「大模型 API」页加一个")
    price = next((m for m in models if m["name"] == name), None)
    return {"provider": row.provider, "model": name, "api_key": row.api_key or "", "base_url": row.base_url,
            "price_in": price["price_in"] if price else 0.0, "price_out": price["price_out"] if price else 0.0}
