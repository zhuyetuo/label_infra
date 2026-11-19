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
from datetime import date as date_cls, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dog import Dog
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.session_cam_map import SessionCamMap
from app.services import dog_name_service, site_layout

_IMU_SUFFIX = re.compile(r"_imu\d+$")

_START_RE = re.compile(r"_(\d{8})_(\d{2})(\d{2})(\d{2})(\d{3})")

_SLOTS = ("cam1", "cam2", "cam3")

# 两台采集机是各自整点开录的，开机时刻会差几十毫秒到几秒；
# 同一时间段的两个 session 按开机时刻配对，超过这个间隔就不算同一段
_PAIR_WINDOW_SEC = 180


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


def _room_and_cam(sample: Sample, site: str | None) -> tuple[int | None, int | None]:
    """这只狗的样本：(自己那间是几号间, 那间画面录在哪个录制机位)。

    界面上要让人一眼看出「IMU11 这只狗对应哪一路画面」，只看房间号不够——
    画面列是按录制机位排的，所以还得给出它实际挂在哪个 camN 上。
    """
    imu = site_layout.imu_of(sample.sample_code)
    room = (site_layout.LAYOUT.get(site or "", {}).get("imu", {}).get(imu) or (None, None))[0]
    if room is None:
        return None, None
    for slot in _SLOTS:
        path = getattr(sample, f"video_{slot}_path")
        if path and _real_cam(sample, slot, path) == room:
            return room, site_layout.parse_cam_imu(path)[0]
    # 还没纠正、文件名里的机位跟房间对不上时，就报它当前挂在哪一路上
    first = sample.video_cam1_path
    return room, site_layout.parse_cam_imu(first)[0] if first else None


def allowed_real_cams(site: str | None) -> set[int]:
    """这个场地里「实际可能是几号间」：单间号 + 公共区机位号。"""
    key = site_layout.SITE_KEYS.get((site or "").lower()) or (site if site in site_layout.LAYOUT else None)
    lay = site_layout.LAYOUT.get(key or "")
    if not lay:
        return set()
    rooms = {r for r, _code in lay["imu"].values() if r is not None}
    return rooms | set(lay["public_cams"])


def _room_label(site: str | None, cam: int) -> str:
    allowed = allowed_real_cams(site)
    if allowed and cam not in allowed:
        return f"cam{cam}（户外/公共）"
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


def _imu_set(samples: list[Sample]) -> set[int]:
    """这一场录到了哪几只 IMU。"""
    out: set[int] = set()
    for s in samples:
        imu = site_layout.imu_of(s.sample_code)
        if imu is not None:
            out.add(imu)
    return out


def _paired_imu(lay: dict, imu: int) -> int | None:
    """同一间里轮换的另一只 IMU。

    一间一狗配两只 IMU（一只在狗身上、一只充电），两只接的是同一路摄像头，
    录出来的画面必然一样；两只分在相邻两场录的时候，错位情况也一样。
    """
    room = (lay["imu"].get(imu) or (None, None))[0]
    if room is None:
        return None
    for other, (r, _code) in lay["imu"].items():
        if other != imu and r == room:
            return other
    return None


def _site_key(site: str | None) -> str | None:
    return site_layout.SITE_KEYS.get((site or "").lower()) or site


def cam_room_choices(site: str | None, cam: int | None) -> set[int]:
    """这一路摄像头**可能**拍的是哪一间。

    博朗旺两台采集机各管三间：1 号机 cam1~3（1~3 号间），2 号机 cam4~6（4~6 号间）。
    USB 重插只会打乱同一台机器内部的顺序，所以只允许在同组三个房间里换。

    深圳雷诺不一样：7 个摄像头是独立装的，6 间房和 1 个公共区，哪一路插到哪一
    间都可能（实测有跨机器的错位）。所以 cam1~6 都可以对应任意一间，公共区
    cam7 固定不动；本地布局里没有的机位（博朗旺户外 cam7~9）也只能保持自己。
    """
    allowed = allowed_real_cams(site)
    if cam is None:
        return allowed
    if not allowed:
        return set()
    if cam not in allowed:
        return {cam}
    lay_key = _site_key(site)
    if lay_key == "gouchang" and cam <= 6:
        return {c for c in allowed if c <= 6} or {cam}
    if cam <= 6:
        lo = (cam - 1) // 3 * 3 + 1
        same = {c for c in allowed if lo <= c <= lo + 2}
        return same or {cam}
    pubs = {c for c in allowed if c > 6}
    return pubs or {cam}


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
    videos: dict[int, str] | None = None,
    offsets: dict[int, int] | None = None,
) -> dict:
    """把这一场所有样本按 mapping 重新挂画面。返回改了哪些、哪些房间算不出来。

    videos / offsets：跨采集机核对时把对面那一场的机位也一并传进来——雷诺的
    7 个摄像头是独立装的，1~6 号间可能录在另一台机器上，只按本场找会缺画面。
    offsets 是这个录制机位的第 0 秒相对本样本原点的毫秒数（跨机的才有）。
    """
    videos = videos or _session_videos(samples, session_key)
    cross_offsets = offsets or {}
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
            off = cross_offsets.get(real) or offset_by_path.get(path)
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
    videos: dict[int, str] | None = None,
    offsets: dict[int, int] | None = None,
) -> dict:
    """一场的「校验 + 重挂 + 记下人工结果」。不 commit——批量时几场一起提交。"""
    try:
        mapping = {int(k): int(v) for k, v in mapping.items()}
    except (TypeError, ValueError):
        raise ValueError("机位号必须是整数") from None
    own_videos = _session_videos(samples, session_key)
    # 跨采集机核对时按两边合起来的机位校验；没传就是本场
    all_videos = videos or own_videos
    mapping = {recorded: mapping.get(recorded, recorded) for recorded in all_videos}
    if allowed_real_cams(site):
        for recorded, real in mapping.items():
            choices = cam_room_choices(site, recorded)
            if real not in choices:
                raise ValueError(
                    f"cam{recorded} 只能对应 {'、'.join(str(c) for c in sorted(choices))} 号间"
                )
    if len(set(mapping.values())) != len(mapping):
        raise ValueError("两路摄像头不能对应同一个房间")
    result = _apply_slots(db, samples, session_key, mapping, mark_corrected=True,
                          videos=all_videos, offsets=offsets)
    # 每场只记自己的机位对照：对面那台机器的映射由它自己的那一场记
    await _upsert(db, session_key, site, {k: mapping[k] for k in own_videos}, user_id)
    return {"mapping": {str(k): v for k, v in mapping.items()}, **result}


def _session_start(key: str) -> datetime | None:
    m = _START_RE.search(key)
    if not m:
        return None
    d, hh, mm, ss, ms = m.groups()
    return datetime.strptime(f"{d}{hh}{mm}{ss}", "%Y%m%d%H%M%S").replace(microsecond=int(ms) * 1000)


def _machine_of(cams: list[int]) -> int:
    """1 = 1 号机（cam1~3，管 1~3 号间），2 = 2 号机（cam4~6，管 4~6 号间）。"""
    groups = {1 if c <= 3 else 2 for c in cams if 1 <= c <= 6}
    return groups.pop() if len(groups) == 1 else 0


def _pair_segments(sessions: list[dict]) -> list[dict]:
    """把同一天同一场地、开机时刻挨着的两个 session 合成一段。

    看画面核对时必须两台机器的 6 路一起看——只给 3 路看不出「另一台错位了」。
    但两个 session 的机位对照是各自存的，所以段里带上 session_keys，
    应用时按各自机位分别下发。
    """
    out: list[dict] = []
    by_site: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for s in sessions:
        by_site[(s["date"], s["site"])].append(s)

    for (date, site), group in by_site.items():
        ordered = sorted(group, key=lambda x: (_session_start(x["session_key"]) or datetime.min, x["session_key"]))
        buckets: list[dict] = []
        for s in ordered:
            st = _session_start(s["session_key"])
            machine = _machine_of([c["recorded_cam"] for c in s["cams"]])
            target = None
            for b in buckets:
                if len(b["sessions"]) >= 2:
                    continue
                if machine and machine in b["machines"]:
                    continue
                if st and b["start"] and abs((st - b["start"]).total_seconds()) > _PAIR_WINDOW_SEC:
                    continue
                target = b
                break
            if target is None:
                target = {"sessions": [], "machines": set(), "start": st}
                buckets.append(target)
            target["sessions"].append(s)
            target["machines"].add(machine)

        for b in buckets:
            members = b["sessions"]
            cams: dict[int, dict] = {}
            for s in members:
                for c in s["cams"]:
                    cams.setdefault(c["recorded_cam"], c)
            first = members[0]
            out.append({
                "segment_key": first["session_key"],
                "session_key": first["session_key"],
                "session_keys": [s["session_key"] for s in members],
                "date": date,
                "site": site,
                "site_name": first["site_name"],
                "corrected": all(s["corrected"] for s in members),
                "rooms": first["rooms"],
                "cams": [cams[k] for k in sorted(cams)],
                "samples": [x for s in members for x in s["samples"]],
            })

    out.sort(key=lambda x: (_session_start(x["segment_key"]) or datetime.min, x["segment_key"]))
    return out


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
        return {"dates": date_strs, "date": None, "sites": _site_options(), "sessions": [], "segments": []}

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
    # 老样本大多没关联 dog_id（那时候采集端文件名里还没带狗编号），
    # 按「场地 + IMU」查狗档案补上名字和 dog_id，界面上才能显示照片让人认狗
    dog_idx = await dog_name_service.dog_index(db)
    profiles = await dog_name_service.dog_profiles(db)

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
        sample_items = []
        for s in samples:
            room, cam = _room_and_cam(s, s_site)
            imu = site_layout.imu_of(s.sample_code)
            dog_id = s.dog_id
            dog_name = dog_names.get(dog_id or 0)
            if dog_name is None and imu is not None:
                dog_name = dog_idx.name(f"IMU{imu}", s_site)
                dog_id = dog_id or (profiles.get((s_site, dog_name or "")) or {}).get("dog_id")
            sample_items.append({
                "id": s.id,
                "sample_code": s.sample_code,
                "imu": imu,
                "dog_id": dog_id,
                "dog_name": dog_name,
                "room": room,
                # 这只狗自己的画面录在哪个录制机位（界面上跟「录制 camN」列对上）
                "cam": cam,
                "slots": [
                    {
                        "slot": slot,
                        "path": getattr(s, f"video_{slot}_path"),
                        "real_cam": _real_cam(s, slot, getattr(s, f"video_{slot}_path")),
                    }
                    for slot in _SLOTS
                    if getattr(s, f"video_{slot}_path")
                ],
            })
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
                    # 下拉只给同组三个房间，避免把 1 号机的画面挂到 4 号间
                    "room_options": [
                        {"value": c, "label": _room_label(s_site, c)}
                        for c in sorted(cam_room_choices(s_site, recorded))
                    ],
                    "samples": sum(
                        1 for s in samples
                        if any(getattr(s, f"video_{slot}_path") == videos[recorded] for slot in _SLOTS)
                    ),
                }
                for recorded in sorted(mapping)
            ],
            "samples": sample_items,
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

    return {
        "dates": date_strs,
        "date": date,
        "sites": _site_options(),
        "sessions": sessions,
        # 两台机器的同时间段合成一段，一次看 6 路画面
        "segments": _pair_segments(sessions),
    }


async def sample_cams(db: AsyncSession, sample_id: int) -> dict:
    """标注工作台里就地核对机位：这份样本这一场的几路录制画面 + 这只狗该在哪一间。

    跟「机位核对」页是同一套数据，只是不用跳出去：标的时候看到画面不对，
    当场把那间屋子换到正确的那一路。真正落库仍走 save_batch（整场一起改）。
    """
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise ValueError("样本不存在")
    session_key = session_key_of(sample.sample_code)
    day_dir = os.path.dirname(sample.video_cam1_path or "")
    site = site_layout.site_of(session_key, day_dir, sample.video_cam1_path)
    if not site_layout.has_private_rooms(site):
        return {
            "applicable": False,
            "reason": "这个场地全是公共区，没有「哪一路拍哪一间」的问题，不需要核对机位",
        }

    # 同一天同一场地、另一台机器、开机时刻挨着的那一场——雷诺 7 个摄像头是独立
    # 装的，只按本场那 3 路看不到对面机器上的房间，纠正也没法跨过去
    rows = (
        await db.execute(select(Sample).where(Sample.session_date == sample.session_date))
    ).scalars().all()
    groups: dict[tuple[str, str], list[Sample]] = defaultdict(list)
    for s in rows:
        d = os.path.dirname(s.video_cam1_path or "")
        if d != day_dir:
            continue
        groups[(d, session_key_of(s.sample_code))].append(s)
    groups = {
        gk: gs for gk, gs in groups.items()
        if site_layout.site_of(gk[1], gk[0], gs[0].video_cam1_path) == site
    }
    own_key = (day_dir, session_key)
    samples = groups.get(own_key, [sample])
    videos = dict(_session_videos(samples, session_key))
    offsets: dict[int, int] = {}
    session_keys = [session_key]
    mine_start = _session_start(session_key)
    mine_machine = _machine_of(sorted(videos))
    best: tuple[int, tuple[str, str], list[Sample], dict[int, str]] | None = None
    # 只有雷诺是 7 路独立装的、可能跨机器错位；博朗旺仍按本场三路核对
    if _site_key(site) == "gouchang":
        for gk, gs in groups.items():
            if gk == own_key:
                continue
            other = _session_videos(gs, gk[1])
            m2 = _machine_of(sorted(other))
            if not m2 or (mine_machine and m2 == mine_machine):
                continue
            st2 = _session_start(gk[1])
            if mine_start is None or st2 is None:
                continue
            diff = abs(int((st2 - mine_start).total_seconds()))
            if diff > _PAIR_WINDOW_SEC:
                continue
            if best is None or diff < best[0]:
                best = (diff, gk, gs, other)
    mapping = mapping_of(samples, session_key)
    if best is not None:
        _diff, gk, gs, other = best
        session_keys.append(gk[1])
        st2 = _session_start(gk[1])
        gap = int((st2 - mine_start).total_seconds() * 1000) if st2 and mine_start else 0
        other_mapping = mapping_of(gs, gk[1])
        for cam, path in other.items():
            if cam not in videos:
                videos[cam] = path
                offsets[cam] = gap
                mapping[cam] = other_mapping.get(cam, cam)
    for cam in videos:
        mapping.setdefault(cam, cam)
    room, current_cam = _room_and_cam(sample, site)
    paths = [videos[c] for c in sorted(videos)]
    media_ids = {
        path: mid
        for mid, path in (
            await db.execute(
                select(MediaFile.id, MediaFile.relative_path).where(MediaFile.relative_path.in_(paths))
            )
        ).all()
    } if paths else {}
    return {
        "applicable": True,
        "sample_id": sample.id,
        "sample_code": sample.sample_code,
        "session_key": session_key,
        "session_keys": session_keys,
        "date": sample.session_date.isoformat() if sample.session_date else None,
        "site": site,
        "site_name": site_layout.SITES.get(site or "", {}).get("name", site),
        "room": room,
        "room_label": _room_label(site, room) if room is not None else None,
        "current_recorded_cam": current_cam,
        "rooms": room_options(site),
        "mapping": {str(k): v for k, v in mapping.items()},
        "cams": [
            {
                "recorded_cam": recorded,
                "real_cam": mapping.get(recorded, recorded),
                "path": videos[recorded],
                "media_id": media_ids.get(videos[recorded]),
                "offset_ms": offsets.get(recorded, 0),
                "room_options": [
                    {"value": c, "label": _room_label(site, c)}
                    for c in sorted(cam_room_choices(site, recorded))
                ],
            }
            for recorded in sorted(videos)
        ],
    }


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

    同一个房间的两只 IMU 是分开录的，常常一只在这一场、另一只在相邻那一场。
    选中段纠正后，同一天同一场地里那些「只录到配对其中一只」的场次也按同一套
    对照一起改——不然那几小时还是错画面，人还得再手动找一遍。
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
    # 每场的机位、开机时刻、场地先算好：跨采集机核对时要把对面那一场并进来
    group_videos = {gk: _session_videos(gs, gk[1]) for gk, gs in groups.items()}
    group_machine = {gk: _machine_of(sorted(group_videos[gk])) for gk in groups}
    group_start = {gk: _session_start(gk[1]) for gk in groups}
    group_site = {
        gk: site_layout.site_of(gk[1], gk[0], gs[0].video_cam1_path) for gk, gs in groups.items()
    }
    # 这一天每个场地实际生效的对照：段里有几场（两台机器）时要把两边的机位合起来
    site_mappings: dict[str, dict[int, int]] = defaultdict(dict)
    for (day_dir, session_key), samples in sorted(groups.items(), key=lambda kv: kv[0][1]):
        if session_key not in wanted:
            continue
        site = group_site[(day_dir, session_key)]
        if not site_layout.has_private_rooms(site):
            continue
        # 同一天同场地、另一台机器、开机时刻挨着的那一场：跟「机位核对」页合成
        # 一段的判据一样。雷诺 7 个摄像头是独立装的，1~6 号间可能录在对面机器上
        videos = dict(group_videos[(day_dir, session_key)])
        offsets: dict[int, int] = {}
        mine_start = group_start[(day_dir, session_key)]
        mine_machine = group_machine[(day_dir, session_key)]
        # 只有雷诺 7 路是独立装的，才把对面采集机的机位并进来；博朗旺仍按本场
        if _site_key(site) == "gouchang":
            for (d2, k2), _ss2 in groups.items():
                if d2 != day_dir or k2 == session_key:
                    continue
                if group_site[(d2, k2)] != site:
                    continue
                m2 = group_machine[(d2, k2)]
                if not m2 or (mine_machine and m2 == mine_machine):
                    continue
                st2 = group_start[(d2, k2)]
                if mine_start is None or st2 is None:
                    continue
                gap = int((st2 - mine_start).total_seconds() * 1000)
                if abs((st2 - mine_start).total_seconds()) > _PAIR_WINDOW_SEC:
                    continue
                for cam, path in group_videos[(d2, k2)].items():
                    if cam not in videos:
                        videos[cam] = path
                        offsets[cam] = gap
        try:
            r = await _validate_and_apply(db, samples, session_key, site, mapping, user_id,
                                          videos=videos, offsets=offsets)
            site_mappings[site].update({int(k): int(v) for k, v in r["mapping"].items()})
            results.append({
                "session_key": session_key,
                "updated": r["updated"],
                "missing_rooms": r["missing_rooms"],
            })
        except ValueError as exc:
            failed.append({"session_key": session_key, "error": str(exc)})
    if not results and not failed:
        raise ValueError("选中的场次里没有可核对的样本")

    extra: list[dict] = []
    if site_mappings:
        # 选中场次里出现过哪些 IMU：只有「配对那只在选中段里、这只单独在别的段里」
        # 才有依据套用同一套对照
        selected_imus: dict[str, set[int]] = defaultdict(set)
        for (day_dir, session_key), samples in groups.items():
            if session_key not in wanted:
                continue
            site = site_layout.site_of(session_key, day_dir, samples[0].video_cam1_path)
            if site in site_mappings:
                selected_imus[site].update(_imu_set(samples))
        corrected = set(
            (
                await db.execute(
                    select(SessionCamMap.session_key).where(
                        SessionCamMap.session_key.in_([k for _d, k in groups])
                    )
                )
            ).scalars().all()
        )
        for (day_dir, session_key), samples in sorted(groups.items(), key=lambda kv: kv[0][1]):
            if session_key in wanted:
                continue
            site = site_layout.site_of(session_key, day_dir, samples[0].video_cam1_path)
            if site not in site_mappings or not site_layout.has_private_rooms(site):
                continue
            # 人工确认过的场次不动：那可能是另一套错位
            if session_key in corrected or any(s.video_cams for s in samples):
                continue
            lay = site_layout.LAYOUT.get(site) or {}
            imus = _imu_set(samples)
            split = [
                imu for imu in sorted(imus)
                if (partner := _paired_imu(lay, imu)) is not None
                and partner not in imus
                and partner in selected_imus.get(site, set())
            ]
            if not split:
                continue
            try:
                r = await _validate_and_apply(db, samples, session_key, site, site_mappings[site], user_id)
            except ValueError as exc:
                failed.append({"session_key": session_key, "error": str(exc)})
                continue
            extra.append({
                "session_key": session_key,
                "updated": r["updated"],
                "missing_rooms": r["missing_rooms"],
                "imus": split,
            })
    await db.commit()
    return {
        "updated": sum(r["updated"] for r in results) + sum(r["updated"] for r in extra),
        "results": results,
        "extra": extra,
        "failed": failed,
    }


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
