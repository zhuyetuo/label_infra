"""
调用 algo_service（独立部署的算法服务，通过 HTTP 访问，不合并进本仓库）的
两个接口：/infer（同步，AI预标注按钮用）、/train + 轮询（提交训练任务）。

algo_service 跟这个后端共享同一份 NAS 挂载，这里只传 sample 记录里已有的
NAS 相对路径，不把 CSV 文件内容塞进请求体。
"""

import logging

import httpx

from app.core.config import settings

_logger = logging.getLogger("smart-label.algo_client")


class AlgoServiceError(Exception):
    pass


def _base_url() -> str:
    return settings.algo_service_url.rstrip("/")


def _mode(mode: str | None) -> str:
    return mode if mode in ("raw", "stable") else settings.algo_infer_mode


async def infer(imu_csv_path: str, sample_id: int | None = None, mode: str | None = None) -> dict:
    """同步调用 algo_service /infer，返回预标注的行为片段列表。mode 见 settings.algo_infer_mode。"""
    url = f"{_base_url()}/api/v1/label/infer"
    payload = {"path": imu_csv_path, "sample_id": sample_id, "mode": _mode(mode)}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.TimeoutException as e:
        raise AlgoServiceError(
            f"AI 服务推理超时（>{settings.algo_infer_timeout_sec}s），可能有其他推理在排队，稍后再试"
        ) from e
    except httpx.RequestError as e:
        raise AlgoServiceError(f"无法连接 algo_service ({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"algo_service /infer 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()


async def infer_batch(items: list[dict], mode: str | None = None) -> list[dict]:
    """
    一批文件一次发给 /infer_batch，AI 服务那边进程池并行跑。返回跟 items 一一对应的
    [{sample_id, path, ok, error, result}]，result 结构跟 /infer 一样。单个文件失败
    只是那一项 ok=False，不会整批失败。
    """
    url = f"{_base_url()}/api/v1/label/infer_batch"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_batch_timeout_sec) as client:
            resp = await client.post(url, json={"items": items, "mode": _mode(mode)})
    except httpx.TimeoutException as e:
        raise AlgoServiceError(
            f"AI 服务批量推理超时（{len(items)} 个 >{settings.algo_infer_batch_timeout_sec}s）"
        ) from e
    except httpx.RequestError as e:
        raise AlgoServiceError(f"无法连接 algo_service ({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"algo_service /infer_batch 返回 {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    if not isinstance(data, list):
        raise AlgoServiceError("algo_service /infer_batch 返回格式不对（不是列表）")
    return data


async def start_train(dataset_spec: dict, model_type: str, tag: str | None = None) -> int:
    """提交训练任务，返回 algo_service 那边的 job_id。"""
    url = f"{_base_url()}/api/v1/label/train"
    payload = {"dataset": dataset_spec, "model_type": model_type, "tag": tag}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"无法连接 algo_service ({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"algo_service /train 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()["job_id"]


async def poll_train(algo_job_id: int) -> dict:
    """查询 algo_service 那边训练任务的当前状态。"""
    url = f"{_base_url()}/api/v1/label/train/{algo_job_id}"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.get(url)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"无法连接 algo_service ({url}): {e}") from e

    if resp.status_code == 404:
        raise AlgoServiceError(f"algo_service 找不到训练任务 #{algo_job_id}")
    if resp.status_code != 200:
        raise AlgoServiceError(f"algo_service /train/{algo_job_id} 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()
