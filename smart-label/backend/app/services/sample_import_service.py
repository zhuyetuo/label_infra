"""
扫描 NAS 上 data_raw/ 目录，按会话前缀分组 3路视频+IMU CSV，写入 samples 表。
沿用 label_studio/upload_server.py 里已验证过的多摄像头文件名分组逻辑：
    multicam_{date}_{time}_cam{N}_imu{N}_...raw.{mp4,csv}
会话前缀 = 文件名去掉 "_cam{N}..." 之后的部分。
"""

import os
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media_file import MediaFile, MediaFileType
from app.models.sample import ImportStatus, Sample
from app.models.user import User
from app.schemas.sample import ImportScanResult
from app.utils.ffprobe import count_csv_rows, probe_video

_CAM_RE = re.compile(r"^(.+?)_cam(\d+)_imu(\d+)", re.IGNORECASE)


def _group_key_and_cam(filename: str) -> tuple[str, int] | None:
    stem = os.path.splitext(filename)[0]
    match = _CAM_RE.match(stem)
    if not match:
        return None
    return match.group(1), int(match.group(2))


async def scan_and_import(db: AsyncSession, nas_root: str, admin: User) -> ImportScanResult:
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

    detail: list[str] = []
    created = skipped = verified = errors = 0

    for session_key, cams in groups.items():
        if not all(c in cams for c in (1, 2, 3)):
            detail.append(f"跳过 {session_key}：缺少完整的cam1/2/3")
            continue
        if any("mp4" not in cams[c] for c in (1, 2, 3)):
            detail.append(f"跳过 {session_key}：缺少视频文件")
            continue

        exists = (await db.execute(select(Sample.id).where(Sample.sample_code == session_key))).scalar_one_or_none()
        if exists is not None:
            skipped += 1
            continue

        # IMU CSV：优先用 cam1 关联的那份（多路CSV场景下的既定约定，见 cam1_imu1 命名）
        csv_rel = cams[1].get("csv") or next((cams[c]["csv"] for c in (2, 3) if "csv" in cams[c]), None)
        if csv_rel is None:
            detail.append(f"跳过 {session_key}：找不到IMU CSV")
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

        created += 1
        if missing:
            errors += 1
        else:
            verified += 1

    await db.commit()
    return ImportScanResult(
        scanned_sessions=len(groups),
        created=created,
        skipped_existing=skipped,
        verified=verified,
        errors=errors,
        detail=detail,
    )
