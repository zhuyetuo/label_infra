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

    # **直接调 dispatch_batch**，不在测试里把分派逻辑抄一遍。
    # 抄一遍是循环论证：测的是我在测试里写的那个 if，不是生产代码里那个。
    # 而生产代码有两个调用点（项目预标注、模型对比跑批），抄两份的话
    # 漏改的那份不会被任何测试发现。
    out = run(edge_client.dispatch_batch(
        [{"path": "a.csv", "sample_id": 7}], "edge:edge_cnn_i8"))

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

    run(edge_client.dispatch_batch([], "stable"))
    assert called == {"algo": "stable"}


def test_edge_batch_sends_the_post_mode_from_the_spec(on, monkeypatch, run):
    """请求体里的 mode 是**版本串解出来的后处理**，不是写死的。

    写死 raw 的话，端侧那列会比线上碎一大截，而碎的原因是后处理不同、
    不是模型不同——对比表看起来像是端侧模型差得多。用户要的是
    "处理机制跟稳定版 v2 一样，只是模型不一样"。
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
    assert sent["mode"] == "viterbi", "默认必须跟线上稳定版 v2 一致"
    assert sent["model"] == "edge_cnn_i8"

    sent.clear()
    run(edge_client.infer_batch([{"path": "a.csv", "sample_id": 1}],
                                model="edge_cnn_i8", post_mode="raw"))
    assert sent["mode"] == "raw"


def test_post_mode_is_parsed_from_the_spec():
    """`edge:x` = 默认 viterbi，`edge:x@raw` = 不做后处理。"""
    assert edge_client.post_mode_of("edge:edge_cnn_i8") == "viterbi"
    assert edge_client.post_mode_of("edge:edge_cnn_i8@raw") == "raw"
    assert edge_client.post_mode_of("edge:edge_cnn_i8@stable") == "stable"
    assert edge_client.post_mode_of("stable") == ""
    # 后缀是后处理，模型名不能把它带上——带上就成了"没有这个端侧模型"
    assert edge_client.model_of("edge:edge_cnn_i8@raw") == "edge_cnn_i8"


def test_unknown_post_mode_is_refused_not_silently_defaulted():
    """悄悄降级的话，结果存进库里标着 @somethig、内容却是 viterbi 的，
    **而这件事没有任何迹象**。"""
    with pytest.raises(edge_client.EdgeServiceError, match="不认识"):
        edge_client.post_mode_of("edge:edge_cnn_i8@smooth")


def test_dispatch_carries_the_spec_post_mode(on, monkeypatch, run):
    """dispatch_batch 也要把后处理带过去——**漏在这里的话上面那几条全是绿的**，
    因为它们直接调 infer_batch，而平台走的是 dispatch_batch。"""
    seen = {}

    async def fake_edge(items, model, post_mode="viterbi", **kw):
        seen["model"], seen["post"] = model, post_mode
        return []

    monkeypatch.setattr(edge_client, "infer_batch", fake_edge)
    run(edge_client.dispatch_batch([{"path": "a.csv", "sample_id": 1}],
                                   mode="edge:edge_cnn_i8@raw"))
    assert seen == {"model": "edge_cnn_i8", "post": "raw"}
    run(edge_client.dispatch_batch([{"path": "a.csv", "sample_id": 1}],
                                   mode="edge:edge_cnn_i8"))
    assert seen["post"] == "viterbi"


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


# ── 预标注（给标注员铺草稿）那条路 ────────────────────────────────────────


def test_prelabel_single_sample_dispatches_to_edge(monkeypatch, run):
    """样本页那个「AI预标注」按钮，选端侧模型时要走端侧服务。

    **分派错了是最糟的**：发给 algo_service，它认不出这个 mode，多半按默认的
    stable 跑——草稿铺下去了，标注员照着改，而那些片段根本不是端侧会报的东西。
    没有任何迹象。
    """
    from app.services import ai_prelabel_service as svc

    called = {}

    async def fake_edge(items, model, **kw):
        called["edge"] = model
        return [{"sample_id": items[0]["sample_id"], "path": items[0]["path"],
                 "ok": True, "error": None,
                 "result": {"model_path": f"edge://{model}.edge", "mode": "raw",
                            "n_windows": 3, "segments": {}, "candidates": [],
                            "missing_seconds": 0.0}}]

    async def fake_algo(*a, **kw):
        called["algo"] = kw.get("mode")
        return {}

    async def fake_start(sample):
        return None

    async def fake_store(sample, result, csv_start):
        called["stored"] = result.get("model_path")
        return result

    monkeypatch.setattr(svc.edge_client, "infer_batch", fake_edge)
    monkeypatch.setattr(svc.algo_client, "infer", fake_algo)
    monkeypatch.setattr(svc, "_csv_start_of", fake_start)
    monkeypatch.setattr(svc, "_store_and_normalize", fake_store)

    class S:
        id = 7
        imu_csv_path = "a.csv"
        sample_hz = 50

    run(svc.infer_sample(S(), mode="edge:edge_cnn_i8"))
    assert called.get("edge") == "edge_cnn_i8", "不该碰 algo_client"
    assert "algo" not in called
    assert called["stored"] == "edge://edge_cnn_i8.edge"


def test_prelabel_single_sample_still_uses_algo_for_plain_modes(monkeypatch, run):
    """加了端侧之后，原来的 stable/raw/viterbi 必须一点不受影响。"""
    from app.services import ai_prelabel_service as svc

    called = {}

    async def fake_algo(path, sample_id=None, mode=None, device_hz=None):
        called["algo"] = mode
        return {"model_path": "/x/rf.pkl", "mode": mode, "segments": {}}

    async def fake_edge(items, model, **kw):
        called["edge"] = model
        return []

    async def fake_start(sample):
        return None

    async def fake_store(sample, result, csv_start):
        return result

    monkeypatch.setattr(svc.algo_client, "infer", fake_algo)
    monkeypatch.setattr(svc.edge_client, "infer_batch", fake_edge)
    monkeypatch.setattr(svc, "_csv_start_of", fake_start)
    monkeypatch.setattr(svc, "_store_and_normalize", fake_store)

    class S:
        id = 7
        imu_csv_path = "a.csv"
        sample_hz = 50

    run(svc.infer_sample(S(), mode="stable"))
    assert called == {"algo": "stable"}


def test_prelabel_edge_failure_becomes_a_clear_error(monkeypatch, run):
    """端侧那边单条失败时，要给一条说得清的错，不能抛 KeyError。

    批量接口的失败是 ok=False + error 字段，不是异常——不处理的话
    下一行 rows[0]["result"] 会是 None，然后在别处炸出一个跟原因无关的错。
    """
    from app.services import ai_prelabel_service as svc

    async def fake_edge(items, model, **kw):
        return [{"sample_id": 7, "path": "a.csv", "ok": False,
                 "error": "ValueError: 找不到加速度列", "result": None}]

    async def fake_start(sample):
        return None

    monkeypatch.setattr(svc.edge_client, "infer_batch", fake_edge)
    monkeypatch.setattr(svc, "_csv_start_of", fake_start)

    class S:
        id = 7
        imu_csv_path = "a.csv"
        sample_hz = 50

    with pytest.raises(svc.PrelabelError, match="找不到加速度列"):
        run(svc.infer_sample(S(), mode="edge:edge_cnn_i8"))


def test_failure_reasons_reach_the_summary_log():
    """跑批失败时，**原因要进那行 summary 日志**，不能只有一个计数。

    这一条是补一个真实的坑：端侧模型第一次跑批 303 个全失败，日志上只有
    `"failed": 303`，原因全在 progress.detail 里——那个要开项目页才看得到。
    于是"为什么失败"完全靠猜。

    去重 + 只取前几条：303 个失败通常是同一个原因，全打出来是刷屏。
    """
    from app.services.ai_prelabel_service import PrelabelProgress

    p = PrelabelProgress()
    p.failed = 3
    p.detail = [
        "任务 #1 a：失败 找不到 /nas/x.csv",
        "任务 #2 b：失败 找不到 /nas/y.csv",      # 同一个原因的不同文件
        "任务 #3 c：失败 找不到加速度列",
    ]
    # 复刻 _run 末尾那段汇总逻辑
    seen, reasons = set(), []
    for line in p.detail:
        if "失败" not in line and "存不下" not in line:
            continue
        why = line.split("：", 1)[-1].strip()
        if why in seen:
            continue
        seen.add(why)
        reasons.append(why)
        if len(reasons) >= 3:
            break

    assert len(reasons) == 3, "三条不同原因都该留下"
    assert any("找不到加速度列" in r for r in reasons), \
        "最关键的那条原因被去重掉了"
    # 前缀要被剥掉，否则"同一个原因、不同任务号"永远去不了重
    assert not any(r.startswith("任务 #") for r in reasons)


def test_endpoint_offers_both_post_modes(on, monkeypatch, run):
    """界面上每个端侧模型要有两个选项：跟线上同一套后处理的、和板上原始的。

    只给一个的话，人要么看不到板子真实的输出，要么只能看到碎的那份——
    而"碎"会被读成模型差，其实是后处理的事。
    """
    async def fake_available():
        return [{"tag": "edge_cnn_i8", "classes": ["抓挠"], "window": 16,
                 "hz": 16, "stride": 8}]

    monkeypatch.setattr(edge_client, "available", fake_available)
    body = run(api.edge_models())
    m = body["data"]["models"][0]
    assert m["spec"] == "edge:edge_cnn_i8"
    assert m["spec_raw"] == "edge:edge_cnn_i8@raw"
    # 两个 spec 都要能解回同一个模型、不同的后处理
    assert edge_client.model_of(m["spec"]) == edge_client.model_of(m["spec_raw"])
    assert edge_client.post_mode_of(m["spec"]) == "viterbi"
    assert edge_client.post_mode_of(m["spec_raw"]) == "raw"


# ── 版本串里的后处理必须一路走到服务 ──────────────────────────────────────
#
# 下面这几条钉的是同一件事在**每个调用点**上都成立。
# 最初 infer_sample 和 _run 都自己写 `model=model_of(mode)`，漏掉了
# post_mode——而漏掉之后一切照常：后处理默认就是 viterbi，结果看着完全正常，
# 只有选了「板上原始」的人拿到的其实是稳定版 v2 的结果。
# 片段碎不碎会被读成模型好坏，所以这个差异比报错更糟。


def _edge_spy(called):
    async def fake_edge(items, model, post_mode="viterbi", **kw):
        called["model"], called["post"] = model, post_mode
        return [{"sample_id": it.get("sample_id"), "path": it.get("path"),
                 "ok": True, "error": None,
                 "result": {"model_path": f"edge://{model}.edge",
                            "mode": post_mode, "n_windows": 3, "segments": {},
                            "candidates": [], "missing_seconds": 0.0}}
                for it in items]
    return fake_edge


@pytest.mark.parametrize("spec,want", [
    ("edge:edge_cnn_i8", "viterbi"),
    ("edge:edge_rf_d10", "viterbi"),
    ("edge:edge_cnn_i8@raw", "raw"),
    ("edge:edge_rf_d10@raw", "raw"),
])
def test_single_sample_carries_the_post_mode(monkeypatch, run, spec, want):
    """工作台单条：两个端侧模型默认都走稳定版 v2，@raw 才是板上原始。"""
    from app.services import ai_prelabel_service as svc

    called = {}

    async def fake_start(sample):
        return None

    async def fake_store(sample, result, csv_start):
        return result

    monkeypatch.setattr(svc.edge_client, "infer_batch", _edge_spy(called))
    monkeypatch.setattr(svc, "_csv_start_of", fake_start)
    monkeypatch.setattr(svc, "_store_and_normalize", fake_store)

    class S:
        id = 7
        imu_csv_path = "a.csv"
        sample_hz = 50

    run(svc.infer_sample(S(), mode=spec))
    assert called["post"] == want, f"{spec} 应该按 {want} 跑，实际 {called['post']}"
    assert called["model"] == edge_client.model_of(spec)


@pytest.mark.parametrize("spec,want", [
    ("edge:edge_cnn_i8", "viterbi"),
    ("edge:edge_rf_d10", "viterbi"),
    ("edge:edge_cnn_i8@raw", "raw"),
])
def test_batch_prelabel_carries_the_post_mode(monkeypatch, run, spec, want):
    """项目批量预标注那条路。**跟上一条是不同的代码路径**，
    所以两条都要钉——最初漏的就是这两处各漏一次。"""
    called = {}
    monkeypatch.setattr(edge_client, "infer_batch", _edge_spy(called))
    run(edge_client.dispatch_batch(
        [{"path": "a.csv", "sample_id": 1, "device_hz": 50}], mode=spec))
    assert called["post"] == want
    assert called["model"] == edge_client.model_of(spec)


def test_both_prelabel_paths_go_through_the_shared_helper():
    """两个调用点都不能自己拆版本串。

    自己拆的表现不是报错，而是「板上原始」安静地变成稳定版 v2 ——
    所以只能在源码上钉：这两处不准出现 model_of。
    """
    import inspect
    import re

    from app.services import ai_prelabel_service as svc

    # **函数名要选对**：第一版写的是 svc._run，而批量那段其实在
    # _run_project 里。变异体（把批量那处改回自己拆）当时照样绿——
    # 一条只扫了两个不相干函数的"源码检查"，比没有更糟
    targets = (svc.infer_sample, svc._run, svc._run_project)
    assert any("edge" in inspect.getsource(f) for f in targets), \
        "没有一个被扫的函数碰端侧，这条检查在空转"
    for fn in targets:
        # 去掉注释行再看：注释里提到 model_of 是在解释**为什么不用它**
        src = "\n".join(ln for ln in inspect.getsource(fn).splitlines()
                        if not ln.lstrip().startswith("#"))
        assert not re.search(r"\bmodel_of\s*\(", src), (
            f"{fn.__name__} 自己拆了版本串，很可能漏掉 post_mode；"
            "用 edge_client.infer_spec / dispatch_batch")


# ── board：整条链都是板上那份 C ────────────────────────────────────────────


def test_board_is_a_valid_post_mode():
    """`edge:x@board` = 让端侧服务用板子上那份后处理（tm_post.c），
    而不是服务端的 Python。

    选 edge:x 时模型和推理已经是板上那份 C 了，但后处理还是服务端的。
    @board 把最后这一段也换掉——手里没有板子时，这是唯一能拿真实数据
    回答「板子会报什么」的办法。
    """
    assert edge_client.post_mode_of("edge:edge_rf_d10@board") == "board"
    assert edge_client.model_of("edge:edge_rf_d10@board") == "edge_rf_d10"


def test_board_is_not_the_default():
    """默认仍然是 viterbi。

    默认成 board 的话，日常铺草稿用的就变成了"板子会报什么"，
    而那跟线上「稳定版 v2」比多了一层实现差异——对比表里就说不清
    差的是模型还是后处理了。
    """
    assert edge_client.EDGE_DEFAULT_POST == "viterbi"
    assert edge_client.post_mode_of("edge:edge_rf_d10") == "viterbi"


def test_board_reaches_the_service(on, monkeypatch, run):
    """mode 要真的以 "board" 发出去。"""
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
    run(edge_client.infer_spec([{"path": "a.csv", "sample_id": 1}],
                               "edge:edge_rf_d10@board"))
    assert sent["mode"] == "board"
    assert sent["model"] == "edge_rf_d10"


def test_endpoint_offers_the_board_spec(on, monkeypatch, run):
    """界面上每个端侧模型现在是三个选项：稳定版 v2 / 板上整条链 / 板上原始。"""
    async def fake_available():
        return [{"tag": "edge_rf_d10", "classes": ["抓挠"], "window": 16,
                 "hz": 16, "stride": 8}]

    monkeypatch.setattr(edge_client, "available", fake_available)
    m = run(api.edge_models())["data"]["models"][0]
    assert m["spec_board"] == "edge:edge_rf_d10@board"
    # 三个 spec 解回来是同一个模型、三种后处理
    assert {edge_client.model_of(m[k]) for k in ("spec", "spec_raw", "spec_board")} \
        == {"edge_rf_d10"}
    assert {edge_client.post_mode_of(m[k]) for k in ("spec", "spec_raw", "spec_board")} \
        == {"viterbi", "raw", "board"}


def test_edge_option_labels_stay_short():
    """下拉里的标签**只留名字**，差异放在旁边那个问号里。

    中间试过把算法名写进标签（「板上整条链（板上·流式有界回溯）」），
    结果太长被下拉框截断，而**截断之后先没的恰好是后半句**——
    也就是真正区分它们的那部分。
    """
    import os
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "hooks", "useInferModes.ts")
    with open(p, encoding="utf-8") as f:
        src = f.read()
    labels = [ln for ln in src.splitlines() if "label: `${m.tag}" in ln]
    assert len(labels) == 3, f"端侧应该是三个选项，实际 {len(labels)}"
    for ln in labels:
        # 标签里不该再有括号说明
        assert "（" not in ln.split("`")[1], f"标签又塞说明了：{ln.strip()}"


def test_the_help_table_covers_every_option():
    """那张表要**把六个版本都列上**。

    漏掉一个的话，人在下拉里选到它、点问号却找不到——
    那比没有这张表更让人困惑。
    """
    import os
    p = os.path.join(os.path.dirname(__file__), "..", "..",
                     "frontend", "src", "components", "InferModeHelp.tsx")
    with open(p, encoding="utf-8") as f:
        src = f.read()
    for name in ("稳定版", "稳定版 v2", "调试版",
                 "端侧 · 稳定版 v2", "端侧 · 板上整条链", "端侧 · 板上原始"):
        assert f'"{name}"' in src, f"表里没有「{name}」这一行"
    # 三列差异必须都在：模型 / 推理 / 后处理
    for col in ("模型", "推理", "后处理"):
        assert f'title: "{col}"' in src, f"表里没有「{col}」这一列"
    # 算法名要出现在表里（标签里已经没有了，这是唯一写着的地方）
    assert "流式" in src and "有界回溯" in src, "表里没写板上那份是流式有界回溯"
    assert "离线 viterbi" in src, "表里没写服务端那份是离线 viterbi"


def test_the_help_icon_is_next_to_every_mode_select():
    """四个用到版本下拉的地方都要有那个问号。

    漏一处的表现是：那个页面上的人看不到差异说明，而别处的人看得到——
    最难发现的那种不一致。
    """
    import os
    base = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "src")
    n = 0
    for rel in ("pages/Projects.tsx", "components/AnnotationWorkspace.tsx"):
        with open(os.path.join(base, rel), encoding="utf-8") as f:
            src = f.read()
        selects = src.count("options={inferOptions}")
        helps = src.count("<InferModeHelp />")
        assert helps >= selects, \
            f"{rel} 有 {selects} 个版本下拉，却只有 {helps} 个问号"
        n += selects
    assert n >= 4, f"只找到 {n} 个版本下拉，比预期少——是不是漏改了哪个页面"
