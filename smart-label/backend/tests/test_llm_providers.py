"""「大模型 API」配置页。

要守住的：key 只写不读（任何输出里都没有整串）；六家一定都在；改列表时默认模型
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


def test_列表_六家都在_没_key_也不炸(db, run, admin):
    rows = run(api.list_providers(db=db))["data"]
    assert [r["provider"] for r in rows] == ["anthropic", "openai", "doubao", "gemini", "zhipu", "local"]
    a = rows[0]
    assert a["has_key"] is False and a["key_hint"] is None and a["enabled"] is True
    assert a["default_model"] == "claude-opus-5" and any(m["name"] == "claude-sonnet-5" for m in a["models"])
    assert rows[-1]["key_optional"] is True and rows[0]["key_optional"] is False
    # 再取一次不会重复建
    assert len(run(api.list_providers(db=db))["data"]) == 6


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
    assert got["api_key"] == "" and got["base_url"] == "http://127.0.0.1:8386/v1" and "Qwen" in got["model"]


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


def test_本地服务老默认端口8000自动换成8386_改过的不动(db, run, admin):
    run(api.list_providers(db=db))
    row = run(svc.get_row(db, "local"))
    row.base_url = "http://127.0.0.1:8000/v1"
    run(db.commit())
    run(svc.ensure_rows(db))
    assert run(svc.get_row(db, "local")).base_url == "http://127.0.0.1:8386/v1"
    row.base_url = "http://gpu:9000/v1"
    run(db.commit())
    run(svc.ensure_rows(db))
    assert run(svc.get_row(db, "local")).base_url == "http://gpu:9000/v1"


def test_智谱走OpenAI兼容口(db, run, admin):
    run(api.list_providers(db=db))
    run(api.update_provider("zhipu", api.ProviderUpdate(api_key="zk"), db=db, admin=admin))
    got = run(svc.resolve(db, "zhipu", None))
    assert got["base_url"] == "https://open.bigmodel.cn/api/paas/v4" and got["model"] == "glm-4.5v" and got["api_key"] == "zk"


def test_本地服务地址跟着算法机的局域网地址走(db, run, admin, monkeypatch):
    monkeypatch.setattr(svc.settings, "vision_service_url", "http://192.168.1.50:8385")
    assert svc.default_local_base_url() == "http://192.168.1.50:8386/v1"
    run(api.list_providers(db=db))
    assert run(svc.get_row(db, "local")).base_url == "http://192.168.1.50:8386/v1"
    # 老默认 127.0.0.1 没改过的换成新默认；人改过的不动
    row = run(svc.get_row(db, "local"))
    row.base_url = "http://127.0.0.1:8386/v1"
    run(db.commit())
    run(svc.ensure_rows(db))
    assert run(svc.get_row(db, "local")).base_url == "http://192.168.1.50:8386/v1"
    row.base_url = "http://gpu:9000/v1"
    run(db.commit())
    run(svc.ensure_rows(db))
    assert run(svc.get_row(db, "local")).base_url == "http://gpu:9000/v1"
    # 没配视觉服务地址就退回 127.0.0.1
    monkeypatch.setattr(svc.settings, "vision_service_url", "")
    assert svc.default_local_base_url() == "http://127.0.0.1:8386/v1"


def test_调用统计_落表和汇总(db, run, admin, monkeypatch):
    from app.services import llm_call_service as cs
    from app.services import vision_sam_client as vc

    run(api.list_providers(db=db))
    run(api.update_provider("doubao", api.ProviderUpdate(api_key="dk"), db=db, admin=admin))

    async def fake(llm):
        return {"ok": True, "latency_ms": 120, "reply": "OK", "usage": {"input": 30, "output": 2}, "error": None}

    monkeypatch.setattr(vc, "llm_test", fake)
    run(api.test_provider("doubao", api.TestIn(model=None), db=db))
    # 找片段带回来的每段一条
    cs.record_calls(db, "doubao", "doubao-seed-1-6-vision-250815", [
        {"latency_ms": 1000, "input": 5000, "output": 50, "est_usd": 0.01, "ok": True},
        {"latency_ms": 3000, "input": 5200, "output": 40, "est_usd": 0.01, "ok": True},
        {"latency_ms": 200, "input": 0, "output": 0, "ok": False, "error": "timeout"},
    ], purpose="seek", project_id=7, task_id=42)
    run(db.commit())
    st = run(api.call_stats(days=7, db=db))["data"]
    t = st["total"]
    assert t["calls"] == 4 and t["errors"] == 1 and t["input_tokens"] == 10230 and t["output_tokens"] == 92
    assert t["total_tokens"] == 10322 and t["avg_tokens_per_call"] == round(10322 / 4)
    assert t["max_latency_ms"] == 3000 and t["avg_latency_ms"] == round((120 + 1000 + 3000 + 200) / 4)
    assert st["all_time"]["calls"] == 4
    assert st["by_model"][0]["provider"] == "doubao" and st["by_model"][0]["calls"] == 4
    assert len(st["by_day"]) == 1 and st["by_day"][0]["calls"] == 4
    assert st["recent"][0]["error"] == "timeout" and st["recent"][0]["task_id"] == 42
    assert any(r["purpose"] == "test" and r["latency_ms"] == 120 for r in st["recent"])
