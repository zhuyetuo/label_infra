"""把「看全场的那一路」补挂给同一天别的采集机录的样本。

## 要解决什么

狗场有两台采集机，各录一半房间（cam1~3 / cam4~6），另有 cam7 一台俯拍
**看全部六间**。但导入是按 session_key（文件名里那段开机时刻）分组的，
而两台机器各自开机、时间戳差几秒：

    multicam_20260920_000016301_imu14   1 号机，只有单间那一路
    multicam_20260920_000012130_imu20   2 号机，还有 cam7

cam7 的文件名带的是 2 号机那串时间戳，于是只挂给了 imu15~20。imu9~14 那三间
明明在 cam7 的画面里，却看不到这一路。

## 为什么不能直接挂上去

平台的时间假设是「视频第 0 秒 = IMU CSV 第一行」，一份样本的各路共用一个原点。
两台机器的原点差约 4.17 秒（16.301 − 12.130）。不带偏移直接挂，那一路上
**每一条标注都会差 4 秒**——足够把一次抓挠对到隔壁动作上，而且错得看不出来。

所以这里算出偏移写进 samples.video_offsets_ms：**这一路的第 0 秒，在样本
时间轴上是第几毫秒**（早开就是负数）。

## 为什么默认只出报告

偏移是从文件名的时间戳推出来的，前提是"文件名里那串数就是开机时刻"。
这个前提对不对，只有拿两路画面上同一个可辨认的瞬间对一眼才知道。
所以 apply=False 时只返回计划，不写库——先核对 offset_ms 那一列。
"""

from __future__ import annotations

import logging
import os
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sample import Sample
from app.services import site_layout

_logger = logging.getLogger("smart-label.shared_cam")

# multicam_20260920_000016301 → 日期 20260920、时刻 000016301（HHMMSSmmm）
_SESSION_RE = re.compile(r"_(\d{8})_(\d{2})(\d{2})(\d{2})(\d{3})")
_SLOTS = ("cam1", "cam2", "cam3")


def session_start_ms(path_or_key: str) -> int | None:
    """文件名里那段开机时刻 → 当天的第几毫秒。认不出来 None，不猜。"""
    m = _SESSION_RE.search(path_or_key or "")
    if not m:
        return None
    _d, hh, mm, ss, ms = m.groups()
    return ((int(hh) * 60 + int(mm)) * 60 + int(ss)) * 1000 + int(ms)


def _day_dir(path: str | None) -> str:
    return os.path.dirname(path or "")


def _paths(s: Sample) -> list[str | None]:
    return [s.video_cam1_path, s.video_cam2_path, s.video_cam3_path]


def _free_slot(s: Sample) -> str | None:
    for slot, p in zip(_SLOTS, _paths(s)):
        if not p:
            return slot
    return None


def _has_public(s: Sample) -> bool:
    """这份样本已经有看全场那一路了吗（cam7）。"""
    for p in _paths(s):
        if not p:
            continue
        cam, _imu = site_layout.parse_cam_imu(p)
        if cam is not None and cam in site_layout.LAYOUT["gouchang"]["public_cams"]:
            return True
    return False


async def plan(db: AsyncSession, day_dir: str | None = None) -> dict:
    """算出「哪些样本该补挂哪一路 cam7、偏移多少」。不写库。"""
    rows = (await db.execute(select(Sample))).scalars().all()
    # 每个日期目录里，看全场那一路长什么样（路径 + 它自己的开机时刻）。
    # 同一天可能有好几场，按开机时刻各存一份，补挂时挑最近的那一场
    public_by_dir: dict[str, list[tuple[int, str]]] = {}
    for s in rows:
        for p in _paths(s):
            if not p:
                continue
            cam, _imu = site_layout.parse_cam_imu(p)
            if cam is None or cam not in site_layout.LAYOUT["gouchang"]["public_cams"]:
                continue
            start = session_start_ms(p)
            if start is None:
                continue
            bucket = public_by_dir.setdefault(_day_dir(p), [])
            if (start, p) not in bucket:
                bucket.append((start, p))

    items: list[dict] = []
    skipped: dict[str, int] = {}

    def skip(why: str) -> None:
        skipped[why] = skipped.get(why, 0) + 1

    for s in rows:
        own = s.video_cam1_path
        if not own:
            continue
        d = _day_dir(own)
        if day_dir is not None and d != day_dir:
            continue
        if site_layout.site_of(s.sample_code, d, own) != "gouchang":
            continue            # 只管狗场：影棚三路本来就全是公共的
        if _has_public(s):
            skip("已经有公共区那一路")
            continue
        cands = public_by_dir.get(d) or []
        if not cands:
            skip("这一天没有公共区视频")
            continue
        mine = session_start_ms(own)
        if mine is None:
            skip("认不出这份样本的开机时刻")
            continue
        slot = _free_slot(s)
        if slot is None:
            skip("三个槽位都满了")
            continue
        # 挑开机时刻最接近的那一场：一天里可能录了好几场，挂错场就是整段对不上
        start, path = min(cands, key=lambda c: abs(c[0] - mine))
        gap = start - mine
        # 差得太远说明不是同一场。半小时是个宽松的线——同一场的两台机器差几秒，
        # 隔壁场次差的是整点。宁可漏挂，也别把上一场的画面挂上来
        if abs(gap) > 30 * 60 * 1000:
            skip("最近的一场也差了半小时以上，不像同一场")
            continue
        items.append({
            "sample_id": s.id, "sample_code": s.sample_code, "slot": slot, "path": path,
            # 这一路的第 0 秒，在样本时间轴上是第几毫秒（它比样本早开就是负数）
            "offset_ms": gap,
            "own_start_ms": mine, "public_start_ms": start,
        })
    items.sort(key=lambda x: x["sample_code"] or "")
    return {"items": items, "skipped": skipped, "day_dirs": sorted(public_by_dir)}


async def apply(db: AsyncSession, day_dir: str | None = None) -> dict:
    """真写库：按 plan() 的结果挂上那一路，并记下偏移。"""
    p = await plan(db, day_dir)
    cols = {"cam1": "video_cam1_path", "cam2": "video_cam2_path", "cam3": "video_cam3_path"}
    n = 0
    for it in p["items"]:
        s = await db.get(Sample, it["sample_id"])
        if s is None:
            continue
        setattr(s, cols[it["slot"]], it["path"])
        offsets = dict(s.video_offsets_ms or {})
        offsets[it["slot"]] = int(it["offset_ms"])
        s.video_offsets_ms = offsets
        n += 1
    await db.commit()
    _logger.info("补挂公共区：%d 份样本", n)
    return {"attached": n, "skipped": p["skipped"]}
