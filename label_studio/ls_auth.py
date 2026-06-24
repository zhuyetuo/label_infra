"""
ls_auth.py — Label Studio 认证公共模块

自动从环境变量读取 LS_REFRESH_TOKEN，缓存 access token（1天内复用）。
所有脚本 import 这个模块，统一认证逻辑。
"""

import os
import time
import requests

LS_URL         = os.getenv("LS_URL",           "http://192.168.2.140:8181")
REFRESH_TOKEN  = os.getenv("LS_REFRESH_TOKEN", "")

_cache: dict = {"access": None, "ts": 0}


def get_access_token() -> str:
    if _cache["access"] and (time.time() - _cache["ts"]) < 86400:
        return _cache["access"]
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


def auth_headers() -> dict:
    return {"Authorization": f"Bearer {get_access_token()}",
            "Content-Type": "application/json"}
