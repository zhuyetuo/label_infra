"""狗场单间：按**摄像头**算"狗在单间里待了多久"，不按 IMU 算。

为什么不能按 IMU 算：一只狗两个项圈轮换充电、而且两个都录（当班 + 备用同时采），
一个小时的画面对应两份样本（imu15 和 imu16），按样本加时长就是双倍；哪天只戴了一个
又是单倍——"总共采了多少小时"这个数按 IMU 根本算不准。

按摄像头就没有这个问题：狗场一间一狗一摄像头，一个单间一路画面，同一段视频不管配了
几个 IMU 都只算一次。「在单间里多久」用画面扫描（sample_vision_scans，每 5 秒采一点
看有没有狗）的时间线算：有狗的采样点数 × 采样间隔。

── 狗是谁：按视频文件名，不按样本 ────────────────────────────────────────

采集端给每个单间的画面文件名写死了 `_camN_imuM`（cam4_imu15 = 4 号单间、当班项圈 15 号），
一间一狗，所以 **文件名里的 imu → 狗档案 → 狗**，这就是这段画面里的狗。不做重识别，
也不看样本挂的是哪个 IMU——老数据里有一批错误导入的样本把所有房间的画面都挂到了每只狗
名下（9 月修掉的那个"狗场怎么是 3 路"），按样本归房间会把别的房间的狗算进来。

所以这里的做法是：把这一天所有狗场样本三个槽位里的视频**拉平成一个视频集合**，按
（日期、cam、录制起始时间戳）去重，每段视频只算一次，房间和狗都从文件名读。
天花板那种公用机位（`_cam7_raw`，没有 imu 号）自然不在里面——它拍的是走廊，不是单间。

每段视频带上"挂在哪份样本上"，页面上能点开看画面复查。
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionLocal
from app.models.sample import Sample
from app.models.sample_vision_scan import STATE_OK, SampleVisionScan
from app.services import vision_sam_client as vc
from app.services import vision_scan_service as vscan
from app.services.daily_stats_service import _imu_to_dog
from app.services.dog_presence_service import is_one_dog_site
from app.services.skin_tracking_service import _imu_of

# multicam_20260917_030015023_cam4_imu15_raw.mp4 → 起始时间戳 / 机位 / 项圈
_CAM_IMU_RE = re.compile(r"_cam(\d+)_imu(\d+)", re.IGNORECASE)
_STAMP_RE = re.compile(r"(\d{8}_\d{6,9})")
_SLOTS = ("cam1", "cam2", "cam3")


def parse_room_video(path: str) -> tuple[int, int, str] | None:
    """(机位号, 文件名里的项圈号, 去重键)。不是单间画面（没有 _camN_imuM）返回 None。

    去重键：同一段录制可能以不同路径出现（原始 / 重采样、两台机器各传一份），按
    「起始时间戳 + 机位」认是同一段；文件名里没时间戳就退回按文件名。
    """
    base = os.path.basename(path or "")
    m = _CAM_IMU_RE.search(base)
    if not m:
        return None
    cam, imu = int(m.group(1)), int(m.group(2))
    st = _STAMP_RE.search(base)
    key = f"{st.group(1)}_cam{cam}" if st else re.sub(r"\.[^.]+$", "", base)
    return cam, imu, key


def _start_of(path: str) -> str | None:
    st = _STAMP_RE.search(os.path.basename(path or ""))
    if not st:
        return None
    s = st.group(1)
    try:
        return datetime.strptime(s[:15], "%Y%m%d_%H%M%S").strftime("%H:%M:%S")
    except ValueError:
        return None


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


async def rooms(db: AsyncSession, date_from: date, date_to: date) -> list[dict]:
    """按 (日期, 单间机位) 汇总：录了多久、画面里有狗多久、每段视频挂在哪份样本上。"""
    imu_map = await _imu_to_dog(db)
    samples = (await db.execute(
        select(Sample).where(Sample.session_date.is_not(None), Sample.session_date >= date_from,
                             Sample.session_date <= date_to)
    )).scalars().all()
    gouchang = [s for s in samples if is_one_dog_site(s.sample_code, os.path.dirname(s.video_cam1_path or ""))]
    if not gouchang:
        return []
    scans = (await db.execute(
        select(SampleVisionScan).where(SampleVisionScan.sample_id.in_([s.id for s in gouchang]))
    )).scalars().all()
    scan_by = {(r.sample_id, r.cam): r for r in scans}

    # (日期, cam, 去重键) → 这段视频：挂在哪些 (样本, 槽位) 上
    videos: dict[tuple, dict] = {}
    for s in gouchang:
        own_imu = _imu_of(s.sample_code)
        for slot, path in zip(_SLOTS, (s.video_cam1_path, s.video_cam2_path, s.video_cam3_path)):
            if not path:
                continue
            parsed = parse_room_video(path)
            if parsed is None:
                continue
            cam, imu, key = parsed
            v = videos.setdefault((s.session_date, cam, key), {
                "cam": cam, "imu": f"IMU{imu}", "path": path, "carriers": []})
            # 文件名里的项圈号跟样本的一致的排前面：它是这段画面"自己的"样本，扫描结果和时长优先用它的
            v["carriers"].append((own_imu == f"IMU{imu}", s, slot))

    buckets: dict[tuple, dict] = {}
    for (day, cam, _key), v in videos.items():
        carriers = sorted(v["carriers"], key=lambda c: (not c[0], c[1].id))
        scan = next((scan_by[(s.id, slot)] for _o, s, slot in carriers
                     if (s.id, slot) in scan_by and scan_by[(s.id, slot)].state == STATE_OK), None)
        dur = float(scan.duration_sec) if scan is not None and scan.duration_sec else 0.0
        if not dur:
            dur = next((float(s.video_duration_sec) for _o, s, slot in carriers if slot == "cam1" and s.video_duration_sec), 0.0)
        present = None
        if scan is not None:
            present = present_seconds(vscan.load_timeline(scan.timeline),
                                      float(scan.every_sec) if scan.every_sec is not None else None,
                                      float(scan.no_dog_ratio) if scan.no_dog_ratio is not None else None,
                                      float(scan.duration_sec) if scan.duration_sec is not None else None)
            if present is not None and dur:
                present = min(present, dur)
        own, own_slot = carriers[0][1], carriers[0][2]
        b = buckets.setdefault((day, cam), {"imus": set(), "dogs": set(), "videos": []})
        b["imus"].add(v["imu"])
        if imu_map.get(v["imu"]):
            b["dogs"].add(imu_map[v["imu"]])
        b["videos"].append({
            "sample_id": own.id,
            "sample_code": own.sample_code,
            # 这段画面在"自己的"样本上占哪个槽位：补扫时扫描结果写到这一格
            "slot": own_slot,
            "path": v["path"],
            "file": os.path.basename(v["path"]),
            "start": _start_of(v["path"]),
            "imu": v["imu"],
            "dog_name": imu_map.get(v["imu"]),
            "duration_seconds": round(dur, 1),
            "scanned": scan is not None and present is not None,
            "present_seconds": round(present, 1) if present is not None else None,
            # 这段画面还挂在哪些别的样本上（轮换的另一个项圈、或者错误导入的）
            "also_on": sorted({s.sample_code for _o, s, _sl in carriers[1:]}),
        })

    out = []
    for (day, cam), b in buckets.items():
        vids = sorted(b["videos"], key=lambda x: (x["start"] or "", x["file"]))
        scanned = [x for x in vids if x["scanned"]]
        recorded = sum(x["duration_seconds"] for x in vids)
        out.append({
            "stat_date": day.isoformat(),
            "cam": f"cam{cam}",
            "dog_name": "、".join(sorted(b["dogs"])) or None,
            "imus": sorted(b["imus"], key=lambda x: int(x[3:]) if x[3:].isdigit() else 0),
            "n_videos": len(vids),
            "n_scanned": len(scanned),
            "n_unscanned": len(vids) - len(scanned),
            "recorded_seconds": round(recorded, 1),
            "scanned_seconds": round(sum(x["duration_seconds"] for x in scanned), 1),
            # 只按扫过的那些视频算；没扫的不知道，不包含它们的时间
            "present_seconds": round(sum(x["present_seconds"] or 0.0 for x in scanned), 1),
            # 一天超过 24 小时 = 同一段画面以不同名字导了两遍，要查
            "over_day": recorded > 24 * 3600 + 60,
            "videos": vids,
        })
    out.sort(key=lambda r: (r["stat_date"], r["cam"]), reverse=True)
    return out


# ── 补扫：把这段日期里没扫过的单间画面在后台扫一遍 ─────────────────────────
#
# 扫描本来只有样本列表里手动勾选那条路，而且是同步等结果的。单间统计这一页要的是
# "这几天没扫的全扫了"，几十上百段、一段几十秒，得放后台、看进度。
# 串行不并发：扫描跟 SAM 用的是同一张卡，并发会把两个模型一起 OOM（见 scan_many）。
# 每段只扫"自己的"那份样本的那个槽位，同一段画面挂在几份样本上也只扫一次。


#: 同时扫几段。视觉服务那边 GPU 推理有锁、解码是各自的 ffmpeg 进程，4 路并行时 GPU
#: 才吃得满；再多就是排队。算法机 4 核，解码也就撑这么多
CONCURRENCY = max(1, int(os.environ.get("ROOM_SCAN_CONCURRENCY", "4") or 4))


@dataclass
class ScanJob:
    status: str = "idle"            # idle | running | paused | done | cancelled | error
    total: int = 0
    done: int = 0
    failed: int = 0
    current: list[str] | None = None      # 正在扫的那几段
    started_at: float | None = None
    date_from: str | None = None
    date_to: str | None = None
    error: str | None = None
    concurrency: int = CONCURRENCY
    paused_sec: float = 0.0               # 暂停累计，估算剩余时间时扣掉

    def as_dict(self) -> dict:
        d = asdict(self)
        active = (time.time() - self.started_at - self.paused_sec) if self.started_at else 0.0
        d["elapsed_sec"] = round(max(0.0, active), 1)
        remain = self.total - self.done - self.failed
        rate = (self.done + self.failed) / max(1e-6, active) if self.started_at else 0.0
        d["estimated_remaining_sec"] = round(remain / rate) if rate > 0 and self.status == "running" else None
        return d


_job = ScanJob()
_job_lock = asyncio.Lock()
# 暂停 / 取消：set 了才往下走；取消是个标志，正在扫的那几段扫完就收
_resume = asyncio.Event()
_resume.set()
_cancel = False


def scan_status() -> dict:
    return _job.as_dict()


def pause_scan() -> dict:
    global _job
    if _job.status == "running":
        _job.status = "paused"
        _job._paused_at = time.time()      # type: ignore[attr-defined]
        _resume.clear()
    return _job.as_dict()


def resume_scan() -> dict:
    global _job
    if _job.status == "paused":
        _job.paused_sec += time.time() - getattr(_job, "_paused_at", time.time())
        _job.status = "running"
        _resume.set()
    return _job.as_dict()


def cancel_scan() -> dict:
    global _cancel
    if _job.status in ("running", "paused"):
        _cancel = True
        _resume.set()
    return _job.as_dict()


async def pending_videos(db: AsyncSession, date_from: date, date_to: date) -> list[dict]:
    """这段日期里还没扫过（或扫失败）的单间画面，每段一条 {sample_id, slot, path, file}。"""
    out = []
    for r in await rooms(db, date_from, date_to):
        for v in r["videos"]:
            if not v["scanned"]:
                out.append({"sample_id": v["sample_id"], "slot": v["slot"], "path": v["path"], "file": v["file"]})
    return out


async def _weights() -> str | None:
    """狗检测在不在、用的哪份权重。不在就抛，别把几百段全扫成失败。"""
    st = await vc.dog_status()
    if not st.get("available", True):
        raise RuntimeError(f"狗检测不可用：{st.get('error') or '视觉服务没起'}")
    return st.get("loaded_weights") or st.get("weights")


async def scan_one(db: AsyncSession, sample_id: int, slot: str, every_sec: float = 5.0, conf: float = 0.35) -> dict:
    """单独扫一段（页面上某一行点「扫这段」）。同步等结果，一小时的视频几秒钟。"""
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise ValueError("样本不存在")
    path = {"cam1": sample.video_cam1_path, "cam2": sample.video_cam2_path, "cam3": sample.video_cam3_path}.get(slot)
    if not path:
        raise ValueError(f"这份样本没有 {slot} 这一路")
    weights = await _weights()
    r = await vc.scan_dog(path, every_sec=every_sec, conf=conf)
    await vscan._upsert(db, vscan.scan_to_row(sample_id, slot, r, weights))
    await db.commit()
    return {"sample_id": sample_id, "slot": slot, "verdict": r.get("verdict"), "sampled": r.get("sampled"),
            "frames_with_dog": r.get("frames_with_dog"), "duration_sec": r.get("duration_sec")}


async def start_scan(date_from: date, date_to: date, every_sec: float = 5.0, conf: float = 0.35,
                     force: bool = False) -> dict:
    """后台扫这段日期没扫的单间画面（force=True 连扫过的也重扫）。已经有一个在跑就不重复起。"""
    if _job_lock.locked():
        return {"started": False, "already_running": True, **_job.as_dict()}
    async with SessionLocal() as db:
        if force:
            todo = [{"sample_id": v["sample_id"], "slot": v["slot"], "path": v["path"], "file": v["file"]}
                    for r in await rooms(db, date_from, date_to) for v in r["videos"]]
        else:
            todo = await pending_videos(db, date_from, date_to)
    if not todo:
        return {"started": False, "already_running": False, "total": 0, **{k: v for k, v in _job.as_dict().items() if k != "total"}}
    asyncio.create_task(_run_scan(todo, date_from, date_to, every_sec, conf))
    return {"started": True, "already_running": False, "total": len(todo)}


async def _run_scan(todo: list[dict], date_from: date, date_to: date, every_sec: float, conf: float) -> None:
    """并行 CONCURRENCY 路扫；每段扫完各自写库；暂停在取下一段之前生效，取消在正在扫的
    几段扫完之后生效。"""
    global _job, _cancel
    async with _job_lock:
        _job = ScanJob(status="running", total=len(todo), started_at=time.time(),
                       date_from=date_from.isoformat(), date_to=date_to.isoformat(), current=[],
                       concurrency=CONCURRENCY)
        _cancel = False
        _resume.set()
        try:
            weights = await _weights()
            queue: asyncio.Queue = asyncio.Queue()
            for item in todo:
                queue.put_nowait(item)
            db_lock = asyncio.Lock()          # 一个 session 不能被几个协程同时用

            async def worker(db):
                while True:
                    await _resume.wait()
                    if _cancel or queue.empty():
                        return
                    item = queue.get_nowait()
                    _job.current.append(item["file"])
                    try:
                        r = await vc.scan_dog(item["path"], every_sec=every_sec, conf=conf)
                        async with db_lock:
                            await vscan._upsert(db, vscan.scan_to_row(item["sample_id"], item["slot"], r, weights))
                            await db.commit()
                        _job.done += 1
                    except Exception as e:  # noqa: BLE001 一段挂了不该带倒整批
                        async with db_lock:
                            await vscan._upsert(db, vscan.failed_row(item["sample_id"], item["slot"], f"{type(e).__name__}: {e}"))
                            await db.commit()
                        _job.failed += 1
                    finally:
                        if item["file"] in _job.current:
                            _job.current.remove(item["file"])

            async with SessionLocal() as db:
                await asyncio.gather(*(worker(db) for _ in range(_job.concurrency)))
            _job.status = "cancelled" if _cancel and not queue.empty() else "done"
            _job.current = []
        except Exception as exc:  # noqa: BLE001 后台任务异常不能让进程崩，记录状态即可
            _job.status = "error"
            _job.error = f"{type(exc).__name__}: {exc}"
            _job.current = []


__all__ = ["rooms", "parse_room_video", "present_seconds", "pending_videos", "start_scan", "scan_status"]
