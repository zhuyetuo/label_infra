"""调端侧推理服务（algo_tinyml 的 edge_service.py）。

跟 algo_client 的关系：**接口一模一样，服务不是同一个**。

为什么不塞进 algo_client：那个连的是 algo_service，线上服务，不能动。
端侧模型跑的是固件那份 C（tm_prep + tm_invoke，或 tm_features + tm_forest），
从 algo_tinyml 单独起一个服务，这里单独连过去。两边共享同一份 NAS 挂载，
所以接口里传的还是相对路径，不传文件内容。

端侧服务**只有 raw**，没有 stable/viterbi——那两个是 algo_service 的后处理，
板子上不存在。传别的 mode 过去会被它明确拒绝，不会悄悄当成 raw 处理；
这是故意的，否则模型对比里两列看着可比、实际不是一回事。
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


def model_of(spec: str) -> str:
    """edge:edge_cnn_i8 → edge_cnn_i8"""
    return str(spec)[len(EDGE_PREFIX):] if is_edge(spec) else ""


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


async def infer_batch(items: list[dict], model: str, labels: list[str] | None = None,
                      min_windows: int = 1, max_gap: int = 2) -> list[dict]:
    """一批文件发过去，返回跟 items 一一对应的
    [{sample_id, path, ok, error, result}]，result 结构跟 algo_service 的 /infer 一样。

    单个文件失败只是那一项 ok=False，不会整批失败——一个坏 CSV 让一整天的
    样本全部白跑是最没必要的一种损失。
    """
    url = f"{_base_url()}/api/v1/label/infer_batch"
    payload = {
        "items": items, "mode": "raw", "model": model,
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


async def dispatch_batch(items: list[dict], mode: str | None,
                         **edge_kw) -> list[dict]:
    """按版本字符串选 client：`edge:<标签>` 走端侧，其余走 algo_service。

    **抽出来是因为这段逻辑有两个调用点**（项目批量预标注、模型对比跑批），
    抄两份的话迟早有一份漏改——而漏改的表现是：`edge:xxx` 发给 algo_service，
    它认不出这个 mode，多半按默认的 stable 跑。结果存进库里，标签写的是端侧
    模型，内容却是线上模型。**没有任何迹象。**

    返回的结构两边一样：[{sample_id, path, ok, error, result}]。
    """
    from app.services import algo_client

    if is_edge(mode):
        return await infer_batch(items, model=model_of(mode), **edge_kw)
    return await algo_client.infer_batch(items, mode=mode)
