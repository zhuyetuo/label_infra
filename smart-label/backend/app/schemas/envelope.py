"""
统一响应体 {code, msg, data}，对齐公司现有 HICCPET admin-frontend 的约定
（src/utils/request.ts 里 code!==0 触发全局错误提示）。这样以后后端换成 Java/Spring Boot
重写时，前端 request.ts 几乎不用改。
"""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    code: int = 0
    msg: str = "ok"
    data: T | None = None


def ok(data=None, msg: str = "ok") -> dict:
    return {"code": 0, "msg": msg, "data": data}


def fail(msg: str, code: int = 1) -> dict:
    return {"code": code, "msg": msg, "data": None}
