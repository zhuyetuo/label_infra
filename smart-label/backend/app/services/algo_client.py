"""调用**算法服务**：`imu_train` 仓库里的 `label_service`。

/infer（同步，AI 预标注按钮）、/infer_batch（跑批）、/models（挂着哪些模型）、
/train + 轮询（提交训练任务）、/model/switch（换默认模型）。

## ⚠ 模块名和环境变量名是历史遗留，别被它们带偏

这个模块叫 `algo_client`、配置项叫 `ALGO_SERVICE_URL`、异常叫
`AlgoServiceError`——但它连的**不是** `algo_service` 那个仓库。

    平台（这里）  ──HTTP──▶  imu_train/label_service   ← 就是这个模块连的
                  ──HTTP──▶  algo_tinyml/edge_service  ← edge_client 连的

`algo_service` 是**另一条线**、跟平台没有调用关系：它是个定时服务，
定期从 TDengine 取项圈上报的 IMU 数据、推理完写进 MySQL
（pet_dog_behavior / pet_dog_daily_summary）。那是内测版本的做法——
项圈把原始 IMU 全传到服务端流量太大也费电，所以最终方向是端上推理。
**那个仓库基本不要动。**

名字不改是因为 `ALGO_SERVICE_URL` 已经写在各处部署配置里了，改名要同步改
部署，而漏改的表现是"AI 服务连不上"，跟改名这件事看不出关系。
下面的报错文案全部说「算法服务」，不说 algo_service——报错里写错服务名，
人会跑去查一个根本没参与的服务。

跟这个后端共享同一份 NAS 挂载，所以只传 sample 记录里已有的 NAS 相对路径，
不把 CSV 内容塞进请求体。
"""

import logging

import httpx

from app.core.config import settings

_logger = logging.getLogger("smart-label.algo_client")


class AlgoServiceError(Exception):
    pass


def _base_url() -> str:
    return settings.algo_service_url.rstrip("/")


#: 算法服务认的后处理版本。**加了新版本要在这里登记**——不登记的话
#: _mode() 会把它当成"没传"，**退回默认版本**，而结果存进库里标着新版本名。
#: 没有任何迹象，对比表里那一列其实是另一个版本跑的。
ALGO_MODES = ("raw", "stable", "viterbi", "stable_noshake", "viterbi_noshake")


def _mode(mode: str | None) -> str:
    return mode if mode in ALGO_MODES else settings.algo_infer_mode


# 服务端的**另一个模型**：srv:<标签>[@后处理]。
#
# 为什么要有这个写法：AI 服务原来只挂一个模型，"版本"这个字段说的全是后处理
# （稳定版 / 稳定版 v2 / 调试版）。现在想把两个服务端模型并排跑同一批样本做对比
# （比如只用加速计的那版），就得能在一次请求里指定模型。
#
# 用前缀而不是另开一个字段：对比、跑批、结果索引这几处现在都是按一个字符串走的，
# 加字段要改四五个地方，而每一处漏改都会表现成"这个版本的结果找不到"，
# 而不是报错。跟端侧那边的 edge: 一个道理。
SRV_PREFIX = "srv:"
_POST_SEP = "@"
# 服务端模型的默认后处理。**不是 raw**：要的是"处理机制跟稳定版 v2 一样，
# 只是模型不一样"。默认 raw 的话它会比线上那列碎一大截，而碎的原因是
# 后处理不同、不是模型不同——对比表看起来像这个模型差得多。
SRV_DEFAULT_POST = "viterbi"
_SRV_POSTS = ALGO_MODES


def is_srv(spec: str) -> bool:
    return str(spec or "").startswith(SRV_PREFIX)


def model_of(spec: str) -> str:
    """srv:acc3 → acc3；srv:acc3@raw → acc3"""
    if not is_srv(spec):
        return ""
    return str(spec)[len(SRV_PREFIX):].split(_POST_SEP, 1)[0]


def post_mode_of(spec: str) -> str:
    """版本串里带的后处理。**不认识的后缀报错，不当成默认**：
    悄悄降级的话，结果存进库里标着 @somethig，内容却是 viterbi 的，
    而这件事没有任何迹象。"""
    if not is_srv(spec):
        return ""
    rest = str(spec)[len(SRV_PREFIX):].split(_POST_SEP, 1)
    if len(rest) == 1:
        return SRV_DEFAULT_POST
    if rest[1] not in _SRV_POSTS:
        raise AlgoServiceError(
            f"版本 {spec} 里的后处理 {rest[1]!r} 不认识，只支持 {'/'.join(_SRV_POSTS)}")
    return rest[1]


async def models() -> list[dict]:
    """AI 服务现在挂着哪些模型（GET /api/v1/label/models）。

    列出来而不是写死：配置跟服务不同步时，界面上会出现一个选了就报错的选项，
    而错误是"没有这个模型"——绕一圈才知道是配置的事。

    服务没起/是老版本（没这个端点）时返回空列表，**不让整个页面 500**：
    多模型是可选功能，没有它下拉跟以前一模一样。
    """
    url = f"{_base_url()}/api/v1/label/models"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return []
        return list((resp.json() or {}).get("models") or [])
    except httpx.RequestError as e:
        _logger.warning("算法服务连不上 (%s): %s", url, e)
        return []


async def infer(
    imu_csv_path: str, sample_id: int | None = None, mode: str | None = None, device_hz: float | None = None
) -> dict:
    """同步调用算法服务 /infer，返回预标注的行为片段列表。mode 见 settings.algo_infer_mode。

    device_hz 是这份 CSV 的实际采样率：8-11 之前的数据采集端就已经降到 16Hz 存了，
    8-11 起才是 50Hz 原始流。不传的话 AI 服务用它的全局默认值，对另一种就是错的。
    """
    url = f"{_base_url()}/api/v1/label/infer"
    payload = {"path": imu_csv_path, "sample_id": sample_id, "mode": _mode(mode), "device_hz": device_hz}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.TimeoutException as e:
        raise AlgoServiceError(
            f"AI 服务推理超时（>{settings.algo_infer_timeout_sec}s），可能有其他推理在排队，稍后再试"
        ) from e
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /infer 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()


async def infer_spec(items: list[dict], spec: str) -> list[dict]:
    """按完整版本串（`srv:<标签>[@后处理]`）跑。

    **拆版本串这件事只能有一个地方做。** 调用方自己写 model=model_of(spec)
    的话，很容易漏掉 post_mode=post_mode_of(spec)——而漏掉之后一切照常：
    后处理默认就是 viterbi，结果看着完全正常，只有选了「调试版」的人
    拿到的其实是稳定版 v2 的结果。跟 edge_client.infer_spec 同一个道理。
    """
    return await infer_batch(items, mode=post_mode_of(spec), model=model_of(spec))


async def infer_batch(items: list[dict], mode: str | None = None,
                      model: str | None = None) -> list[dict]:
    """
    一批文件一次发给 /infer_batch，AI 服务那边进程池并行跑。返回跟 items 一一对应的
    [{sample_id, path, ok, error, result}]，result 结构跟 /infer 一样。单个文件失败
    只是那一项 ok=False，不会整批失败。
    """
    url = f"{_base_url()}/api/v1/label/infer_batch"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_batch_timeout_sec) as client:
            payload = {"items": items, "mode": _mode(mode)}
            if model:
                # **只在真要换模型时才带这个字段**。一直带的话，老版本的
                # AI 服务（没有多模型）会因为多了个未知字段而 422，
                # 而那是一次纯粹为了"保持接口一致"造成的故障
                payload["model"] = model
            resp = await client.post(url, json=payload)
    except httpx.TimeoutException as e:
        raise AlgoServiceError(
            f"AI 服务批量推理超时（{len(items)} 个 >{settings.algo_infer_batch_timeout_sec}s）"
        ) from e
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /infer_batch 返回 {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    if not isinstance(data, list):
        raise AlgoServiceError("算法服务 /infer_batch 返回格式不对（不是列表）")
    return data


async def start_train(dataset_spec: dict, model_type: str, tag: str | None = None) -> int:
    """提交训练任务，返回算法服务那边的 job_id。"""
    url = f"{_base_url()}/api/v1/label/train"
    payload = {"dataset": dataset_spec, "model_type": model_type, "tag": tag}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e

    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /train 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()["job_id"]


async def switch_model(model_path: str) -> dict:
    """让 AI 服务运行时切到这个模型（重建进程池）。重启服务会回到它自己配置的 LABEL_MODEL。"""
    url = f"{_base_url()}/api/v1/label/model/switch"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json={"model_path": model_path})
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e
    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /model/switch 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()


async def poll_train(algo_job_id: int) -> dict:
    """查询算法服务那边训练任务的当前状态。"""
    url = f"{_base_url()}/api/v1/label/train/{algo_job_id}"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_service_timeout_sec) as client:
            resp = await client.get(url)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e

    if resp.status_code == 404:
        raise AlgoServiceError(f"算法服务找不到训练任务 #{algo_job_id}")
    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /train/{algo_job_id} 返回 {resp.status_code}: {resp.text[:500]}")
    return resp.json()


async def get_remap() -> dict:
    """训练时那张类别重映射表。**用来告诉人"这一类最后会变成什么"。**

    表里没有的类别，训练脚本会直接把那些样本丢掉，只在训练日志里打一句——
    界面上不说的话，人只会以为数据都进去了。实测 2026-09-23：那张表用的还是
    旧模板的名字（舔身体/甩身体/蹭擦身体），现在模板发的是「舔」「甩头/抖身」
    「蹭」，对不上，全被丢了。

    连不上不算事故：拿不到表就不显示"会变成什么"，提交训练照常。
    """
    url = f"{_base_url()}/api/v1/label/remap"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"算法服务 /remap 返回 {resp.status_code}", "table": {}, "classes": []}
        return resp.json()
    except httpx.RequestError as e:
        return {"available": False, "error": f"连不上算法服务（imu_train 的 label_service）: {e}",
                "table": {}, "classes": []}


async def train_log(algo_job_id: int, offset: int = 0) -> dict:
    """从 offset 往后读训练日志（算法服务按偏移给一段，前端拼起来就是实时滚动）。"""
    url = f"{_base_url()}/api/v1/label/train/{algo_job_id}/log"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params={"offset": offset})
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e
    if resp.status_code == 404:
        raise AlgoServiceError(f"算法服务找不到训练任务 #{algo_job_id}（可能已经在算法机上删掉了）")
    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /train/{algo_job_id}/log 返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


class AlgoConflict(AlgoServiceError):
    """算法服务说这一版现在不能删（还在跑 / 正在用）。原因要原样给人看。"""


async def delete_train(algo_job_id: int) -> dict:
    """删掉算法机上这一版训练的全部产物。已经不在了（404）当成删成功。"""
    url = f"{_base_url()}/api/v1/label/train/{algo_job_id}"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.delete(url)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e
    if resp.status_code == 404:
        return {"deleted": []}
    if resp.status_code == 409:
        try:
            detail = resp.json().get("detail")
        except Exception:  # noqa: BLE001
            detail = resp.text[:300]
        raise AlgoConflict(str(detail))
    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 DELETE /train/{algo_job_id} 返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def cancel_train(algo_job_id: int) -> dict:
    """停掉算法机上一个排队中/在跑的训练（整个进程组一起停）。返回停之后的任务状态。"""
    url = f"{_base_url()}/api/v1/label/train/{algo_job_id}/cancel"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url)
    except httpx.RequestError as e:
        raise AlgoServiceError(f"连不上算法服务（imu_train 的 label_service）({url}): {e}") from e
    if resp.status_code == 404:
        raise AlgoServiceError(f"算法服务找不到训练任务 #{algo_job_id}")
    if resp.status_code != 200:
        raise AlgoServiceError(f"算法服务 /train/{algo_job_id}/cancel 返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()
