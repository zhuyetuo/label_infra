"""
样本编号 → 是哪只狗。

样本编号里只有 IMU 设备号（`..._imu4`），狗名得另外对。标注工作台标题上要写
清楚"现在看的是哪只狗"——一个画面里同时有四只狗，不写的话根本没法确认。

对照表有两个来源，本地的优先：

1. 本地 dogs 表的「设备号」列——这是这套系统里人自己维护的，一只狗可以填两个
   （每只狗配两个 IMU 轮换充电，样本编号里出现的是当天戴的那个）。
2. label_service 的 `/api/v1/skin/options`（`imu_dog_default_map`）——老的来源，
   一只狗只能对一个设备，本地没登记的才用它兜底。

**IMU 号只在一个场地里唯一。** 深圳雷诺狗场那 12 个项圈（IMU9~20）原样搬到了
佛山博朗旺，戴在另一批狗身上。所以除了全局那张「IMU→狗」（皮肤页的按钮排、
没场地信息时兜底），还有一张按场地分的「(场地, IMU)→狗」：样本能认出场地
（日期目录 `2026_10_27_bolangwang`）就查它，老的深圳样本照样对上当时的狗。
全局那张撞号时**在合作的场地优先**。

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
from app.services import site_layout

_logger = logging.getLogger("smart-label.dog")
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)

_TTL_S = 300.0
_cache: dict[str, str] = {}
_site_cache: dict[tuple[str, str], str] = {}
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


def merge_imu_map(remote: dict[str, str], dog_rows) -> dict[str, str]:
    """远端那张当底，本地狗档案登记的盖上去、补进来，最后按数字排好。

    抽成独立函数是为了能直接测：合并规则本身（谁盖谁、空名字跳过、撞号告警）
    才是容易出错的地方，而它原来埋在一个要拉 httpx + 数据库的协程里，
    测起来只能去测那两个桩。

    dog_rows: (dog_code, name, imu[, site]) 元组，就是 dogs 表查出来的样子。
    site 是狗档案「场所」列，可以不带（老调用）。

    撞号规则：
    - **同一个场地**两只狗登记同一个设备号 → 档案填错了，告警，后者盖前者。
      原来就是这样修的：工作台标题上写着 bibi（IMU2），可 IMU2 明明是巴利的。
    - **不同场地**撞号是正常的（项圈搬了场地）→ 不告警，在合作的场地那只优先，
      另一只靠 site_imu_map 按场地对上。
    """
    mapping = dict(remote)
    claimed: dict[str, tuple[str, str | None]] = {}
    for row in dog_rows:
        dog_code, name, imu = row[0], row[1], row[2]
        site = site_layout.site_key_of_name(row[3]) if len(row) > 3 else None
        name = (name or "").strip()
        # 名字空着的话界面上会显示成「IMU9 」，还不如退回只显示设备号
        if not name:
            continue
        for key in imu_keys_of_dog(imu, dog_code):
            if key in claimed and claimed[key][0] != name:
                prev_name, prev_site = claimed[key]
                if prev_site != site:
                    # 跨场地：在合作的那只占全局这一格，不吭声
                    if site_layout.is_active_site(prev_site) and not site_layout.is_active_site(site):
                        continue
                else:
                    _logger.warning(
                        "设备号 %s 在同一个场地被多只狗登记：%s 和 %s。"
                        "现在按后者显示，去狗档案里把重复的那个改掉。",
                        key, prev_name, name,
                    )
            claimed[key] = (name, site)
            mapping[key] = name
    return sort_imu_map(mapping)


def site_imu_map(dog_rows) -> dict[tuple[str, str], str]:
    """(场地键, "IMU9") → 狗名。场所没填 / 认不出的狗不进这张表（全局那张里有它）。"""
    out: dict[tuple[str, str], str] = {}
    for row in dog_rows:
        if len(row) < 4:
            continue
        site = site_layout.site_key_of_name(row[3])
        name = (row[1] or "").strip()
        if not site or not name:
            continue
        for key in imu_keys_of_dog(row[2], row[0]):
            out[(site, key)] = name
    return out


async def site_imu_dog_map() -> dict[tuple[str, str], str]:
    """按场地分的那张，跟 imu_dog_map 同一次刷新、同一个 TTL。"""
    await imu_dog_map()
    return _site_cache


async def imu_dog_map() -> dict[str, str]:
    global _cache, _site_cache, _cache_at
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
            rows = (await db.execute(select(Dog.dog_code, Dog.name, Dog.imu, Dog.site))).all()
        # 撞号怎么处理见 merge_imu_map：同场地撞了告警，跨场地是正常的
        mapping = merge_imu_map(mapping, rows)
        _site_cache = site_imu_map(rows)
    except Exception as e:  # noqa: BLE001 查库失败也不能把任务列表带崩
        _logger.warning("读本地狗档案失败，只用远端对照表：%s", e)

    _cache = sort_imu_map(mapping)
    _cache_at = now
    return _cache


def sort_imu_map(mapping: dict[str, str]) -> dict[str, str]:
    """把 IMU1..IMU20 按**数字**排好。

    dict 在 JSON 里保持插入顺序，而界面上那排「机位/狗」按钮直接就是
    Object.keys() 的顺序。不排的话顺序取决于远端返回顺序 + 本地查库顺序；
    真按字符串排更糟，会排成 IMU1, IMU10, IMU11, ..., IMU2——十只狗以上
    必然出现，而且看着像是漏了。

    认不出数字的键（真出现了也不该丢）排在最后，按原样的字典序。
    """
    def key(k: str):
        m = re.fullmatch(r"IMU(\d+)", k, re.IGNORECASE)
        return (0, int(m.group(1)), "") if m else (1, 0, k)
    return {k: mapping[k] for k in sorted(mapping, key=key)}


async def dog_names_by_id(db, dog_ids: set[int]) -> dict[int, str]:
    """dog_id → 狗名。一次查完，不要每行一次。

    传进来的是同一个请求里已经开着的 session，不新开——这个函数在任务列表里
    一次几百行时被调用，每次新建 session 光连接开销就够呛。
    """
    if not dog_ids:
        return {}
    rows = (await db.execute(select(Dog.id, Dog.name).where(Dog.id.in_(dog_ids)))).all()
    return {i: (n or "").strip() for i, n in rows if (n or "").strip()}


def dog_label_of(sample_code: str | None, dog_name: str | None, mapping: dict[str, str],
                 site_map: dict[tuple[str, str], str] | None = None,
                 path: str | None = None) -> str | None:
    """一个样本该显示成哪只狗。

    优先用样本自己关联的狗（samples.dog_id），拿不到才退回按设备号猜。

    为什么这个顺序：按设备号猜是全局一张 IMU→狗名 表，而两个场地的狗都在同一张
    表里，编号一撞就会互相盖掉——现场就撞出过"IMU2 显示成 bibi，其实是巴利"。
    而 dog_id 是这个样本自己身上的字段，人在样本页上一条条关联过的，不存在跨场地
    串号的可能。有确切答案的时候不该去猜。

    退回猜，是因为老样本还有一批没关联 dog_id（采集端那时还没在文件名里带狗编号），
    对那些来说，按设备号猜聊胜于无。猜的时候先按场地查（path 是样本的视频或
    CSV 路径，场地在日期目录里），认不出场地才用全局那张。
    """
    if dog_name:
        imu = imu_of(sample_code)
        return f"{dog_name}（{imu}）" if imu else dog_name
    return dog_label(sample_code, mapping, site_map, path)


def dog_label(sample_code: str | None, mapping: dict[str, str],
              site_map: dict[tuple[str, str], str] | None = None,
              path: str | None = None) -> str | None:
    """「小满（IMU4）」；对不上名字就只给「IMU4」，都没有就 None。

    括号里始终是样本自己的设备号，不是狗登记的那两个之一——同一只狗昨天 IMU5、
    今天 IMU9，要能看出这一条是哪个设备录的。
    """
    imu = imu_of(sample_code)
    if imu is None:
        return None
    site = site_layout.site_of(sample_code, path) if site_map else None
    name = (site_map or {}).get((site, imu)) if site else None
    name = name or mapping.get(imu)
    return f"{name}（{imu}）" if name else imu
