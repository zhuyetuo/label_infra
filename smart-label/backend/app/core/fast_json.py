"""接口返回值转 JSON：用 orjson，跳过 FastAPI 自带的 jsonable_encoder。

为什么：FastAPI 对没有 response_model 的接口（我们几乎全是 return ok({...})），会先用纯 Python 的
jsonable_encoder 把整个返回值递归走一遍，再 json.dumps。几千个任务、几千个样本的列表光这一步就要
将近 1 秒——而且是在事件循环里做的，这 1 秒所有人的请求都在排队（系统监控里「被堵」的那一下）。
orjson 是 C 写的，同样的数据十几毫秒。

orjson 不认识的类型（pydantic 对象、set、Decimal…）退回给 jsonable_encoder 处理，结果跟原来一样。
"""
from __future__ import annotations

from typing import Any

import orjson
from fastapi import routing
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

_OPTS = orjson.OPT_NON_STR_KEYS | orjson.OPT_SERIALIZE_NUMPY


def _default(o: Any) -> Any:
    if isinstance(o, (set, frozenset)):
        return list(o)
    return jsonable_encoder(o)


class FastJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, default=_default, option=_OPTS)


_orig_serialize = routing.serialize_response


async def _serialize_response(*, field=None, response_content: Any, **kw: Any) -> Any:
    # 没声明 response_model 的接口：原样交给 FastJSONResponse（orjson）去转，不再先走一遍 jsonable_encoder
    if field is None:
        return response_content
    return await _orig_serialize(field=field, response_content=response_content, **kw)


def install() -> None:
    routing.serialize_response = _serialize_response
