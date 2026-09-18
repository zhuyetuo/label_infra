"""
调 imu_train/vision_service 的 SAM 辅助分割。

这是个**可选依赖**：没配 VISION_SERVICE_URL 就是关着的，配了但调不通就是暂时
不可用。两种情况都不是错误，页面把按钮置灰、其它功能照常——所以这里的每一条
失败路径都返回"不可用 + 原因"，而不是抛出去变成 500。

跟 algo_client 的区别：那个是 IMU 推理，必须通；这个通不通都不影响标注员干活。
"""

import httpx

from app.core.config import settings

# SAM 单张几十到几百毫秒，慢的时候（冷启动加载模型）可能到十几秒。
# 给 30 秒：再长说明那边有问题，与其让标注员对着转圈，不如早点告诉他。
_TIMEOUT = 30.0


#: 显式关掉 SAM 的写法。
#
# 为什么需要它：compose 那边给 VISION_SERVICE_URL 配了默认值（不然每台机器
# 都要手填一次，忘了就只看到按钮灰着），而 compose 的 ${VAR:-默认} 把「空字符串」
# 也当成没设——于是「设成空 = 关掉」这条路没了。这里补一个明说的开关。
_OFF = {"off", "0", "false", "no", "none", "disabled"}


def enabled() -> bool:
    v = (settings.vision_service_url or "").strip()
    return bool(v) and v.lower() not in _OFF


async def status() -> dict:
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/sam/status"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"SAM 服务返回 {resp.status_code}"}
        return resp.json()
    except Exception as e:  # noqa: BLE001 - 连不上/超时/返回不是 JSON，对用户都是"暂时用不了"
        return {"available": False, "error": f"连不上 SAM 服务：{type(e).__name__}"}


def _off_reason() -> str:
    """「没配」和「特意关掉的」要分得开——前者是漏了一步，后者是有人这么决定的。
    运维看到「没有配」会去查配置，看到「被显式关掉」才知道该去问是谁关的。"""
    v = (settings.vision_service_url or "").strip()
    if v and v.lower() in _OFF:
        return f"SAM 辅助被显式关掉了（VISION_SERVICE_URL={v}）"
    return "没有配 VISION_SERVICE_URL，SAM 辅助是关着的"


class SamUnavailable(Exception):
    """SAM 暂时用不了。调用方据此返回 503，让前端置灰按钮而不是弹红叉。"""


async def segment(material_rel_path: str, points: list[dict], box: list[float] | None = None) -> dict:
    """material_rel_path 是相对素材库根目录的路径（带相册目录那一层）。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/sam/segment"
    payload = {"path": material_rel_path, "points": points}
    if box:
        payload["box"] = box
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=payload)
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上 SAM 服务：{type(e).__name__}") from e

    if resp.status_code == 503:
        # 服务在，但模型没加载（没装 sam2 / 没下权重）。把那边的原话带回来，
        # 不然运维只能两头猜
        raise SamUnavailable(_detail(resp) or "SAM 模型不可用")
    if resp.status_code != 200:
        raise SamUnavailable(f"SAM 服务返回 {resp.status_code}：{_detail(resp)}")
    try:
        data = resp.json()
    except Exception as e:  # noqa: BLE001 - 200 但不是 JSON：多半是中间挡了个网关/登录页
        raise SamUnavailable(f"SAM 服务返回的不是 JSON（是不是中间挡了代理）：{type(e).__name__}") from e
    if not isinstance(data, dict):
        raise SamUnavailable("SAM 服务返回的不是一个对象")
    return data


def _detail(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("detail") or "")
    except Exception:  # noqa: BLE001
        return resp.text[:200]


# ── 画面狗检测 ─────────────────────────────────────────────────────────
#
# 跟 SAM 同一个服务、同一个开关（VISION_SERVICE_URL），所以复用 enabled()。
# 但超时不一样：SAM 是交互式的，人在等；扫描是后台任务，一小时的视频按 5 秒
# 采样要跑几十秒到几分钟。用 SAM 那个 30 秒会把正常的扫描全判成超时。
_SCAN_TIMEOUT = 600.0


async def dog_status() -> dict:
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/dog/status"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}"}
        return resp.json()
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}"}


async def scan_dog(video_rel_path: str, every_sec: float = 5.0, conf: float = 0.35) -> dict:
    """扫一路视频里有没有狗。video_rel_path 相对采集 NAS 根（不是素材库）。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/dog/scan"
    try:
        async with httpx.AsyncClient(timeout=_SCAN_TIMEOUT) as client:
            resp = await client.post(url, json={"path": video_rel_path, "every_sec": every_sec, "conf": conf})
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code == 503:
        # 模型没装/没起。**必须跟"扫出来没狗"分开**——后者会让人跳过一整段
        # 真有素材的视频
        raise SamUnavailable(_detail(resp) or "视觉服务里的狗检测不可用")
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.json()


def _detail(resp) -> str:
    try:
        return str(resp.json().get("detail", ""))[:300]
    except Exception:  # noqa: BLE001
        return resp.text[:300]


# ── 画面找片段（视觉大模型走 API） ──────────────────────────────────────
#
# 一小时视频：那边本地筛选一两分钟，再按 max_clips 送去问模型，几段并行、
# 每段一两秒。给半小时的超时——它是后台任务，没人在页面上干等。
_SEEK_TIMEOUT = 1800.0


async def seek_status() -> dict:
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/seek/status"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}"}
        return resp.json()
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}"}


async def seek_video(video_rel_path: str, labels: list[dict], **params) -> dict:
    """在一路视频里找像 labels 里那些行为的片段。labels: [{name, description, parts}]。
    params 原样透传（max_clips / dry_run / start_s / end_s / min_conf ...）。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/seek"
    try:
        async with httpx.AsyncClient(timeout=_SEEK_TIMEOUT) as client:
            resp = await client.post(url, json={"path": video_rel_path, "labels": labels, **params})
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code == 503:
        raise SamUnavailable(_detail(resp) or "视觉服务里的找片段不可用")
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.json()


async def llm_test(llm: dict) -> dict:
    """让视觉服务用这把 key 发一句最短的话，看通不通。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/llm/test"
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json={"llm": llm})
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.json()


# ── 画面向量索引（以图搜图 / 一句话搜） ──────────────────────────────────
_EMBED_BUILD_TIMEOUT = 1800.0


async def embed_status() -> dict:
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/embed/status"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}"}
        return resp.json()
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}"}


async def _post(path: str, body: dict, timeout: float) -> dict:
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body)
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code == 503:
        raise SamUnavailable(_detail(resp) or "视觉服务这一项不可用")
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.json()


async def embed_build(video_rel_path: str, every_sec: float = 1.0, force: bool = False) -> dict:
    return await _post("/api/v1/embed/build", {"path": video_rel_path, "every_sec": every_sec, "force": force},
                       _EMBED_BUILD_TIMEOUT)


async def embed_indexed(paths: list[str]) -> dict[str, bool]:
    if not paths:
        return {}
    return await _post("/api/v1/embed/indexed", {"paths": paths}, 30)


async def embed_search(paths: list[str], *, text: str | None = None, ref: dict | None = None,
                       top_k: int = 50, min_score: float = 0.0, gap_s: float = 3.0,
                       exclude_self_s: float = 10.0) -> dict:
    body = {"paths": paths, "top_k": top_k, "min_score": min_score, "gap_s": gap_s, "exclude_self_s": exclude_self_s}
    if text is not None:
        body["text"] = text
    if ref is not None:
        body["ref"] = ref
    return await _post("/api/v1/embed/search", body, 120)


async def embed_preview(video_rel_path: str, t_s: float) -> dict:
    """以图搜图前给人看：这一帧框到了哪几只狗、拿哪一块去搜。只要狗检测模型，几百毫秒。"""
    return await _post("/api/v1/embed/preview", {"path": video_rel_path, "t": t_s}, 30)
