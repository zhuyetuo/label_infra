"""调端侧推理服务（algo_tinyml 的 edge_service.py）。

跟 algo_client 的关系：**接口一模一样，服务不是同一个**。

为什么不塞进 algo_client：那个连的是 algo_service，线上服务，不能动。
端侧模型跑的是固件那份 C（tm_prep + tm_invoke，或 tm_features + tm_forest），
从 algo_tinyml 单独起一个服务，这里单独连过去。两边共享同一份 NAS 挂载，
所以接口里传的还是相对路径，不传文件内容。

**后处理跟线上是同一份代码**：端侧服务的 stable/viterbi 直接调
imu_train/label_service/postprocess.py，不是另抄一份。所以「端侧 + 稳定版 v2」
跟线上的「稳定版 v2」之间**只差模型**，对比表里比的才是模型本身。

默认就走 viterbi（= 界面上的稳定版 v2）。想看板子真实会报的碎片段，
用 `edge:<标签>@raw`——那是端上没有后处理时的样子。
"""

import logging

import httpx

from app.core.config import settings

_logger = logging.getLogger("smart-label.edge_client")

# 端侧模型在模型对比里的"版本"写法：edge:<标签>。
# 用前缀区分而不是另开一个字段，是因为对比、跑批、结果索引这几处
# 现在都是按一个字符串走的——加字段要改四五个地方，而每一处漏改
# 都会表现成"这个版本的结果找不到"，而不是报错。
EDGE_PREFIX = "edge:"


class EdgeServiceError(Exception):
    pass


def is_edge(spec: str) -> bool:
    return str(spec or "").startswith(EDGE_PREFIX)


# 端侧的默认后处理。**不是 raw**：用户要的是"处理机制跟稳定版 v2 一样，
# 只是模型不一样"。默认 raw 的话，端侧那列会比线上碎一大截，而碎的原因
# 是后处理不同、不是模型不同——对比表看起来像是端侧模型差得多。
EDGE_DEFAULT_POST = "viterbi"
_POST_SEP = "@"
# board = 用**板子上那份后处理**（algo_tinyml 的 core/tm_post.c）而不是
# 服务端的 Python。选 edge:<标签> 时模型和推理已经是板上那份 C 了，
# 但后处理还是服务端的；@board 把最后这一段也换成板上的，
# 于是整条链都是板子会跑的东西——手里没有板子时，这是唯一能拿真实数据
# 回答"板子会报什么"的办法。
_POST_MODES = ("raw", "stable", "viterbi", "board")


def model_of(spec: str) -> str:
    """edge:edge_cnn_i8 → edge_cnn_i8；edge:edge_cnn_i8@raw → edge_cnn_i8"""
    if not is_edge(spec):
        return ""
    return str(spec)[len(EDGE_PREFIX):].split(_POST_SEP, 1)[0]


def post_mode_of(spec: str) -> str:
    """版本串里带的后处理：edge:x@stable → stable，没带就是默认的。

    不认识的后缀**报错，不当成默认**：悄悄降级的话，结果存进库里标着
    `@somethig`，内容却是 viterbi 的，而这件事没有任何迹象。
    """
    if not is_edge(spec):
        return ""
    rest = str(spec)[len(EDGE_PREFIX):].split(_POST_SEP, 1)
    if len(rest) == 1:
        return EDGE_DEFAULT_POST
    mode = rest[1]
    if mode not in _POST_MODES:
        raise EdgeServiceError(
            f"端侧版本 {spec} 里的后处理 {mode!r} 不认识，"
            f"只支持 {'/'.join(_POST_MODES)}")
    return mode


# 跟 vision_sam_client 用同一套写法：compose 里给了默认地址，所以"留空"已经
# 不能用来关掉它了（${X:-默认} 会落到默认值上）。要显式关就填 off。
_OFF = {"off", "none", "disabled", "0", "false"}


def enabled() -> bool:
    v = (settings.edge_service_url or "").strip()
    return bool(v) and v.lower() not in _OFF


def _base_url() -> str:
    if not enabled():
        raise EdgeServiceError(
            "端侧推理服务关着（EDGE_SERVICE_URL 是空或 off），端侧模型用不了。\n"
            "  在 algo_tinyml 那台起 edge_service.py，默认地址是 8900 端口。")
    return settings.edge_service_url.rstrip("/")


async def available() -> list[dict]:
    """问端侧服务现在挂着哪些模型。

    列出来而不是写死在配置里：配置跟服务不同步时，界面上会出现一个选了
    就报错的选项，而错误信息是"没有这个端侧模型"——绕一圈才知道是配置的事。
    """
    if not enabled():
        return []
    url = f"{_base_url()}/health"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return []
        return list((resp.json() or {}).get("models") or [])
    except httpx.RequestError as e:
        # 端侧服务没起不该让整个页面 500——它是可选的
        _logger.warning("端侧服务连不上 (%s): %s", url, e)
        return []


async def infer_batch(items: list[dict], model: str, post_mode: str = EDGE_DEFAULT_POST,
                      labels: list[str] | None = None,
                      min_windows: int = 1, max_gap: int = 2) -> list[dict]:
    """一批文件发过去，返回跟 items 一一对应的
    [{sample_id, path, ok, error, result}]，result 结构跟 algo_service 的 /infer 一样。

    单个文件失败只是那一项 ok=False，不会整批失败——一个坏 CSV 让一整天的
    样本全部白跑是最没必要的一种损失。
    """
    url = f"{_base_url()}/api/v1/label/infer_batch"
    payload = {
        "items": items, "mode": post_mode, "model": model,
        "min_windows": min_windows, "max_gap": max_gap,
    }
    if labels:
        payload["labels"] = labels
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_batch_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.TimeoutException as e:
        raise EdgeServiceError(
            f"端侧推理超时（{len(items)} 个 >{settings.algo_infer_batch_timeout_sec}s）"
        ) from e
    except httpx.RequestError as e:
        raise EdgeServiceError(f"连不上端侧服务 ({url}): {e}") from e

    if resp.status_code != 200:
        raise EdgeServiceError(f"端侧服务返回 {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    if not isinstance(data, list):
        raise EdgeServiceError("端侧服务 /infer_batch 返回格式不对（不是列表）")
    return data


async def infer_spec(items: list[dict], spec: str, **edge_kw) -> list[dict]:
    """按完整版本串（`edge:<标签>[@后处理]`）跑端侧推理。

    **拆版本串这件事只能有一个地方做。** 调用方自己写
    `model=model_of(spec)` 的话，很容易漏掉 `post_mode=post_mode_of(spec)`——
    而漏掉之后一切照常：后处理默认就是 viterbi，结果看着完全正常，
    只有选了「板上原始」的人拿到的其实是稳定版 v2 的结果。
    **两者的区别是片段碎不碎，而碎不碎会被读成模型好坏。**
    （这正是 infer_sample / _run 两处最初的写法，没有任何迹象。）
    """
    return await infer_batch(items, model=model_of(spec),
                             post_mode=post_mode_of(spec), **edge_kw)


async def dispatch_batch(items: list[dict], mode: str | None,
                         **edge_kw) -> list[dict]:
    """按版本字符串选 client：`edge:<标签>` 走端侧，其余走 algo_service。

    **抽出来是因为这段逻辑有三个调用点**（项目批量预标注、工作台单条、
    模型对比跑批），抄几份的话迟早有一份漏改——而漏改的表现是：
    `edge:xxx` 发给 algo_service，它认不出这个 mode，多半按默认的 stable 跑。
    结果存进库里，标签写的是端侧模型，内容却是线上模型。**没有任何迹象。**

    `srv:<标签>` 也走 algo_service，但**要带上模型标签**——不带的话它跑的是
    默认模型，结果却标着 srv:acc3。**没有任何迹象。**

    返回的结构三条路一样：[{sample_id, path, ok, error, result}]。
    """
    from app.services import algo_client

    if is_edge(mode):
        return await infer_spec(items, mode, **edge_kw)
    if algo_client.is_srv(mode):
        return await algo_client.infer_spec(items, mode)
    return await algo_client.infer_batch(items, mode=mode)
