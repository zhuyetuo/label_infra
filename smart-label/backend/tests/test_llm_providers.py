"""「大模型 API」配置页。

要守住的：key 只写不读（任何输出里都没有整串）；五家一定都在；改列表时默认模型
跟着合法；resolve 给视觉服务的东西完整、配错了报人话；本地服务不要 key。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.v1 import llm_providers as api
from app.models.user import User, UserRole
from app.services import llm_provider_service as svc


@pytest.fixture()
def admin(db, run):
    u = User(username="adm", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.commit())
    return u


def test_列表_五家都在_没_key_也不炸(db, run, admin):
    rows = run(api.list_providers(db=db))["data"]
    assert [r["provider"] for r in rows] == ["anthropic", "openai", "doubao", "gemini", "local"]
    a = rows[0]
    assert a["has_key"] is False and a["key_hint"] is None and a["enabled"] is True
    assert a["default_model"] == "claude-opus-5" and any(m["name"] == "claude-sonnet-5" for m in a["models"])
    assert rows[-1]["key_optional"] is True and rows[0]["key_optional"] is False
    # 再取一次不会重复建
    assert len(run(api.list_providers(db=db))["data"]) == 5


def test_存_key_只露末四位_整串永远不出来(db, run, admin):
    out = run(api.update_provider("openai", api.ProviderUpdate(api_key="sk-proj-ABCDEFGH1234"), db=db, admin=admin))["data"]
    assert out["has_key"] is True and out["key_hint"] == "******1234"
    assert "sk-proj" not in str(out)
    rows = run(api.list_providers(db=db))["data"]
    assert "sk-proj" not in str(rows)
    # 清掉
    out = run(api.update_provider("openai", api.ProviderUpdate(api_key=""), db=db, admin=admin))["data"]
    assert out["has_key"] is False and out["key_hint"] is None
    # 没传 api_key 字段不动它
    run(api.update_provider("openai", api.ProviderUpdate(api_key="k2"), db=db, admin=admin))
    out = run(api.update_provider("openai", api.ProviderUpdate(enabled=False), db=db, admin=admin))["data"]
    assert out["has_key"] is True and out["enabled"] is False


def test_改模型列表_默认模型跟着合法(db, run, admin):
    body = api.ProviderUpdate(models=[api.ModelIn(name="gemini-3-pro", price_in=1.25, price_out=10)],
                              default_model="gemini-2.5-flash")   # 不在新列表里
    out = run(api.update_provider("gemini", body, db=db, admin=admin))["data"]
    assert out["models"] == [{"name": "gemini-3-pro", "price_in": 1.25, "price_out": 10.0}]
    assert out["default_model"] == "gemini-3-pro"
    out = run(api.update_provider("gemini", api.ProviderUpdate(base_url="https://proxy/v1beta/"), db=db, admin=admin))["data"]
    assert out["base_url"] == "https://proxy/v1beta"
    with pytest.raises(HTTPException) as e:
        run(api.update_provider("baidu", api.ProviderUpdate(), db=db, admin=admin))
    assert e.value.status_code == 404


def test_resolve_给视觉服务的整包(db, run, admin):
    run(api.list_providers(db=db))
    with pytest.raises(ValueError, match="API key"):
        run(svc.resolve(db, "anthropic", None))
    run(api.update_provider("anthropic", api.ProviderUpdate(api_key="ak"), db=db, admin=admin))
    got = run(svc.resolve(db, "anthropic", None))
    assert got == {"provider": "anthropic", "model": "claude-opus-5", "api_key": "ak", "base_url": None,
                   "price_in": 5.0, "price_out": 25.0}
    got = run(svc.resolve(db, "anthropic", "claude-haiku-4-5"))
    assert got["model"] == "claude-haiku-4-5" and got["price_in"] == 1.0
    # 列表里没有的模型名也放行（新模型先试再加进列表），价格按 0
    got = run(svc.resolve(db, "anthropic", "claude-x"))
    assert got["model"] == "claude-x" and got["price_in"] == 0.0
    run(api.update_provider("anthropic", api.ProviderUpdate(enabled=False), db=db, admin=admin))
    with pytest.raises(ValueError, match="停用"):
        run(svc.resolve(db, "anthropic", None))
    with pytest.raises(ValueError, match="没有"):
        run(svc.resolve(db, "nope", None))


def test_本地服务不要_key(db, run, admin):
    run(api.list_providers(db=db))
    got = run(svc.resolve(db, "local", None))
    assert got["api_key"] == "" and got["base_url"] == "http://127.0.0.1:8000/v1" and "Qwen" in got["model"]


def test_parse_models_容错():
    assert svc.parse_models(None) == []
    assert svc.parse_models("不是json") == []
    assert svc.parse_models('["a", {"name": "b", "price_in": "2"}, {"nope": 1}, 5]') == [
        {"name": "a", "price_in": 0.0, "price_out": 0.0}, {"name": "b", "price_in": 2.0, "price_out": 0.0}]
    assert svc.mask_key("ab") == "**" and svc.mask_key("abcdefgh") == "******efgh"


def test_test接口_走视觉服务(db, run, admin, monkeypatch):
    from app.services import vision_sam_client as vc

    run(api.list_providers(db=db))
    run(api.update_provider("doubao", api.ProviderUpdate(api_key="dk"), db=db, admin=admin))
    sent = {}

    async def fake(llm):
        sent.update(llm)
        return {"ok": True, "latency_ms": 12, "reply": "OK", "error": None}

    monkeypatch.setattr(vc, "llm_test", fake)
    r = run(api.test_provider("doubao", api.TestIn(model=None), db=db))["data"]
    assert r["ok"] is True and sent["api_key"] == "dk" and sent["provider"] == "doubao"
    with pytest.raises(HTTPException) as e:
        run(api.test_provider("gemini", api.TestIn(), db=db))     # 没 key
    assert e.value.status_code == 422

    async def down(llm):
        raise vc.SamUnavailable("连不上视觉服务：ConnectError")

    monkeypatch.setattr(vc, "llm_test", down)
    with pytest.raises(HTTPException) as e:
        run(api.test_provider("doubao", api.TestIn(), db=db))
    assert e.value.status_code == 503
