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
            continue            # 没给默认值的（比如 EDGE，默认就是关着）
        assert ":-" in v, (
            f"{name} 用的是 ${{X-默认}}，应该是 ${{X:-默认}}——"
            "照模板抄出来的 .env 里那行是空字符串，不是未定义")


def test_edge_service_defaults_to_off():
    """端侧服务**默认必须是关着的**，跟另外两个不一样。

    ALGO/VISION 是线上要用的，给默认地址是为了 `git pull && bash up.sh` 就能跑。
    端侧服务只在选型阶段起，给它一个默认地址的话，没起服务的机器上
    模型对比页会一直显示"端侧服务连不上"——一个常态化的红字警告，
    看久了就没人当回事了。
    """
    v = _compose_env()["EDGE_SERVICE_URL"]
    assert v.strip() in ("${EDGE_SERVICE_URL:-}", "${EDGE_SERVICE_URL}"), \
        f"EDGE_SERVICE_URL 的默认值不是空：{v}"


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
