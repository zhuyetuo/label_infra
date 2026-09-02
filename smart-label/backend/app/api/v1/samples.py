"""
样本导入/查询（admin）。扫描 NAS data_raw/ 目录，按会话分组2或3路视频+IMU CSV写入 samples 表。
调度器（app/workers/scheduler.py）每10分钟自动扫一次一次新数据，这里的手动触发只是
"不想等，立刻扫一次"的快捷方式，不是唯一入口。
"""

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.sample import SampleMediaOut, SampleOut, ScanProgressOut, ScanStartResult
from app.services.sample_import_service import get_progress, start_scan_background

router = APIRouter(prefix="/samples", tags=["samples"], dependencies=[Depends(require_role(UserRole.admin))])


@router.get("")
async def list_samples(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Sample).order_by(Sample.created_at.desc()))
    samples = result.scalars().all()
    return ok([SampleOut.model_validate(s).model_dump() for s in samples])


@router.get("/{sample_id}/media")
async def get_sample_media(sample_id: int, db: AsyncSession = Depends(get_db)):
    """
    返回样本4个原始文件对应的 media_file id（前端拿这些id去换 media token 播放/预览）。
    路径匹配不到时对应字段返回 null（比如手动录入的样本没走标准导入流程）。
    """
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    paths = [
        p
        for p in (sample.video_cam1_path, sample.video_cam2_path, sample.video_cam3_path, sample.imu_csv_path)
        if p is not None
    ]
    rows = (await db.execute(select(MediaFile.id, MediaFile.relative_path).where(MediaFile.relative_path.in_(paths)))).all()
    by_path = {path: mid for mid, path in rows}

    return ok(
        SampleMediaOut(
            video1_id=by_path.get(sample.video_cam1_path),
            video2_id=by_path.get(sample.video_cam2_path),
            video3_id=by_path.get(sample.video_cam3_path),
            csv_id=by_path.get(sample.imu_csv_path),
        ).model_dump()
    )


@router.post("/import-scan")
async def import_scan(admin: User = Depends(get_current_user)):
    """立即后台开始一次扫描，不阻塞请求。已有扫描在跑时不会重复启动。"""
    started = await start_scan_background(settings.nas_root, admin.id)
    return ok(ScanStartResult(already_running=not started).model_dump())


@router.get("/import-scan/status")
async def import_scan_status():
    """前端轮询这个接口显示进度条。"""
    return ok(ScanProgressOut(**asdict(get_progress())).model_dump())
