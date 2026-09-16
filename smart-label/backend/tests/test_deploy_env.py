"""部署配置：Settings 里的每一项，都要真能从环境变量传进容器。

这一层没人测过，而它**失效的时候完全不报错**：

compose 里是**显式列举**环境变量的（`ALGO_SERVICE_URL: ${ALGO_SERVICE_URL:-...}`），
不是自动把 .env 透进去。所以往 .env 加一行新变量而忘了加到 compose，
后端读到的是默认值——功能"配了但没生效"，界面上看不出任何异常。

EDGE_SERVICE_URL 这次差点就这样：我让人往 .env 加一行，而 compose 里根本没有
那一项，加了也传不进去。
"""

import os
import re

import pytest

DEPLOY = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "deploy"))
COMPOSE = os.path.join(DEPLOY, "docker-compose.yml")
ENV_EXAMPLE = os.path.join(DEPLOY, ".env.example")

pytestmark = pytest.mark.skipif(
    not os.path.exists(COMPOSE), reason=f"找不到 {COMPOSE}")


def _compose_env():
    """api 服务的 environment 段，{名字: 原始值}。

    不用 yaml 解析：deploy 目录可能有 compose 的扩展语法，而这里只需要
    "这个名字在不在里面"。正则足够，也不引依赖。
    """
    src = open(COMPOSE, encoding="utf-8").read()
    return dict(re.findall(r"^\s{6}([A-Z][A-Z0-9_]*):\s*(.*)$", src, re.M))


def _env_example_keys():
    src = open(ENV_EXAMPLE, encoding="utf-8").read()
    return {m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", src, re.M)}


# 这些是「后端要读、必须从外面传进来」的。加新的服务地址时同步加到这里——
# 漏了的话下面那两条会红，而不是等到部署之后发现功能没生效
SERVICE_URLS = ["ALGO_SERVICE_URL", "VISION_SERVICE_URL", "EDGE_SERVICE_URL"]


@pytest.mark.parametrize("name", SERVICE_URLS)
def test_service_url_is_listed_in_compose(name):
    """compose 不会自动把 .env 透进容器——每一项都要显式列出来。

    漏了的表现是"配了但没生效"，而且没有任何报错：后端拿到默认值，
    功能静静地关着。
    """
    env = _compose_env()
    assert name in env, (
        f"{name} 不在 docker-compose.yml 的 environment 里。\n"
        "  只往 .env 加一行是不够的——compose 是显式列举的，"
        "不列出来就传不进容器，而且不报错。")


@pytest.mark.parametrize("name", SERVICE_URLS)
def test_service_url_is_documented_in_env_example(name):
    """.env.example 是每台机器抄一份的模板。不在里面的变量，
    没人会知道它存在。"""
    assert name in _env_example_keys(), f"{name} 不在 .env.example 里"


def test_compose_uses_colon_dash_for_defaults():
    """默认值要用 `${X:-默认}` 而不是 `${X-默认}`。

    现成的 .env 是照 .env.example 抄的，里面那行是**空字符串**而不是不存在。
    `${X-默认}` 只在变量**未定义**时才落到默认值，空字符串会原样传进去——
    于是"抄了模板没填"和"显式设成空"变成同一件事，而默认值永远用不上。
    """
    env = _compose_env()
    for name in SERVICE_URLS:
        v = env.get(name, "")
        if "-" not in v:
            continue            # 没给默认值的（现在三个都给了，留着以防以后加）
        assert ":-" in v, (
            f"{name} 用的是 ${{X-默认}}，应该是 ${{X:-默认}}——"
            "照模板抄出来的 .env 里那行是空字符串，不是未定义")


def test_edge_service_has_a_default_address_like_the_others():
    """端侧服务跟 ALGO/VISION 一样给默认地址：`git pull && bash up.sh` 就能用。

    我原来在这里断言的是"默认必须是关着的"，理由是"没起服务的机器上会一直
    显示连不上"。**那条理由站不住**：同样的情况对 VISION 也成立，
    而团队早就选了给默认地址那条路——"服务起着就能用，不用在这儿填"。
    为一个可选服务要求每台机器手填一次，比偶尔看到一个小提示成本高。

    留空已经不能用来关掉它了（${X:-默认} 会落到默认值上），
    所以要显式关就填 off —— 跟 VISION 同一套写法。
    """
    v = _compose_env()["EDGE_SERVICE_URL"].strip()
    assert v.startswith("${EDGE_SERVICE_URL:-http"), \
        f"EDGE_SERVICE_URL 没给默认地址：{v}"


def test_off_switch_actually_disables_the_edge_service(monkeypatch):
    """既然默认地址baked in 了，`off` 就是唯一的关闭方式——它必须真的管用。

    不管用的话，想关的人填了 off，后端会把 "off" 当成主机名去连，
    报一个"连不上 http://off/..."，而那看着像网络问题不像配置问题。
    """
    from app.services import edge_client
    for v in ("off", "OFF", "none", "false", "0", ""):
        monkeypatch.setattr(edge_client.settings, "edge_service_url", v,
                            raising=False)
        assert edge_client.enabled() is False, f"{v!r} 没能关掉端侧服务"
    monkeypatch.setattr(edge_client.settings, "edge_service_url",
                        "http://x:8900", raising=False)
    assert edge_client.enabled() is True


def test_settings_field_matches_the_env_name():
    """Settings 里的字段名跟环境变量名要对得上（pydantic 按大写匹配）。

    对不上的话配置传进容器了、后端也没报错，只是那个值永远读不到——
    跟没配一模一样。
    """
    from app.core.config import Settings
    fields = set(Settings.model_fields)
    for name in SERVICE_URLS:
        assert name.lower() in fields, \
            f"环境变量 {name} 在 Settings 里没有对应字段 {name.lower()}"


# ── up.sh 不能承诺它没验证过的事 ──────────────────────────────────────────


def _up_sh() -> str:
    p = os.path.join(os.path.dirname(__file__), "..", "..", "deploy", "up.sh")
    with open(p, encoding="utf-8") as f:
        return f.read()


def test_up_sh_waits_for_the_services_to_actually_answer():
    """容器 Started ≠ 服务能用。

    api 起来之后还要 import 一堆东西、连 MySQL、建连接池。以前脚本在
    `docker compose up -d` 之后直接打"=== 已启动 ===" 加地址，而那时候点进去
    是白屏——**脚本承诺了它没验证过的事**。看到成功横幅的人会以为坏的是
    别的地方，然后去查一个根本不存在的问题。
    """
    s = _up_sh()
    assert "/health" in s, "没有等 api 的健康检查"
    assert "curl" in s, "没有真的去请求，那就只是 sleep 猜时间"


def test_up_sh_does_not_print_success_when_it_is_not_ready():
    """没起来时**不能**打成功横幅。

    照旧打一遍地址、让人对着白屏猜是不是自己电脑的问题，
    比不打还糟。
    """
    s = _up_sh()
    assert "有服务没起来" in s, "没起来时没有区别对待"
    # 成功那句话只能出现在 READY=0 的分支里
    i_ok = s.find("可以用了")
    i_bad = s.find("有服务没起来")
    assert i_ok >= 0 and i_bad >= 0
    assert 'if [ "$READY" = 0 ]' in s, "没有按就绪状态分支"


def test_up_sh_exits_nonzero_when_not_ready():
    """没起来要用退出码说出来——脚本套在别的命令里时，
    静默成功会让后面的步骤接着跑。"""
    s = _up_sh()
    assert 'exit 1' in s, "没起来也返回 0，调用方看不出来"


def test_up_sh_tells_you_where_to_look():
    """失败时要说去哪看，不是只说失败。"""
    s = _up_sh()
    assert "docker compose logs" in s
