"""狗场单间：按**摄像头**算"狗在单间里待了多久"，不按 IMU 算。

为什么不能按 IMU 算：一只狗两个项圈轮换充电、而且两个都录（当班 + 备用同时采），
一个小时的画面对应两份样本（imu15 和 imu16），按样本加时长就是双倍；哪天只戴了一个
又是单倍——"总共采了多少小时"这个数按 IMU 根本算不准。

按摄像头就没有这个问题：狗场一间一狗一摄像头，一个单间一路画面，同一段视频不管配了
几个 IMU 都只算一次。「在单间里多久」用画面扫描（sample_vision_scans，每 5 秒采一点
看有没有狗）的时间线算：有狗的采样点数 × 采样间隔。

只算配对场地（目录 / 编号带 gouchang）的、文件名里带 _camN_imuM 的那路，天花板那种
公用机位不算（它拍的是走廊，不是单间）。
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sample import Sample
from app.models.sample_vision_scan import STATE_OK, SampleVisionScan
from app.services import vision_scan_service as vscan
from app.services.daily_stats_service import _imu_to_dog
from app.services.dog_presence_service import is_one_dog_site
from app.services.skin_tracking_service import _imu_of

# multicam_20260917_030015023_cam4_imu15_raw.mp4 → (4, 15)
_CAM_IMU_RE = re.compile(r"_cam(\d+)_imu(\d+)", re.IGNORECASE)


def room_video_of(sample: Sample) -> tuple[int, str] | None:
    """这份样本自己那间的画面：(机位号, 视频相对路径)。

    三个槽位里挑文件名带 _camN_imuM、且 imuM 就是这份样本的 IMU 的那路。
    天花板公用机位（_cam7_raw，没有 imu 号）自然选不中。
    """
    imu = _imu_of(sample.sample_code)
    want = imu[3:] if imu else None
    fallback = None
    for path in (sample.video_cam1_path, sample.video_cam2_path, sample.video_cam3_path):
        if not path:
            continue
        m = _CAM_IMU_RE.search(os.path.basename(path))
        if not m:
            continue
        if want is None or m.group(2) == want:
            return int(m.group(1)), path
        # 轮换的另一个项圈只传 CSV，它的画面就是同一间配给当班项圈的那段（cam4_imu15），
        # 文件名里的 imu 号跟自己对不上——但它就是自己那间的画面
        fallback = fallback or (int(m.group(1)), path)
    return fallback


def present_seconds(timeline: list[list[float]], every_sec: float | None,
                    no_dog_ratio: float | None, duration_sec: float | None) -> float | None:
    """时间线里有狗的采样点数 × 采样间隔。没有时间线就退回 (1 − 没狗比例) × 时长；
    都没有就是不知道（None，不是 0）。"""
    if timeline:
        step = float(every_sec or 5.0)
        return sum(step for pt in timeline if len(pt) >= 2 and (pt[1] or 0) >= 1)
    if no_dog_ratio is not None and duration_sec:
        return float(duration_sec) * (1.0 - float(no_dog_ratio))
    return None


def _slot_of(sample: Sample, path: str) -> str:
    for cam, p in (("cam1", sample.video_cam1_path), ("cam2", sample.video_cam2_path), ("cam3", sample.video_cam3_path)):
        if p == path:
            return cam
    return "cam1"


async def rooms(db: AsyncSession, date_from: date, date_to: date) -> list[dict]:
    """按 (日期, 单间机位) 汇总：录了多久、画面里有狗多久、哪几份样本、扫没扫。"""
    imu_map = await _imu_to_dog(db)
    samples = (await db.execute(
        select(Sample).where(Sample.session_date.is_not(None), Sample.session_date >= date_from,
                             Sample.session_date <= date_to)
    )).scalars().all()
    # 只看狗场：日期目录 / 编号里带 gouchang 的
    picked: list[tuple[Sample, int, str]] = []
    for s in samples:
        day_dir = os.path.dirname(s.video_cam1_path or "")
        if not is_one_dog_site(s.sample_code, day_dir):
            continue
        rv = room_video_of(s)
        if rv is not None:
            picked.append((s, rv[0], rv[1]))
    if not picked:
        return []
    scans = (await db.execute(
        select(SampleVisionScan).where(SampleVisionScan.sample_id.in_([s.id for s, _, _ in picked]))
    )).scalars().all()
    scan_by = {(r.sample_id, r.cam): r for r in scans}

    # 一段视频只算一次：两个 IMU 的样本指向同一个文件
    seen_paths: dict[tuple, dict] = {}
    for s, cam_no, path in picked:
        key = (s.session_date, cam_no)
        b = seen_paths.setdefault(key, {"videos": {}, "imus": set(), "dogs": set()})
        imu = _imu_of(s.sample_code)
        if imu:
            b["imus"].add(imu)
            if imu_map.get(imu):
                b["dogs"].add(imu_map[imu])
        v = b["videos"].get(path)
        row = scan_by.get((s.id, _slot_of(s, path)))
        # 同一段视频扫过几次（每个 IMU 的样本各扫一次）：随便哪份成功的都行
        if v is None or (v["scan"] is None and row is not None and row.state == STATE_OK):
            dur = float(s.video_duration_sec or 0) or (float(row.duration_sec) if row is not None and row.duration_sec else 0.0)
            b["videos"][path] = {"scan": row if row is not None and row.state == STATE_OK else None,
                                 "duration": dur, "sample_ids": set()}
            v = b["videos"][path]
        v["sample_ids"].add(s.id)

    out = []
    for (day, cam_no), b in seen_paths.items():
        recorded = 0.0
        present = 0.0
        n_scanned = 0
        n_unscanned = 0
        n_unknown = 0
        for v in b["videos"].values():
            scan = v["scan"]
            recorded += v["duration"] or (float(scan.duration_sec) if scan is not None and scan.duration_sec else 0.0)
            if scan is None:
                n_unscanned += 1
                continue
            sec = present_seconds(vscan.load_timeline(scan.timeline),
                                  float(scan.every_sec) if scan.every_sec is not None else None,
                                  float(scan.no_dog_ratio) if scan.no_dog_ratio is not None else None,
                                  float(scan.duration_sec) if scan.duration_sec is not None else None)
            if sec is None:
                n_unknown += 1
                continue
            n_scanned += 1
            present += min(sec, v["duration"] or sec)
        out.append({
            "stat_date": day.isoformat(),
            "cam": f"cam{cam_no}",
            "dog_name": "、".join(sorted(b["dogs"])) or None,
            "imus": sorted(b["imus"], key=lambda x: int(x[3:]) if x[3:].isdigit() else 0),
            "n_videos": len(b["videos"]),
            "n_scanned": n_scanned,
            "n_unscanned": n_unscanned + n_unknown,
            "recorded_seconds": round(recorded, 1),
            # 只按扫过的那些视频算；没扫的不知道，present 里不包含它们的时间
            "present_seconds": round(present, 1),
            "scanned_seconds": round(sum(v["duration"] for v in b["videos"].values() if v["scan"] is not None), 1),
        })
    out.sort(key=lambda r: (r["stat_date"], r["cam"]), reverse=True)
    return out


__all__ = ["rooms", "room_video_of", "present_seconds"]
