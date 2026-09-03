"""
扫描 NAS 上 data_raw/ 目录，按会话前缀分组 2或3路视频+IMU CSV，写入 samples 表
（cam1+cam2 必须都有，cam3 可选，兼容早期只录2路的历史数据）。
沿用 label_studio/upload_server.py 里已验证过的多摄像头文件名分组逻辑：
    multicam_{date}_{time}_cam{N}_imu{N}_...raw.{mp4,csv}
会话前缀 = 文件名去掉 "_cam{N}..." 之后的部分。

一个会话（同一批固定摄像头）下可能有不止一个 IMU 的 CSV——比如同一空间、
同一套三路摄像头，好几只狗依次背不同 IMU 设备录，摄像头只录一份，IMU CSV
却有好几份。视频按 cam 编号分组、CSV 按 imu 编号分组，两者分开处理：一个
会话有几个 IMU 就产出几个样本，都指向同一份视频；只有 1 个 IMU 时样本编号
沿用会话前缀本身，超过 1 个才加 "_imu{N}" 后缀区分（文件名里的 cam 编号
在 CSV 上只是模板带出来的，不代表跟哪个 IMU 强绑定，不能拿来做分组键）。

扫描在后台异步跑（不阻塞请求线程），前端通过轮询状态接口显示进度条。

性能设计（一万级session规模下验证过原版本会很慢，这里做了两处优化）：
1. 存在性检查批量查询：原来每个session单独查一次"是否已存在"，上万个session
   就是上万次数据库往返。改成扫描开始时一次性把所有已存在的sample_code/
   media relative_path拉出来放进内存set，成员判断变成O(1)。
2. ffprobe/CSV行数统计并发跑：这两个操作是"起外部进程/读文件"的IO密集型
   同步调用，原来是新session挨个串行跑。改成 asyncio.to_thread + 信号量
   限流并发（默认8路并发），数据库写入仍然串行（保证SAVEPOINT语义），
   但最耗时的探测环节被并行化了。
"""

import asyncio
import os
import re
import time
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionLocal
from app.models.media_file import MediaFile, MediaFileType
from app.models.sample import ImportStatus, Sample
from app.models.user import User
from app.utils.ffprobe import count_csv_rows, probe_video

_CAM_RE = re.compile(r"^(.+?)_cam(\d+)_imu(\d+)", re.IGNORECASE)
_DATE_RE = re.compile(r"(\d{4})(\d{2})(\d{2})")
_PROBE_CONCURRENCY = 8


@dataclass
class ScanProgress:
    status: str = "idle"  # idle | running | done | error
    total_groups: int = 0
    processed: int = 0
    created: int = 0
    skipped_existing: int = 0
    verified: int = 0
    errors: int = 0
    detail: list[str] = field(default_factory=list)
    error_message: str | None = None
    started_at: float | None = None
    elapsed_sec: float = 0.0
    estimated_remaining_sec: float | None = None

    def tick(self) -> None:
        """每处理完一个session调用一次，刷新耗时/预计剩余时间。"""
        if self.started_at is None:
            return
        self.elapsed_sec = time.time() - self.started_at
        if self.processed > 0 and self.elapsed_sec > 0:
            rate = self.processed / self.elapsed_sec
            remaining = max(self.total_groups - self.processed, 0)
            self.estimated_remaining_sec = remaining / rate if rate > 0 else None


# 单进程内只允许一个扫描任务在跑；进度状态直接放内存里，不用建表
# （这是一次性管理员操作，不需要跨进程/重启后仍可查的持久化）。
_progress = ScanProgress()
_scan_lock = asyncio.Lock()


def get_progress() -> ScanProgress:
    return _progress


async def start_scan_background(nas_root: str, admin_id: int) -> bool:
    """已有扫描在跑则返回 False（不重复启动）；否则后台起一个任务，立即返回 True。"""
    if _scan_lock.locked():
        return False
    asyncio.create_task(run_scan(nas_root, admin_id))
    return True


async def run_scan(nas_root: str, admin_id: int) -> None:
    """跑一次完整扫描；供 web 触发（start_scan_background）和定时任务（scheduler）共用。"""
    global _progress
    async with _scan_lock:
        _progress = ScanProgress(status="running", started_at=time.time())
        try:
            async with SessionLocal() as db:
                admin = await db.get(User, admin_id)
                if admin is None:
                    raise RuntimeError("admin user not found")
                await _do_scan(db, nas_root, admin)
            _progress.status = "done"
        except Exception as exc:  # noqa: BLE001 后台任务异常不能让进程崩，记录状态即可
            _progress.status = "error"
            _progress.error_message = f"{type(exc).__name__}: {exc}"


def _parse_filename(filename: str) -> tuple[str, int, int] | None:
    stem = os.path.splitext(filename)[0]
    match = _CAM_RE.match(stem)
    if not match:
        return None
    return match.group(1), int(match.group(2)), int(match.group(3))


def _parse_session_date(session_key: str) -> date | None:
    match = _DATE_RE.search(session_key)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _scan_filesystem(data_raw_dir: str, nas_root: str) -> dict[str, dict[str, dict[int, str]]]:
    """
    纯文件系统遍历，不涉及数据库/子进程，跑在线程池里避免阻塞事件循环。

    视频按 cam 编号分组、CSV 按 imu 编号分组，两者分开——一个空间三路固定摄像头
    可以被好几个不同的 IMU 设备共用同一批视频（多只狗依次在同一空间录，各自
    背一个 IMU，摄像头只录了一份）。之前这里把视频和 CSV 混在同一个"按cam
    编号"的字典里，同一个 cam 编号下如果有多个 imu 编号的 CSV（文件名里的
    cam 编号只是巧合/模板带出来的，不代表跟哪个 IMU 强绑定），后写入的会直接
    覆盖先写入的，其余 IMU 的 CSV 就这样丢了、一声不吭——只会生成一个样本，
    而不是每个 IMU 各一个样本。
    """
    groups: dict[str, dict[str, dict[int, str]]] = {}
    for root, _dirs, files in os.walk(data_raw_dir):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower().lstrip(".")
            if ext not in ("mp4", "csv"):
                continue
            parsed = _parse_filename(fname)
            if parsed is None:
                continue
            session_key, cam_idx, imu_idx = parsed
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, nas_root)
            g = groups.setdefault(session_key, {"videos": {}, "csvs": {}})
            if ext == "mp4":
                # 同一路摄像头正常只有一份视频；万一撞了（不同 imu 编号的文件名
                # 巧合落到同一个 cam 编号），保留先扫到的那份，不用后写的覆盖
                g["videos"].setdefault(cam_idx, rel_path)
            else:
                g["csvs"].setdefault(imu_idx, rel_path)
    return groups


def _probe_group_sync(nas_root: str, cam_paths: dict[int, str], csv_rel: str) -> dict:
    """一个session的全部探测工作（IO密集，在线程池里跑）。"""
    all_files = [*cam_paths.values(), csv_rel]
    missing = [p for p in all_files if not os.path.isfile(os.path.join(nas_root, p))]
    probe = probe_video(os.path.join(nas_root, cam_paths[1]))
    row_count = count_csv_rows(os.path.join(nas_root, csv_rel))
    total_size = sum(
        os.path.getsize(os.path.join(nas_root, p)) for p in all_files if os.path.isfile(os.path.join(nas_root, p))
    )
    return {"missing": missing, "probe": probe, "row_count": row_count, "total_size": total_size}


async def _do_scan(db: AsyncSession, nas_root: str, admin: User) -> None:
    data_raw_dir = os.path.join(nas_root, "data_raw")
    groups = await asyncio.to_thread(_scan_filesystem, data_raw_dir, nas_root)
    # 先给个粗略估计（按 session 数），下面按 IMU 展开出实际样本数之后会再校正一次，
    # 避免这中间 tick() 拿 0 做分母算出奇怪的剩余时间
    _progress.total_groups = len(groups)

    # 先过滤出结构完整、且还没写文件级候选路径的候选样本（不查库，纯内存判断）。
    # 一个 session（同一批固定摄像头视频）下每个 IMU 编号各产出一个样本，
    # 都指向同一份视频；只有 1 个 IMU 的常规情况样本编号沿用 session_key
    # 本身（兼容已经这么导入过的历史样本），有多个 IMU 时才加 _imu{N} 后缀区分。
    candidates: dict[str, dict] = {}
    all_candidate_paths: set[str] = set()
    for session_key, g in groups.items():
        videos, csvs = g["videos"], g["csvs"]
        if not all(c in videos for c in (1, 2)):
            _progress.detail.append(f"跳过 {session_key}：缺少cam1/cam2视频")
            _progress.processed += 1
            _progress.tick()
            continue
        if not csvs:
            _progress.detail.append(f"跳过 {session_key}：找不到IMU CSV")
            _progress.processed += 1
            _progress.tick()
            continue
        cam_paths = {c: videos[c] for c in (1, 2, 3) if c in videos}
        imu_items = sorted(csvs.items())
        for imu_idx, csv_rel in imu_items:
            sample_code = session_key if len(imu_items) == 1 else f"{session_key}_imu{imu_idx}"
            candidates[sample_code] = {"cam_paths": cam_paths, "csv_rel": csv_rel}
            all_candidate_paths.update(cam_paths.values())
            all_candidate_paths.add(csv_rel)

    _progress.total_groups = len(candidates) + _progress.processed

    if not candidates:
        return

    # 一次性批量查询已存在的 sample_code / media_files，避免每个session单独往返数据库
    existing_codes = set(
        (await db.execute(select(Sample.sample_code).where(Sample.sample_code.in_(candidates.keys())))).scalars()
    )
    existing_media_paths = set(
        (
            await db.execute(select(MediaFile.relative_path).where(MediaFile.relative_path.in_(all_candidate_paths)))
        ).scalars()
    )

    new_session_keys = [k for k in candidates if k not in existing_codes]
    _progress.skipped_existing += len(candidates) - len(new_session_keys)
    _progress.processed += len(candidates) - len(new_session_keys)
    _progress.tick()

    # 并发探测（ffprobe/csv行数/文件大小），限流避免一下起几千个ffmpeg进程
    semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

    async def probe_one(session_key: str) -> tuple[str, dict]:
        async with semaphore:
            info = candidates[session_key]
            result = await asyncio.to_thread(_probe_group_sync, nas_root, info["cam_paths"], info["csv_rel"])
            return session_key, result

    for coro in asyncio.as_completed([probe_one(k) for k in new_session_keys]):
        session_key, result = await coro
        info = candidates[session_key]
        cam_paths, csv_rel = info["cam_paths"], info["csv_rel"]
        probe, row_count, total_size, missing = result["probe"], result["row_count"], result["total_size"], result["missing"]

        sample = Sample(
            sample_code=session_key,
            session_date=_parse_session_date(session_key),
            video_cam1_path=cam_paths[1],
            video_cam2_path=cam_paths[2],
            video_cam3_path=cam_paths.get(3),
            imu_csv_path=csv_rel,
            video_duration_sec=probe["duration_sec"] if probe else None,
            video_fps=probe["fps"] if probe else None,
            video_resolution=f"{probe['width']}x{probe['height']}" if probe and probe.get("width") else None,
            imu_row_count=row_count,
            total_size_bytes=total_size,
            import_status=ImportStatus.error if missing else ImportStatus.verified,
            import_error=f"缺失文件: {missing}" if missing else None,
            created_by=admin.id,
        )

        # 每个session独立一个SAVEPOINT提交：万一撞了唯一键冲突，只回滚这一个
        # session，不会拖累已经处理完的其他session
        try:
            async with db.begin_nested():
                db.add(sample)
                media_entries = [(p, MediaFileType.raw_video) for p in cam_paths.values()]
                media_entries.append((csv_rel, MediaFileType.raw_imu_csv))
                for rel_path, file_type in media_entries:
                    if rel_path not in existing_media_paths:
                        content_type = "text/csv" if file_type == MediaFileType.raw_imu_csv else "video/mp4"
                        db.add(MediaFile(file_type=file_type, relative_path=rel_path, content_type=content_type))
                        existing_media_paths.add(rel_path)  # 同一批新session可能共享文件，避免重复insert
                await db.flush()
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            _progress.detail.append(f"跳过 {session_key}：数据库冲突：{exc.orig}")
            _progress.skipped_existing += 1
            _progress.processed += 1
            _progress.tick()
            continue

        _progress.created += 1
        if missing:
            _progress.errors += 1
        else:
            _progress.verified += 1
        _progress.processed += 1
        _progress.tick()
