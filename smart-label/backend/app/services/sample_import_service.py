"""
扫描 NAS 上 data_raw/ 目录，按会话前缀分组 3路视频+IMU CSV，写入 samples 表。
沿用 label_studio/upload_server.py 里已验证过的多摄像头文件名分组逻辑：
    multicam_{date}_{time}_cam{N}_imu{N}_...raw.{mp4,csv}
会话前缀 = 文件名去掉 "_cam{N}..." 之后的部分。

扫描在后台异步跑（不阻塞请求线程），前端通过轮询状态接口显示进度条。
"""

import asyncio
import os
import re
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
        _progress = ScanProgress(status="running")
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


def _group_key_and_cam(filename: str) -> tuple[str, int] | None:
    stem = os.path.splitext(filename)[0]
    match = _CAM_RE.match(stem)
    if not match:
        return None
    return match.group(1), int(match.group(2))


def _parse_session_date(session_key: str) -> date | None:
    match = _DATE_RE.search(session_key)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


async def _do_scan(db: AsyncSession, nas_root: str, admin: User) -> None:
    data_raw_dir = os.path.join(nas_root, "data_raw")
    groups: dict[str, dict[int, dict[str, str]]] = {}

    for root, _dirs, files in os.walk(data_raw_dir):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower().lstrip(".")
            if ext not in ("mp4", "csv"):
                continue
            parsed = _group_key_and_cam(fname)
            if parsed is None:
                continue
            session_key, cam_idx = parsed
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, nas_root)
            groups.setdefault(session_key, {}).setdefault(cam_idx, {})[ext] = rel_path

    _progress.total_groups = len(groups)

    for session_key, cams in groups.items():
        _progress.processed += 1

        if not all(c in cams for c in (1, 2, 3)):
            _progress.detail.append(f"跳过 {session_key}：缺少完整的cam1/2/3")
            continue
        if any("mp4" not in cams[c] for c in (1, 2, 3)):
            _progress.detail.append(f"跳过 {session_key}：缺少视频文件")
            continue

        exists = (await db.execute(select(Sample.id).where(Sample.sample_code == session_key))).scalar_one_or_none()
        if exists is not None:
            _progress.skipped_existing += 1
            continue

        csv_rel = cams[1].get("csv") or next((cams[c]["csv"] for c in (2, 3) if "csv" in cams[c]), None)
        if csv_rel is None:
            _progress.detail.append(f"跳过 {session_key}：找不到IMU CSV")
            continue

        cam_paths = {c: cams[c]["mp4"] for c in (1, 2, 3)}
        all_files = [*cam_paths.values(), csv_rel]
        missing = [p for p in all_files if not os.path.isfile(os.path.join(nas_root, p))]

        probe = probe_video(os.path.join(nas_root, cam_paths[1]))
        row_count = count_csv_rows(os.path.join(nas_root, csv_rel))
        total_size = sum(
            os.path.getsize(os.path.join(nas_root, p))
            for p in all_files
            if os.path.isfile(os.path.join(nas_root, p))
        )

        sample = Sample(
            sample_code=session_key,
            session_date=_parse_session_date(session_key),
            video_cam1_path=cam_paths[1],
            video_cam2_path=cam_paths[2],
            video_cam3_path=cam_paths[3],
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
                for rel_path, file_type in [
                    (cam_paths[1], MediaFileType.raw_video),
                    (cam_paths[2], MediaFileType.raw_video),
                    (cam_paths[3], MediaFileType.raw_video),
                    (csv_rel, MediaFileType.raw_imu_csv),
                ]:
                    media_exists = (
                        await db.execute(select(MediaFile.id).where(MediaFile.relative_path == rel_path))
                    ).scalar_one_or_none()
                    if media_exists is None:
                        content_type = "text/csv" if file_type == MediaFileType.raw_imu_csv else "video/mp4"
                        db.add(MediaFile(file_type=file_type, relative_path=rel_path, content_type=content_type))
                await db.flush()
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            _progress.detail.append(f"跳过 {session_key}：数据库冲突：{exc.orig}")
            _progress.skipped_existing += 1
            continue

        _progress.created += 1
        if missing:
            _progress.errors += 1
        else:
            _progress.verified += 1
