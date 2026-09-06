"""IMU 六轴曲线：元信息 + 窗口化LTTB降采样。"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.sample import Sample
from app.models.user import User
from app.schemas.envelope import ok
from app.schemas.imu import ImuMeta, ImuRows, ImuSeries
from app.services.imu_service import ImuReadError, get_meta, get_rows, get_series
from app.services.media_resolver import PathTraversalError, resolve_nas_path
from app.services.task_scope import sample_visible

router = APIRouter(prefix="/imu", tags=["imu"])


async def _resolve_csv_path(sample_id: int, db: AsyncSession, user: User) -> str:
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")
    # 跟媒体文件一个规矩：管理员随便看，其他人要在这个样本上有自己能看的任务，
    # 敏感样本对非管理员一律 403
    if not await sample_visible(db, sample_id, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无权访问该样本")
    try:
        return resolve_nas_path(sample.imu_csv_path)
    except PathTraversalError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "非法路径") from None


@router.get("/{sample_id}/meta")
async def get_imu_meta(
    sample_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    path = await _resolve_csv_path(sample_id, db, user)
    try:
        meta = get_meta(path)
    except ImuReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return ok(ImuMeta(**meta).model_dump())


@router.get("/{sample_id}/rows")
async def get_imu_rows(
    sample_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """逐行原始记录，分页返回，不做降采样——表格页想看真实数据用这个。"""
    path = await _resolve_csv_path(sample_id, db, user)
    try:
        rows = get_rows(path, offset, limit)
    except ImuReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return ok(ImuRows(**rows).model_dump())


@router.get("/{sample_id}/series")
async def get_imu_series(
    sample_id: int,
    start_ms: int = Query(0, ge=0),
    end_ms: int = Query(..., ge=0),
    max_points: int = Query(2000, ge=10, le=20000),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if end_ms < start_ms:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "end_ms 不能小于 start_ms")
    path = await _resolve_csv_path(sample_id, db, user)
    try:
        series = get_series(path, start_ms, end_ms, max_points)
    except ImuReadError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return ok(ImuSeries(**series).model_dump())
