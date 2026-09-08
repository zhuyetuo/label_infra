"""
样本编号 → 是哪只狗。

样本编号里只有机位号（`..._imu4`），狗名那张对照表在 label_service 的
`/api/v1/skin/options`（`imu_dog_default_map`）里。标注工作台标题上要写清楚
"现在看的是哪只狗"——一个画面里同时有四只狗，不写的话根本没法确认。

任务列表一次几百行，不能每行都去问一次远端；这里按 TTL 缓存整张表（就四五个
条目，改动极少）。远端不通就返回空表，调用方退回显示机位号，绝不因为这个把
任务列表整个弄挂。
"""

from __future__ import annotations

import logging
import re
import time

import httpx

from app.core.config import settings

_logger = logging.getLogger("smart-label.dog")
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)

_TTL_S = 300.0
_cache: dict[str, str] = {}
_cache_at: float = 0.0


def imu_of(sample_code: str | None) -> str | None:
    m = _IMU_RE.search(sample_code or "")
    return f"IMU{m.group(1)}" if m else None


async def imu_dog_map() -> dict[str, str]:
    global _cache, _cache_at
    now = time.monotonic()
    if _cache and now - _cache_at < _TTL_S:
        return _cache
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/skin/options"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
        data = resp.json() if resp.status_code == 200 else {}
        m = (data or {}).get("imu_dog_default_map") or {}
        _cache = {str(k): str(v) for k, v in m.items()}
        _cache_at = now
    except (httpx.RequestError, ValueError) as e:
        # 拿不到就算了：标题退回只显示机位号，比让列表 502 强
        _logger.warning("取 IMU→狗 对照表失败（%s），先按机位号显示：%s", url, e)
        _cache_at = now
    return _cache


def dog_label(sample_code: str | None, mapping: dict[str, str]) -> str | None:
    """「小满（IMU4）」；对不上名字就只给「IMU4」，都没有就 None。"""
    imu = imu_of(sample_code)
    if imu is None:
        return None
    name = mapping.get(imu)
    return f"{name}（{imu}）" if name else imu
