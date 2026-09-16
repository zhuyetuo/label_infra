"""服务端的**另一个模型**（`srv:<标签>`）。

算法服务（imu_train 的 label_service）原来只挂一个模型，"版本"这个字段说的全是后处理。现在可以在同一台
服务上挂几个模型并排跑，用来回答"换个模型效果差多少"——比如只用加速计那版。

这里盯的全是**错了不报错**的事，而且这一类在这个链路上特别多：

  · `srv:acc3` 落到 algo_client.infer() → _mode() 认不出它 → 当成没传 →
    退回默认后处理**和默认模型**，而结果存进库里标着 srv:acc3。
  · 拆版本串只拆一半（拿了 model 忘了 post）→ 后处理默认就是 viterbi，
    选了「调试版」的人拿到的其实是稳定版 v2 的结果。
  · 默认模型也给一个 srv:default → 同一个东西两种写法，存进库是两个
    model_tag，对比表里分成两列。
"""

import asyncio

import pytest

from app.services import algo_client


# ── 版本串的解析 ──────────────────────────────────────────────────────────


def test_is_srv():
    assert algo_client.is_srv("srv:acc3")
    assert algo_client.is_srv("srv:acc3@raw")
    assert not algo_client.is_srv("viterbi")
    assert not algo_client.is_srv("edge:edge_rf_d10")
    assert not algo_client.is_srv(None)


def test_model_of_drops_the_postprocess_suffix():
    """`@后缀` 是后处理，**不是模型名的一部分**。

    带着后缀去认模型的话，同一个模型的两种后处理会被当成两个不同的模型。
    """
    assert algo_client.model_of("srv:acc3") == "acc3"
    assert algo_client.model_of("srv:acc3@raw") == "acc3"
    assert algo_client.model_of("srv:acc3@stable") == "acc3"
    assert algo_client.model_of("viterbi") == ""


def test_default_post_is_viterbi_not_raw():
    """默认 raw 的话，这一列会比线上那列碎一大截，而碎的原因是后处理不同、
    不是模型不同——对比表看起来像这个模型差得多。"""
    assert algo_client.post_mode_of("srv:acc3") == "viterbi"
    assert algo_client.post_mode_of("srv:acc3@raw") == "raw"
    assert algo_client.post_mode_of("srv:acc3@stable") == "stable"


def test_unknown_post_raises_instead_of_falling_back():
    """不认识的后缀**报错，不当成默认**。

    悄悄降级的话，结果存进库里标着 @somethig，内容却是 viterbi 的，
    而这件事没有任何迹象。
    """
    with pytest.raises(algo_client.AlgoServiceError) as e:
        algo_client.post_mode_of("srv:acc3@somethig")
    assert "somethig" in str(e.value)


# ── 分发：srv: 不能落到默认模型上 ─────────────────────────────────────────


@pytest.fixture
def spy(monkeypatch):
    """记下 algo_client / edge_client 各自被怎么调的。"""
    calls = {}

    async def fake_infer_batch(items, mode=None, model=None):
        calls["algo"] = {"mode": mode, "model": model}
        return [{"sample_id": None, "path": "p", "ok": True, "result": {}}]

    async def fake_edge_spec(items, spec, **kw):
        calls["edge"] = {"spec": spec}
        return [{"sample_id": None, "path": "p", "ok": True, "result": {}}]

    monkeypatch.setattr(algo_client, "infer_batch", fake_infer_batch)
    from app.services import edge_client
    monkeypatch.setattr(edge_client, "infer_spec", fake_edge_spec)
    return calls


def test_dispatch_sends_the_model_tag(spy):
    """`srv:acc3` 必须带着 model=acc3 发出去。

    不带的话 算法服务跑的是默认模型，而结果标着 srv:acc3。**没有任何迹象。**
    """
    from app.services import edge_client

    asyncio.run(edge_client.dispatch_batch([{"path": "a.csv"}], "srv:acc3"))
    assert spy["algo"] == {"mode": "viterbi", "model": "acc3"}


def test_dispatch_carries_the_postprocess_too(spy):
    """拆版本串只拆一半是这条链上最容易犯的错——拿了 model 忘了 post。"""
    from app.services import edge_client

    asyncio.run(edge_client.dispatch_batch([{"path": "a.csv"}], "srv:acc3@raw"))
    assert spy["algo"] == {"mode": "raw", "model": "acc3"}


def test_plain_modes_still_go_without_a_model(spy):
    """线上那三行**不能**带 model 字段。

    一直带的话，老版本的算法服务（没有多模型）会因为多了个未知字段而 422——
    那是一次纯粹为了"保持接口一致"造成的故障。
    """
    from app.services import edge_client

    asyncio.run(edge_client.dispatch_batch([{"path": "a.csv"}], "viterbi"))
    assert spy["algo"] == {"mode": "viterbi", "model": None}


def test_edge_specs_still_go_to_the_edge_service(spy):
    from app.services import edge_client

    asyncio.run(edge_client.dispatch_batch([{"path": "a.csv"}], "edge:edge_rf_d10"))
    assert spy["edge"] == {"spec": "edge:edge_rf_d10"}
    assert "algo" not in spy, "端侧的版本串跑到算法服务去了"


# ── 单条推理那条路（工作台按钮） ──────────────────────────────────────────


def test_single_sample_path_handles_srv():
    """`infer_sample` 里必须为 srv: 单开一支。

    交给 algo_client.infer() 的话，`srv:acc3` 不在 raw/stable/viterbi 里，
    _mode() 会把它**当成没传**，退回默认后处理和默认模型——而结果
    标着 srv:acc3。用 AST 查真实调用，不扫注释（扫注释被自己的说明
    绊过三次了）。
    """
    import ast
    import inspect

    from app.services import ai_prelabel_service as svc

    tree = ast.parse(inspect.getsource(svc.infer_sample).strip())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
    attrs = {f"{n.func.value.id}.{n.func.attr}" for n in calls
             if isinstance(n.func, ast.Attribute)
             and isinstance(n.func.value, ast.Name)}
    assert "algo_client.is_srv" in attrs, "单条推理没为 srv: 分支"
    assert "algo_client.infer_spec" in attrs, \
        "单条推理没用 infer_spec——自己拆版本串很容易只拆一半"


# ── 默认模型不重复列 ──────────────────────────────────────────────────────


def test_default_model_has_no_spec():
    """默认模型的 spec 是 None。

    给它一个 srv:default 的话，同一个东西就有了两种写法，而两种写法
    存进库里是两个不同的 model_tag，对比表里会分成两列。
    """
    import ast
    import inspect

    from app.api.v1 import model_eval

    src = inspect.getsource(model_eval.server_models)
    assert 'None if m.get("is_default")' in src
    ast.parse(src.strip())


# ── 真实请求体 ────────────────────────────────────────────────────────────
#
# 上面那组把 infer_batch 整个替掉了，验的是"分发时带没带 model"。
# **发出去的 JSON 长什么样一条都没验**——把 `if model:` 改成 `if True:`
# （线上那三行也一直带 model）测试照样全绿，变异测试里活下来了。


class _FakeResp:
    status_code = 200

    def __init__(self, seen):
        self._seen = seen

    def json(self):
        return []


class _FakeClient:
    """够 algo_client 用的最小 httpx.AsyncClient。"""

    seen: dict = {}

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None):
        _FakeClient.seen = {"url": url, "json": json}
        return _FakeResp(_FakeClient.seen)


@pytest.fixture
def wire(monkeypatch):
    import httpx
    _FakeClient.seen = {}
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    return _FakeClient


def test_payload_omits_model_for_plain_modes(wire):
    """线上那三行发出去的 JSON 里**不能有 model 这个键**。

    一直带的话，老版本的算法服务（没有多模型）会因为多了个未知字段而 422——
    那是一次纯粹为了"保持接口一致"造成的故障。
    """
    asyncio.run(algo_client.infer_batch([{"path": "a.csv"}], mode="viterbi"))
    assert "model" not in wire.seen["json"], wire.seen["json"]
    assert wire.seen["json"]["mode"] == "viterbi"


def test_payload_carries_model_for_srv(wire):
    asyncio.run(algo_client.infer_spec([{"path": "a.csv"}], "srv:acc3@raw"))
    assert wire.seen["json"]["model"] == "acc3"
    assert wire.seen["json"]["mode"] == "raw"


# ── 下拉显示：别再被截断 ──────────────────────────────────────────────────
#
# 截断过一次，而且**截掉的恰好是区分它们的那部分**：三行端侧模型都显示成
# 「edge_cnn_i8 · …」，完全分不清谁是谁。


def _fe(*parts):
    import os
    return os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "src", *parts)


def _read(*parts):
    with open(_fe(*parts), encoding="utf-8") as f:
        return f.read()


def _code(*parts):
    """把注释剥掉之后的源码。

    **这个项目里"源码扫描撞上自己的注释"已经出过五次**，最近一次就是
    这一组：注释里写着 `popupMatchSelectWidth: false` 是关键，于是把那行
    真代码删掉测试照样绿。`//` 和 `/** */` 两种都要剥——上一版只剥了前者，
    而那段说明恰好是块注释。
    """
    import re

    src = _read(*parts)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)      # 块注释
    return "\n".join(ln.split("//", 1)[0] for ln in src.splitlines())


def test_dropdown_popup_is_not_tied_to_the_trigger_width():
    """antd 默认让弹出列表跟触发器一样宽，而触发器只有 150~190px。

    不关掉的话选项就会被截断——而截掉的是后半段，也就是真正区分
    「稳定版 v2 / 板上整条链 / 板上原始」的那部分。
    """
    code = _code("hooks", "useInferModes.ts")
    assert "popupMatchSelectWidth: false" in code, \
        "弹出列表又跟触发器一样宽了，选项会被截断"
    assert "popupMatchSelectWidth: true" not in code


def test_all_call_sites_share_one_set_of_select_props():
    """四个调用点共用一份展示参数。

    各写各的话，有的宽有的窄，而窄的那个会把选项截断——上次就是
    批量建任务那个 minWidth:150 出的问题，而另外三处看着都正常。
    """
    for f in (("pages", "Projects.tsx"), ("components", "AnnotationWorkspace.tsx")):
        src = _read(*f)
        assert "INFER_SELECT_PROPS" in src, f"{f[-1]} 没用共用的下拉参数"
        # 版本下拉不能再自己写死宽度
        assert "minWidth: 150 }} value={createInferMode}" not in src


def test_group_labels_stay_short():
    """分组标题也要短。

    弹出列表按**最长那一行**撑开，标题里塞一句解释会把整个列表撑得很宽，
    挤掉旁边的东西。三组分别是什么，问号里那张表讲。
    """
    import re

    labels = re.findall(r'label:\s*"([^"]+)"', _code("hooks", "useInferModes.ts"))
    groups = [x for x in labels if x.startswith(("算法服务", "端侧模型"))]
    assert groups, "没找到分组标题，这条测试该跟着改了"
    for g in groups:
        assert len(g) <= 14, f"分组标题太长会把弹出列表撑宽：{g}（{len(g)} 字）"


def test_server_models_are_labelled_by_tag_not_directory_name():
    """服务端模型用 tag 标，不用 name。

    name 是目录名（.../rf/ml_rf.pkl → "rf"），挂两个模型的话下拉里会出现
    两个一模一样的「rf · 稳定版 v2」，选哪个都不知道自己选了什么。
    """
    assert "${m.name} ·" not in _code("hooks", "useInferModes.ts"), \
        "服务端模型还在用目录名当标签"
