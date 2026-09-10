"""
样本编号 → 是哪只狗。

样本编号里只有 IMU 设备号（`..._imu4`），狗名得另外对。标注工作台标题上要写
清楚"现在看的是哪只狗"——一个画面里同时有四只狗，不写的话根本没法确认。

对照表有两个来源，本地的优先：

1. 本地 dogs 表的「设备号」列——这是这套系统里人自己维护的，一只狗可以填两个
   （每只狗配两个 IMU 轮换充电，样本编号里出现的是当天戴的那个）。
2. label_service 的 `/api/v1/skin/options`（`imu_dog_default_map`）——老的来源，
   一只狗只能对一个设备，本地没登记的才用它兜底。

任务列表一次几百行，不能每行都去查一次；这里按 TTL 缓存整张表（就十来个条目，
改动极少）。两个来源都拿不到就返回空表，调用方退回显示设备号，绝不因为这个把
任务列表整个弄挂。
"""

from __future__ import annotations

import logging
import re
import time

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.dog import Dog

_logger = logging.getLogger("smart-label.dog")
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)

_TTL_S = 300.0
_cache: dict[str, str] = {}
_cache_at: float = 0.0


def imu_of(sample_code: str | None) -> str | None:
    m = _IMU_RE.search(sample_code or "")
    return f"IMU{m.group(1)}" if m else None


def imu_keys_of_dog(imu_field: str | None, dog_code: str | None) -> list[str]:
    """
    一只狗登记的设备号，规范成 ["IMU5", "IMU9"]。

    一只狗配两个 IMU 轮换充电，所以这一列是可以填多个的（逗号分隔，中英文逗号
    都认）。只写数字也认——大家习惯填「5」而不是「IMU5」。
    什么都没填、而编号本身是数字，就按编号当设备号（编号 1 = IMU1），这是
    采集端还没往文件名里写 dog 编号之前一直在用的约定。
    """
    raw = (imu_field or "").replace("，", ",")
    keys = []
    for part in raw.split(","):
        v = part.strip().upper()
        if not v:
            continue
        keys.append(v if v.startswith("IMU") else f"IMU{v}")
    if not keys and (dog_code or "").isdigit():
        keys = [f"IMU{dog_code}"]
    return keys


async def imu_dog_map() -> dict[str, str]:
    global _cache, _cache_at
    now = time.monotonic()
    if _cache and now - _cache_at < _TTL_S:
        return _cache

    # 先拿远端的当底，本地登记的再盖上去：本地是人在这套系统里自己维护的，
    # 冲突时它说了算
    mapping: dict[str, str] = {}
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/skin/options"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
        data = resp.json() if resp.status_code == 200 else {}
        m = (data or {}).get("imu_dog_default_map") or {}
        mapping.update({str(k): str(v) for k, v in m.items()})
    except (httpx.RequestError, ValueError) as e:
        # 拿不到就算了：退回本地登记的，实在没有就显示设备号，比让列表 502 强
        _logger.warning("取 IMU→狗 对照表失败（%s），只用本地狗档案：%s", url, e)

    try:
        async with SessionLocal() as db:
            rows = (await db.execute(select(Dog.dog_code, Dog.name, Dog.imu))).all()
        # 两只狗登记了同一个设备号时，原来是"谁后查到谁赢"——顺序一变名字就变，
        # 而且一声不吭。现场表现是工作台标题上写着 bibi（IMU2），可 IMU2 明明是
        # 巴利的。IMU 号本来就该是全局唯一的（跨场地也是），撞了就是档案填错了，
        # 得让人看见，不能挑一个装作没事。
        claimed: dict[str, str] = {}
        for dog_code, name, imu in rows:
            name = (name or "").strip()
            if not name:
                continue
            for key in imu_keys_of_dog(imu, dog_code):
                if key in claimed and claimed[key] != name:
                    _logger.warning(
                        "设备号 %s 被多只狗登记：%s 和 %s。IMU 号要全局唯一（两个场地也不能撞），"
                        "现在按后者显示，去狗档案里把重复的那个改掉。",
                        key, claimed[key], name,
                    )
                claimed[key] = name
                mapping[key] = name
    except Exception as e:  # noqa: BLE001 查库失败也不能把任务列表带崩
        _logger.warning("读本地狗档案失败，只用远端对照表：%s", e)

    _cache = mapping
    _cache_at = now
    return _cache


async def dog_names_by_id(db, dog_ids: set[int]) -> dict[int, str]:
    """dog_id → 狗名。一次查完，不要每行一次。

    传进来的是同一个请求里已经开着的 session，不新开——这个函数在任务列表里
    一次几百行时被调用，每次新建 session 光连接开销就够呛。
    """
    if not dog_ids:
        return {}
    rows = (await db.execute(select(Dog.id, Dog.name).where(Dog.id.in_(dog_ids)))).all()
    return {i: (n or "").strip() for i, n in rows if (n or "").strip()}


def dog_label_of(sample_code: str | None, dog_name: str | None, mapping: dict[str, str]) -> str | None:
    """一个样本该显示成哪只狗。

    优先用样本自己关联的狗（samples.dog_id），拿不到才退回按设备号猜。

    为什么这个顺序：按设备号猜是全局一张 IMU→狗名 表，而两个场地的狗都在同一张
    表里，编号一撞就会互相盖掉——现场就撞出过"IMU2 显示成 bibi，其实是巴利"。
    而 dog_id 是这个样本自己身上的字段，人在样本页上一条条关联过的，不存在跨场地
    串号的可能。有确切答案的时候不该去猜。

    退回猜，是因为老样本还有一批没关联 dog_id（采集端那时还没在文件名里带狗编号），
    对那些来说，按设备号猜聊胜于无。
    """
    if dog_name:
        imu = imu_of(sample_code)
        return f"{dog_name}（{imu}）" if imu else dog_name
    return dog_label(sample_code, mapping)


def dog_label(sample_code: str | None, mapping: dict[str, str]) -> str | None:
    """「小满（IMU4）」；对不上名字就只给「IMU4」，都没有就 None。

    括号里始终是样本自己的设备号，不是狗登记的那两个之一——同一只狗昨天 IMU5、
    今天 IMU9，要能看出这一条是哪个设备录的。
    """
    imu = imu_of(sample_code)
    if imu is None:
        return None
    name = mapping.get(imu)
    return f"{name}（{imu}）" if name else imu
