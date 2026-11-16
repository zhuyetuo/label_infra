"""机位核对：一场录制里「文件名里的 camN」实际拍的是哪一间。

为什么需要：狗场两台采集机的摄像头 USB 重插后枚举顺序会变，采集端
`sites/*.env` 里 CAMERAS 的第二列（机位号 → 这台机器的设备索引）没跟着改的话，
文件名还是 cam1，可画面已经是另一个房间。平台按 camN 判房间，于是 A 房间的狗
配着 B 房间的画面——不报错、能播、能标，只是画面里的狗不是这只。

人在「机位核对」页看画面确认后改一次，按 session（文件名里那串开机时刻）存
`session_cam_maps`，同时把这一场每份样本的视频路径按**真实房间**重新挂一遍，
并在样本上记 `video_cams`（哪一路其实是几号间），后续 classify 不再按文件名猜。
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import date as date_cls

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dog import Dog
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.session_cam_map import SessionCamMap
from app.services import site_layout

_IMU_SUFFIX = re.compile(r"_imu\d+$")

_SLOTS = ("cam1", "cam2", "cam3")


def session_key_of(sample_code: str | None) -> str:
    """multicam_20260920_000016301_imu9 → multicam_20260920_000016301"""
    return _IMU_SUFFIX.sub("", sample_code or "")


def _basename(path: str | None) -> str:
    return os.path.basename(path or "")


def in_session(path: str | None, session_key: str) -> bool:
    """这一路文件是不是本场录的（跨 session 补挂的 cam7 不是）。"""
    return _basename(path).startswith(session_key + "_")


def _real_cam(sample: Sample, slot: str, path: str | None) -> int | None:
    """这一路的真实机位号：人工核对过就用记下的，否则按文件名。"""
    v = (sample.video_cams or {}).get(slot)
    if v is not None:
        try:
            return int(v)
        except (TypeError, ValueError):
            pass
    return site_layout.parse_cam_imu(path)[0]


def allowed_real_cams(site: str | None) -> set[int]:
    """这个场地里「实际可能是几号间」：单间号 + 公共区机位号。"""
    key = site_layout.SITE_KEYS.get((site or "").lower()) or (site if site in site_layout.LAYOUT else None)
    lay = site_layout.LAYOUT.get(key or "")
    if not lay:
        return set()
    rooms = {r for r, _code in lay["imu"].values() if r is not None}
    return rooms | set(lay["public_cams"])


def _room_label(site: str | None, cam: int) -> str:
    lay_key = site_layout.SITE_KEYS.get((site or "").lower()) or (site if site in site_layout.LAYOUT else None)
    lay = site_layout.LAYOUT.get(lay_key or "")
    if lay and cam in lay["public_cams"]:
        names = {
            "gouchang": "公共区（天花板）",
            "bolangwang": "户外活动区",
            "yingpeng": "公共区",
        }
        return names.get(lay_key or "", f"公共区（cam{cam}）")
    return f"{cam} 号单间"


def room_options(site: str | None) -> list[dict]:
    return [{"value": c, "label": _room_label(site, c)} for c in sorted(allowed_real_cams(site))]


def _session_videos(samples: list[Sample], session_key: str) -> dict[int, str]:
    """本场每个录制机位号 → 一份视频路径（用来给所有样本挂画面）。"""
    out: dict[int, str] = {}
    for s in samples:
        for slot in _SLOTS:
            path = getattr(s, f"video_{slot}_path")
            if not path or not in_session(path, session_key):
                continue
            cam, _imu = site_layout.parse_cam_imu(path)
            if cam is not None:
                out.setdefault(cam, path)
    return out


def mapping_of(samples: list[Sample], session_key: str) -> dict[int, int]:
    """这一场当前的「录制机位 → 真实机位」。没人路线时就是一一对应。"""
    videos = _session_videos(samples, session_key)
    out = {cam: cam for cam in videos}
    for s in samples:
        for slot in _SLOTS:
            path = getattr(s, f"video_{slot}_path")
            if not path or not in_session(path, session_key):
                continue
            recorded = site_layout.parse_cam_imu(path)[0]
            real = _real_cam(s, slot, path)
            if recorded is not None and real is not None:
                out[recorded] = real
    return out


def _desired_slots(
    sample: Sample,
    session_key: str,
    mapping: dict[int, int],
    videos: dict[int, str],
    site: str | None,
) -> tuple[list[tuple[int, str]], list[int]]:
    """这只狗的样本该挂哪几路 → [(真实机位, 路径)]，以及算不出画面的房间。"""
    key = site_layout.SITE_KEYS.get((site or "").lower()) or (site if site in site_layout.LAYOUT else None)
    lay = site_layout.LAYOUT.get(key or "")
    if not lay:
        return [], []
    imu = site_layout.imu_of(sample.sample_code)
    room = (lay["imu"].get(imu) or (None, None))[0]
    wanted: list[tuple[int, str]] = []
    missing: list[int] = []

    def _find(real: int) -> str | None:
        for recorded, r in mapping.items():
            if r == real and recorded in videos:
                return videos[recorded]
        return None

    if room is not None:
        path = _find(room)
        if path:
            wanted.append((room, path))
        else:
            missing.append(room)
    for pub in sorted(lay["public_cams"]):
        path = _find(pub)
        if path:
            wanted.append((pub, path))

    # 本场没有公共区那一路时，保留之前跨 session 挂上来的（比如 1 号机那场挂的 cam7）。
    # 它带着自己的时间偏移，不能当成本场文件重挂。
    if not any(real in lay["public_cams"] for real, _ in wanted):
        for slot in _SLOTS:
            path = getattr(sample, f"video_{slot}_path")
            if not path or in_session(path, session_key):
                continue
            real = _real_cam(sample, slot, path)
            if real in lay["public_cams"]:
                wanted.append((real, path))
                break

    wanted.sort(key=lambda x: x[0])
    return wanted[:3], missing


def _apply_slots(
    db: AsyncSession,
    samples: list[Sample],
    session_key: str,
    mapping: dict[int, int],
    mark_corrected: bool,
) -> dict:
    """把这一场所有样本按 mapping 重新挂画面。返回改了哪些、哪些房间算不出来。"""
    videos = _session_videos(samples, session_key)
    changed = 0
    missing: set[int] = set()
    for sample in samples:
        site = site_layout.site_of(sample.sample_code, os.path.dirname(sample.video_cam1_path or ""))
        wanted, rooms = _desired_slots(sample, session_key, mapping, videos, site)
        missing.update(rooms)
        if not wanted:
            continue
        old_offsets = dict(sample.video_offsets_ms or {})
        offset_by_path = {
            getattr(sample, f"video_{slot}_path"): old_offsets.get(slot)
            for slot in _SLOTS
            if getattr(sample, f"video_{slot}_path") and old_offsets.get(slot)
        }
        new_cams: dict[str, int] = {}
        new_offsets: dict[str, int] = {}
        for i, (real, path) in enumerate(wanted, start=1):
            slot = f"cam{i}"
            setattr(sample, f"video_{slot}_path", path)
            new_cams[slot] = real
            off = offset_by_path.get(path)
            if off:
                new_offsets[slot] = int(off)
        for slot in _SLOTS[len(wanted):]:
            setattr(sample, f"video_{slot}_path", None)
        sample.video_offsets_ms = new_offsets or None
        sample.video_cams = new_cams if mark_corrected else None
        changed += 1
    return {"updated": changed, "missing_rooms": sorted(missing)}


async def _upsert(db: AsyncSession, session_key: str, site: str | None,
                  mapping: dict[int, int], user_id: int | None) -> None:
    row = (
        await db.execute(select(SessionCamMap).where(SessionCamMap.session_key == session_key))
    ).scalar_one_or_none()
    if row is None:
        row = SessionCamMap(session_key=session_key, site=site, mapping={}, updated_by=user_id)
        db.add(row)
    row.site = site
    row.mapping = {str(k): int(v) for k, v in mapping.items()}
    row.updated_by = user_id


def _site_options() -> list[dict]:
    """场地下拉：有单间的场地才需要核对。影棚全是公共区，不出现在这里。"""
    return [
        {"key": k, "name": v["name"], "active": v["active"]}
        for k, v in site_layout.SITES.items()
        if site_layout.has_private_rooms(k)
    ]


async def _validate_and_apply(
    db: AsyncSession,
    samples: list[Sample],
    session_key: str,
    site: str | None,
    mapping: dict,
    user_id: int | None,
) -> dict:
    """一场的「校验 + 重挂 + 记下人工结果」。不 commit——批量时几场一起提交。"""
    try:
        mapping = {int(k): int(v) for k, v in mapping.items()}
    except (TypeError, ValueError):
        raise ValueError("机位号必须是整数") from None
    videos = _session_videos(samples, session_key)
    mapping = {recorded: mapping.get(recorded, recorded) for recorded in videos}
    allowed = allowed_real_cams(site)
    if allowed:
        bad = sorted(set(mapping.values()) - allowed)
        if bad:
            raise ValueError(f"机位号 {bad} 不属于这个场地（只能是 {sorted(allowed)}）")
    if len(set(mapping.values())) != len(mapping):
        raise ValueError("两路摄像头不能对应同一个房间")
    result = _apply_slots(db, samples, session_key, mapping, mark_corrected=True)
    await _upsert(db, session_key, site, mapping, user_id)
    return {"mapping": {str(k): v for k, v in mapping.items()}, **result}


async def list_sessions(db: AsyncSession, date: str | None = None, site: str | None = None) -> dict:
    """一天里每一场录制的机位情况。不给日期就用最近有可核对样本的那一天。

    site：布局键（bolangwang / gouchang），只看这个场地；不给就全部。
    影棚全是公共区没有单间，哪一路都不属于哪间，永远不出现在这个页面上。
    """
    if site is not None and not site_layout.has_private_rooms(site):
        raise ValueError(f"{site} 没有单间（全是公共区），不需要机位核对")

    dates = (
        await db.execute(
            select(Sample.session_date)
            .where(Sample.session_date.is_not(None))
            .distinct()
            .order_by(Sample.session_date.desc())
            .limit(90)
        )
    ).scalars().all()

    # 每个日期有哪些场地：场地名只写在日期目录（day_dir）里，得看路径才知道。
    # 取两列全量（一天几百条、90 天万把条），管理页一次请求可以接受
    date_sites: dict[str, set[str]] = defaultdict(set)
    if dates:
        for d, path in (
            await db.execute(
                select(Sample.session_date, Sample.video_cam1_path).where(Sample.session_date.in_(dates))
            )
        ).all():
            s = site_layout.site_of(os.path.dirname(path or ""))
            if site_layout.has_private_rooms(s):
                date_sites[d.isoformat()].add(s)

    date_strs = [d.isoformat() for d in dates]
    # 只有影棚数据的日期不用出现：点进去也全是空的
    date_strs = [ds for ds in date_strs if date_sites.get(ds)]
    if site:
        date_strs = [ds for ds in date_strs if site in date_sites.get(ds, set())]
    if date is None and date_strs:
        date = date_strs[0]
    if date is None:
        return {"dates": date_strs, "date": None, "sites": _site_options(), "sessions": []}

    rows = (
        await db.execute(
            select(Sample).where(Sample.session_date == date_cls.fromisoformat(date)).order_by(Sample.sample_code)
        )
    ).scalars().all()

    groups: dict[tuple[str, str], list[Sample]] = defaultdict(list)
    for s in rows:
        groups[(os.path.dirname(s.video_cam1_path or ""), session_key_of(s.sample_code))].append(s)

    dog_names: dict[int, str] = {}
    dog_ids = {s.dog_id for s in rows if s.dog_id}
    if dog_ids:
        got = (await db.execute(select(Dog.id, Dog.name).where(Dog.id.in_(dog_ids)))).all()
        dog_names = {did: name for did, name in got if name}

    maps = {
        m.session_key: m
        for m in (
            await db.execute(
                select(SessionCamMap).where(SessionCamMap.session_key.in_([k for _d, k in groups]))
            )
        ).scalars().all()
    }

    sessions: list[dict] = []
    for (day_dir, session_key), samples in sorted(groups.items(), key=lambda kv: kv[0][1]):
        s_site = site_layout.site_of(session_key, day_dir, samples[0].video_cam1_path)
        if not site_layout.has_private_rooms(s_site):
            continue  # 影棚：全公共区，没有「哪路拍哪间」的问题
        if site and s_site != site:
            continue
        videos = _session_videos(samples, session_key)
        mapping = mapping_of(samples, session_key)
        corrected = bool(maps.get(session_key)) or any(s.video_cams for s in samples)
        site_name = site_layout.SITES.get(s_site, {}).get("name", s_site)
        sessions.append({
            "session_key": session_key,
            "date": date,
            "day_dir": day_dir,
            "site": s_site,
            "site_name": site_name,
            "corrected": corrected,
            "rooms": room_options(s_site),
            "cams": [
                {
                    "recorded_cam": recorded,
                    "real_cam": mapping.get(recorded, recorded),
                    "path": videos[recorded],
                    "samples": sum(
                        1 for s in samples
                        if any(getattr(s, f"video_{slot}_path") == videos[recorded] for slot in _SLOTS)
                    ),
                }
                for recorded in sorted(mapping)
            ],
            "samples": [
                {
                    "id": s.id,
                    "sample_code": s.sample_code,
                    "imu": site_layout.imu_of(s.sample_code),
                    "dog_name": dog_names.get(s.dog_id or 0),
                    "room": (
                        (site_layout.LAYOUT.get(s_site, {}).get("imu", {})
                         .get(site_layout.imu_of(s.sample_code)) or (None, None))[0]
                    ),
                    "slots": [
                        {
                            "slot": slot,
                            "path": getattr(s, f"video_{slot}_path"),
                            "real_cam": _real_cam(s, slot, getattr(s, f"video_{slot}_path")),
                        }
                        for slot in _SLOTS
                        if getattr(s, f"video_{slot}_path")
                    ],
                }
                for s in samples
            ],
        })

    all_paths = [c["path"] for sess in sessions for c in sess["cams"]]
    media_ids = {
        path: mid
        for mid, path in (
            await db.execute(
                select(MediaFile.id, MediaFile.relative_path).where(MediaFile.relative_path.in_(all_paths))
            )
        ).all()
    } if all_paths else {}
    for sess in sessions:
        for c in sess["cams"]:
            c["media_id"] = media_ids.get(c["path"])

    return {"dates": date_strs, "date": date, "sites": _site_options(), "sessions": sessions}


async def save_mapping(db: AsyncSession, session_key: str, mapping: dict[int, int],
                       user_id: int | None) -> dict:
    rows = (
        await db.execute(select(Sample).where(Sample.sample_code.like(f"{session_key}%")).order_by(Sample.sample_code))
    ).scalars().all()
    samples = [s for s in rows if session_key_of(s.sample_code) == session_key]
    if not samples:
        raise ValueError("这一场没有样本")
    day_dir = os.path.dirname(samples[0].video_cam1_path or "")
    site = site_layout.site_of(session_key, day_dir, samples[0].video_cam1_path)
    result = await _validate_and_apply(db, samples, session_key, site, mapping, user_id)
    await db.commit()
    return {"session_key": session_key, **result}


async def save_batch(db: AsyncSession, date: str, mapping: dict, session_keys: list[str],
                     user_id: int | None) -> dict:
    """把同一套「录制机位 → 真实房间」一次应用到一天里选中的多场。

    一天 24 场一条条点太费时间；摄像头上午插错了，勾上午那几场一次改完。
    每场只取自己有的机位（1 号机 3 路、2 号机 3 路，各取各的）；
    某一场校验不过（比如机位号不属于这个场地）不影响其他场。
    """
    rows = (
        await db.execute(
            select(Sample).where(Sample.session_date == date_cls.fromisoformat(date)).order_by(Sample.sample_code)
        )
    ).scalars().all()
    groups: dict[tuple[str, str], list[Sample]] = defaultdict(list)
    for s in rows:
        groups[(os.path.dirname(s.video_cam1_path or ""), session_key_of(s.sample_code))].append(s)

    wanted = set(session_keys)
    results: list[dict] = []
    failed: list[dict] = []
    for (day_dir, session_key), samples in sorted(groups.items(), key=lambda kv: kv[0][1]):
        if session_key not in wanted:
            continue
        site = site_layout.site_of(session_key, day_dir, samples[0].video_cam1_path)
        if not site_layout.has_private_rooms(site):
            continue
        try:
            r = await _validate_and_apply(db, samples, session_key, site, mapping, user_id)
            results.append({
                "session_key": session_key,
                "updated": r["updated"],
                "missing_rooms": r["missing_rooms"],
            })
        except ValueError as exc:
            failed.append({"session_key": session_key, "error": str(exc)})
    if not results and not failed:
        raise ValueError("选中的场次里没有可核对的样本")
    await db.commit()
    return {"updated": sum(r["updated"] for r in results), "results": results, "failed": failed}


async def reset_mapping(db: AsyncSession, session_key: str) -> dict:
    rows = (
        await db.execute(select(Sample).where(Sample.sample_code.like(f"{session_key}%")).order_by(Sample.sample_code))
    ).scalars().all()
    samples = [s for s in rows if session_key_of(s.sample_code) == session_key]
    if not samples:
        raise ValueError("这一场没有样本")
    videos = _session_videos(samples, session_key)
    identity = {cam: cam for cam in videos}
    result = _apply_slots(db, samples, session_key, identity, mark_corrected=False)
    await db.execute(delete(SessionCamMap).where(SessionCamMap.session_key == session_key))
    await db.commit()
    return {"session_key": session_key, **result}


async def mappings_by_session(db: AsyncSession) -> dict[str, dict[int, int]]:
    """自动扫描用：已人工核对过的场次 → {录制机位: 真实机位}。"""
    out: dict[str, dict[int, int]] = {}
    for row in (await db.execute(select(SessionCamMap))).scalars().all():
        try:
            out[row.session_key] = {int(k): int(v) for k, v in (row.mapping or {}).items()}
        except (TypeError, ValueError):
            continue
    return out
