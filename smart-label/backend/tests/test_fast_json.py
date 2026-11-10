"""orjson 转出来的 JSON 跟原来 jsonable_encoder + json 的一致（日期、枚举、数字键、集合、Decimal、pydantic）"""
import datetime
import decimal
import enum
import json

from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel

from app.core.fast_json import FastJSONResponse


class E(str, enum.Enum):
    a = "PENDING"


class M(BaseModel):
    x: int = 1


def test_跟原来一样():
    payload = {"code": 0, "data": [{"id": 1, "at": datetime.datetime(2026, 11, 10, 12, 0, 1, 123456),
                                    "d": datetime.date(2026, 11, 10), "s": E.a, "lc": {3: {"n": 2}},
                                    "dec": decimal.Decimal("1.5"), "m": M(), "tags": {"a"}, "none": None, "f": 0.25}]}
    new = json.loads(FastJSONResponse(payload).body)
    old = json.loads(json.dumps(jsonable_encoder(payload)))
    assert new == old
