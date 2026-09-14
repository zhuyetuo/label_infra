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
