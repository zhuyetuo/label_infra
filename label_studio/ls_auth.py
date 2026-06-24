"""
ls_auth.py — Label Studio 认证公共模块

自动从环境变量读取 LS_REFRESH_TOKEN，缓存 access token（4分钟，避免过期）。
遇到 401 自动用 refresh token 重新获取。
"""

import os
import time
import requests

LS_URL         = os.getenv("LS_URL",           "http://192.168.2.140:8181")
REFRESH_TOKEN  = os.getenv("LS_REFRESH_TOKEN", "")

_cache: dict = {"access": None, "ts": 0}
_TOKEN_TTL = 240  # 4分钟，Label Studio access token 默认5分钟过期


def _refresh() -> str:
    if not REFRESH_TOKEN:
        raise RuntimeError(
            "未找到 LS_REFRESH_TOKEN，请先运行：\n"
            "  bash label_studio/set_token.sh \"你的Personal Access Token\""
        )
    r = requests.post(f"{LS_URL}/api/token/refresh",
                      json={"refresh": REFRESH_TOKEN}, timeout=10)
    r.raise_for_status()
    _cache["access"] = r.json()["access"]
    _cache["ts"] = time.time()
    return _cache["access"]


def get_access_token() -> str:
    if _cache["access"] and (time.time() - _cache["ts"]) < _TOKEN_TTL:
        return _cache["access"]
    return _refresh()


def auth_headers() -> dict:
    return {"Authorization": f"Bearer {get_access_token()}",
            "Content-Type": "application/json"}


def request_with_auth(method: str, url: str, **kwargs) -> requests.Response:
    """发起请求，遇到 401 自动刷新 token 重试一次。"""
    kwargs.setdefault("headers", {}).update(auth_headers())
    r = requests.request(method, url, **kwargs)
    if r.status_code == 401:
        _cache["access"] = None  # 强制刷新
        kwargs["headers"].update(auth_headers())
        r = requests.request(method, url, **kwargs)
    return r
