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


async def segment(material_rel_path: str, points: list[dict], box: list[float] | None = None,
                  refine: str | None = None, exclude: list | None = None) -> dict:
    """material_rel_path 是相对素材库根目录的路径（带相册目录那一层）。refine="gingiva" 是牙龈专用修整。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/sam/segment"
    payload = {"path": material_rel_path, "points": points}
    if box:
        payload["box"] = box
    if refine:
        payload["refine"] = refine
    if exclude:
        payload["exclude"] = exclude
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


async def scan_dog(video_rel_path: str, every_sec: float = 5.0, conf: float = 0.2) -> dict:
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


# ── 大模型看视频找动作（视觉大模型走 API） ──────────────────────────────────────
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


async def embed_build(video_rel_path: str, every_sec: float = 1.0, force: bool = False,
                      mode: str | None = None) -> dict:
    """mode: fine = 每秒一帧（慢、全）/ fast = 只解关键帧（快、稀）。None = 用算法服务的默认。"""
    body: dict = {"path": video_rel_path, "every_sec": every_sec, "force": force}
    if mode:
        body["mode"] = mode
    return await _post("/api/v1/embed/build", body, _EMBED_BUILD_TIMEOUT)


async def embed_indexed(paths: list[str]) -> dict[str, bool]:
    if not paths:
        return {}
    return await _post("/api/v1/embed/indexed", {"paths": paths}, 30)


async def embed_search(paths: list[str], *, text: str | None = None, ref: dict | None = None,
                       top_k: int = 50, min_score: float = 0.0, gap_s: float = 3.0,
                       exclude_self_s: float = 10.0, center: bool = True, pose_w: float | None = None,
                       part: str | None = None) -> dict:
    body = {"paths": paths, "top_k": top_k, "min_score": min_score, "gap_s": gap_s, "exclude_self_s": exclude_self_s,
            "center": center}
    if pose_w is not None:
        body["pose_w"] = pose_w
    if part:
        body["part"] = part
    if text is not None:
        body["text"] = text
    if ref is not None:
        body["ref"] = ref
    return await _post("/api/v1/embed/search", body, 120)


async def embed_preview(video_rel_path: str, t_s: float) -> dict:
    """以图搜图前给人看：这一帧框到了哪几只狗、拿哪一块去搜。只要狗检测模型，几百毫秒。"""
    return await _post("/api/v1/embed/preview", {"path": video_rel_path, "t": t_s}, 30)


async def embed_thumb(video_rel_path: str, t_s: float, crop: bool = True, max_side: int | None = None,
                      view: str | None = None) -> bytes:
    """某视频某一秒的缩略图 JPEG。view = mask（抠掉背景的那块）/ raw（那块原图）/ pose（画骨架）/
    box（整帧带框）；不给就按 crop 老规矩（True=mask，False=box）。给"先看命中"那一排图用。"""
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/embed/thumb"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            params = {"path": video_rel_path, "t": t_s, "crop": "true" if crop else "false"}
            if view:
                params["view"] = view
            if max_side:
                params["max_side"] = max_side      # 划区域要整帧看得清，缩略图那种 320 不够
            resp = await client.get(url, params=params)
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.content


# ── 本地模型集中管理（「模型服务」页）────────────────────────────────
async def models_overview() -> dict:
    """算法机上的本地模型一张表。视觉服务没配 / 连不上时不抛，返回 available=False 让页面说明。"""
    if not enabled():
        return {"available": False, "error": _off_reason(), "models": []}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}", "models": []}
        return {"available": True, "error": None, **resp.json()}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}", "models": []}


async def models_act(key: str, action: str) -> dict:
    """加载 / 卸载 / 测试某个本地模型。加载可能要十几秒（权重搬上卡 + 预热）。"""
    return await _post(f"/api/v1/models/{key}", {"action": action}, 300)


async def models_meter_reset() -> dict:
    return await _post("/api/v1/models/meter/reset", {}, 10)


async def vllm_log(n: int = 300) -> dict:
    if not enabled():
        raise SamUnavailable(_off_reason())
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/models/vllm/log"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params={"n": n})
    except Exception as e:  # noqa: BLE001
        raise SamUnavailable(f"连不上视觉服务：{type(e).__name__}") from e
    if resp.status_code != 200:
        raise SamUnavailable(f"视觉服务返回 {resp.status_code}: {_detail(resp)}")
    return resp.json()


async def lowlight(path: str, t_s: float, window_s: float = 2.0, model: str | None = None) -> dict:
    """夜里那几秒黑得看不见狗在干嘛——把那一刻捞出来看清楚。

    回三张图（原样 / 只拉伸 / 多帧堆栈后拉伸），配了权重的话再加一张模型增强的。
    超时给足：堆栈要解几十帧，模型那张还要过一次网络。
    """
    # 夜视这一摊默认关着：实测狗场夜间原片只用到 26 级亮度，判不出"在不在
    # 抓挠"（见 imu_train README）。代码全留着，想再验就把算法机 .env 里的
    # LOWLIGHT_ENABLED 设成 1、前端 config/features.ts 的 NIGHT_VISION 改 true
    if not settings.night_vision_enabled:
        return {"available": False, "error": (
            "夜视增强已关闭。实测这几路夜间只有 26 级动态范围，提亮只是把噪声"
            "放大，判不出动作——真正的解法是给单间补红外补光。想再验一次见 README")}
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/lowlight"
    body = {"path": path, "t": t_s, "window_s": window_s}
    if model:
        body["model"] = model
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, json=body)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}：{resp.text[:200]}"}
        return {"available": True, **resp.json()}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}: {e}"}


async def lowlight_seq(path: str, start_s: float, end_s: float, fps: float = 10.0,
                       smooth: int = 3, width: int = 640) -> dict:
    """把一整段增强成一串帧，让人循环着看。

    为什么要整段而不是一帧：抓挠是动作。单帧最多说清"狗在不在、什么姿势"，
    说不清"它在不在抓"——而人要判断的正是后者。

    超时比单帧那个还要给足：一段十来秒要解上百帧，每帧还要滑动平均加去色噪。
    """
    # 夜视这一摊默认关着：实测狗场夜间原片只用到 26 级亮度，判不出"在不在
    # 抓挠"（见 imu_train README）。代码全留着，想再验就把算法机 .env 里的
    # LOWLIGHT_ENABLED 设成 1、前端 config/features.ts 的 NIGHT_VISION 改 true
    if not settings.night_vision_enabled:
        return {"available": False, "error": (
            "夜视增强已关闭。实测这几路夜间只有 26 级动态范围，提亮只是把噪声"
            "放大，判不出动作——真正的解法是给单间补红外补光。想再验一次见 README")}
    if not enabled():
        return {"available": False, "error": _off_reason()}
    url = f"{settings.vision_service_url.rstrip('/')}/api/v1/lowlight_seq"
    body = {"path": path, "start": start_s, "end": end_s,
            "fps": fps, "smooth": smooth, "width": width}
    try:
        async with httpx.AsyncClient(timeout=240.0) as client:
            resp = await client.post(url, json=body)
        if resp.status_code != 200:
            return {"available": False, "error": f"视觉服务返回 {resp.status_code}：{resp.text[:200]}"}
        return {"available": True, **resp.json()}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "error": f"连不上视觉服务：{type(e).__name__}: {e}"}
