"""端侧模型接进模型对比这一侧的行为，重点是**用不了的时候会怎样**。

端侧推理服务是可选的：没配就是关着的，配了也可能没起来、或者挂的模型跟
界面上选的对不上。这几种情况在这个团队里是常态，不是异常。所以它们必须
一律变成"选项不出现 / 这一批失败并说清原因"，而不是 500 红叉，
更不能变成"跑完了但结果是错的"。

另一条主线：**端侧模型和 algo_service 的 mode 在跑批里是平级的**。
版本字符串写成 `edge:<标签>`，走另一个 client，但结果结构、存库、对比逻辑
完全一样。这里验的是"分派到对的那个 client"和"前缀解析不出岔子"。
"""

import pytest

from app.api.v1 import model_eval as api
from app.services import edge_client


# ── 前缀解析 ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("spec,expect", [
    ("edge:edge_cnn_i8", True),
    ("edge:edge_rf_d10", True),
    ("stable", False),
    ("raw", False),
    ("viterbi", False),
    ("", False),
    (None, False),
])
def test_is_edge_only_matches_the_prefix(spec, expect):
    assert edge_client.is_edge(spec) is expect


def test_model_of_strips_only_the_prefix():
    """标签里含冒号也不能截错——`edge:a:b` 的模型名是 `a:b`。

    用 split(":")[1] 那种写法在这里会悄悄截成 `a`，然后报"没有这个端侧模型"，
    而界面上显示的名字是对的。
    """
    assert edge_client.model_of("edge:edge_cnn_i8") == "edge_cnn_i8"
    assert edge_client.model_of("edge:a:b") == "a:b"
    assert edge_client.model_of("stable") == ""


def test_mode_named_like_a_model_is_not_mistaken_for_edge():
    """"edgecase" 这种名字不该被当成端侧——前缀必须带冒号。"""
    assert edge_client.is_edge("edgecase") is False


# ── 没配 / 连不上 ─────────────────────────────────────────────────────────


@pytest.fixture()
def off(monkeypatch):
    monkeypatch.setattr(edge_client.settings, "edge_service_url", "", raising=False)


@pytest.fixture()
def on(monkeypatch):
    monkeypatch.setattr(edge_client.settings, "edge_service_url",
                        "http://127.0.0.1:1", raising=False)   # 肯定连不上的端口


def test_disabled_reports_empty_not_error(off, run):
    """没配端侧服务时，对比页照常用，只是没有端侧那几个选项。"""
    assert edge_client.enabled() is False
    assert run(edge_client.available()) == []
    r = run(api.edge_models())
    assert r["data"]["enabled"] is False
    assert r["data"]["models"] == []


def test_unreachable_service_degrades_to_empty_list(on, run):
    """服务配了但没起来 → 返回空列表，不是 500。

    端侧服务是可选的，它挂了不该让整个模型对比页打不开。
    """
    assert run(edge_client.available()) == []
    r = run(api.edge_models())
    # enabled 仍然是 True：配了但连不上，跟没配是两回事，
    # 界面上要能区分"没开这个功能"和"开了但服务挂了"
    assert r["data"]["enabled"] is True
    assert r["data"]["models"] == []


def test_infer_batch_without_config_says_what_to_do(off, run):
    """关着的时候要说清楚是**关着**，而不是"连不上"。

    （消息里原来提的是 edge_service_url 这个字段名；现在 compose 里有默认
    地址了，关闭方式是填 off，所以消息也跟着改成说 EDGE_SERVICE_URL。）
    """
    with pytest.raises(edge_client.EdgeServiceError, match="EDGE_SERVICE_URL"):
        run(edge_client.infer_batch([{"path": "a.csv", "sample_id": 1}],
                                    model="edge_cnn_i8"))


# ── 挂着哪些模型：问服务，不读配置 ────────────────────────────────────────


def test_available_models_come_from_the_service(on, monkeypatch, run):
    """配置里不写模型列表。

    写死在配置里的话，配置跟服务不同步时界面上会出现一个选了就报错的选项，
    而错误是"没有这个端侧模型"——绕一圈才知道是配置的事。
    """
    async def fake_get(self, url, **kw):
        class R:
            status_code = 200

            @staticmethod
            def json():
                return {"ok": True, "models": [
                    {"tag": "edge_cnn_i8", "classes": ["活动", "抓挠"],
                     "window": 16, "hz": 16, "stride": 8},
                    {"tag": "edge_rf_d10", "classes": ["活动", "抓挠"],
                     "window": 16, "hz": 16, "stride": 8},
                ]}
        return R()

    monkeypatch.setattr("httpx.AsyncClient.get", fake_get)
    r = run(api.edge_models())
    tags = [m["tag"] for m in r["data"]["models"]]
    assert tags == ["edge_cnn_i8", "edge_rf_d10"]
    # spec 是跑批时要传的那个字符串，前端不用自己拼前缀——
    # 拼错了的表现是"没有这个端侧模型"，而前端看不出哪里错
    assert [m["spec"] for m in r["data"]["models"]] == \
        ["edge:edge_cnn_i8", "edge:edge_rf_d10"]


# ── 跑批时分派到对的 client ───────────────────────────────────────────────


def test_edge_spec_goes_to_edge_client_not_algo(on, monkeypatch, run):
    """**分派错了最糟**：`edge:xxx` 发给 algo_service，它认不出这个 mode，
    多半会当成默认的 stable 跑——结果存进库里，标签写的是端侧模型，
    内容却是线上模型。对比表从此是错的，而且没有任何迹象。
    """
    called = {}

    async def fake_edge(items, model, **kw):
        called["edge"] = model
        return [{"sample_id": it["sample_id"], "path": it["path"],
                 "ok": True, "error": None,
                 "result": {"model_path": f"edge://{model}.edge", "mode": "raw",
                            "n_windows": 3, "segments": {}, "candidates": [],
                            "missing_seconds": 0.0}}
                for it in items]

    async def fake_algo(items, mode=None):
        called["algo"] = mode
        return []

    monkeypatch.setattr(edge_client, "infer_batch", fake_edge)
    from app.services import algo_client
    monkeypatch.setattr(algo_client, "infer_batch", fake_algo)

    # 直接验分派那一小段逻辑，不拉起整个跑批（那要数据库和 NAS）
    spec = "edge:edge_cnn_i8"
    if edge_client.is_edge(spec):
        out = run(edge_client.infer_batch(
            [{"path": "a.csv", "sample_id": 7}], model=edge_client.model_of(spec)))
    else:
        out = run(algo_client.infer_batch([{"path": "a.csv", "sample_id": 7}], mode=spec))

    assert called == {"edge": "edge_cnn_i8"}, "不该碰 algo_client"
    assert out[0]["result"]["model_path"] == "edge://edge_cnn_i8.edge"


def test_plain_mode_still_goes_to_algo_client(on, monkeypatch, run):
    """加了端侧之后，原来的 stable/raw/viterbi 必须一点不受影响。"""
    called = {}

    async def fake_algo(items, mode=None):
        called["algo"] = mode
        return []

    async def fake_edge(items, model, **kw):
        called["edge"] = model
        return []

    from app.services import algo_client
    monkeypatch.setattr(algo_client, "infer_batch", fake_algo)
    monkeypatch.setattr(edge_client, "infer_batch", fake_edge)

    spec = "stable"
    if edge_client.is_edge(spec):
        run(edge_client.infer_batch([], model=edge_client.model_of(spec)))
    else:
        run(algo_client.infer_batch([], mode=spec))
    assert called == {"algo": "stable"}


def test_edge_batch_always_asks_for_raw(on, monkeypatch, run):
    """端侧只有 raw。请求体里写死 raw，不把平台的 algo_infer_mode 带过去——

    带过去的话，平台默认是 stable，端侧服务会直接拒绝，而拒绝信息
    ("端侧模型只有 raw") 看着像端侧服务的毛病，其实是这边传错了。
    """
    sent = {}

    async def fake_post(self, url, json=None, **kw):
        sent.update(json or {})

        class R:
            status_code = 200

            @staticmethod
            def json():
                return []
        return R()

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    run(edge_client.infer_batch([{"path": "a.csv", "sample_id": 1}],
                                model="edge_cnn_i8"))
    assert sent["mode"] == "raw"
    assert sent["model"] == "edge_cnn_i8"


def test_non_list_response_is_rejected(on, monkeypatch, run):
    """端侧服务返回了个 dict（比如一条错误信息）而不是列表。

    不拦的话下游会在 `r["sample_id"]` 上抛 TypeError，错误信息跟真实原因
    毫无关系——而真实原因就写在那个 dict 里。
    """
    async def fake_post(self, url, json=None, **kw):
        class R:
            status_code = 200

            @staticmethod
            def json():
                return {"error": "没有这个端侧模型"}
        return R()

    monkeypatch.setattr("httpx.AsyncClient.post", fake_post)
    with pytest.raises(edge_client.EdgeServiceError, match="不是列表"):
        run(edge_client.infer_batch([{"path": "a.csv", "sample_id": 1}],
                                    model="edge_cnn_i8"))
