"""
样本导入/查询（admin）。扫描 NAS data_raw/ 目录，按会话分组2或3路视频+IMU CSV写入 samples 表。
调度器（app/workers/scheduler.py）每10分钟自动扫一次一次新数据，这里的手动触发只是
"不想等，立刻扫一次"的快捷方式，不是唯一入口。
"""

import asyncio
import json
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.dog import Dog
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.model_version import PrelabelItem, PrelabelResult
from app.schemas.sample import SampleMediaOut, SampleOut, SampleUpdate, ScanProgressOut, ScanStartResult
from app.services import algo_client
from app.services.imu_service import ImuReadError, get_meta
from app.services.media_resolver import PathTraversalError, resolve_nas_path
from app.services.sample_import_service import get_progress, start_scan_background
from app.services.task_scope import apply_task_scope

router = APIRouter(prefix="/samples", tags=["samples"], dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])

# 样本管理本身是管理员的事，但"取某个样本的媒体文件id"标注员/审核员也要用
# （标注工作台和审核查看都要放视频），所以这一个端点单独挂在不限角色的
# 路由上，内部再按任务范围校验，不能因为它就把整个样本管理放开。
scoped_router = APIRouter(prefix="/samples", tags=["samples"])


@router.get("")
async def list_samples(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Sample).order_by(Sample.created_at.desc()))
    samples = result.scalars().all()
    return ok([SampleOut.model_validate(s).model_dump() for s in samples])


@router.patch("/{sample_id}")
async def update_sample(sample_id: int, body: SampleUpdate, db: AsyncSession = Depends(get_db)):
    """现在只用来手动关联到哪只狗，采集端文件名还没带 dog 编号之前只能这样补。"""
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")
    updates = body.model_dump(exclude_unset=True)
    if "dog_id" in updates and updates["dog_id"] is not None:
        dog = await db.get(Dog, updates["dog_id"])
        if dog is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "狗不存在")
    for field, value in updates.items():
        setattr(sample, field, value)
    await db.commit()
    await db.refresh(sample)
    return ok(SampleOut.model_validate(sample).model_dump())


@scoped_router.get("/{sample_id}/media")
async def get_sample_media(
    sample_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    """
    返回样本4个原始文件对应的 media_file id（前端拿这些id去换 media token 播放/预览）。
    路径匹配不到时对应字段返回 null（比如手动录入的样本没走标准导入流程）。

    管理员可以看任意样本；标注员/审核员只有在这个样本上有自己能看的任务时才给，
    统一走 apply_task_scope，不在这里自己写角色判断。
    """
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    if user.role not in (UserRole.admin, UserRole.super_admin):
        visible = (
            await db.execute(apply_task_scope(select(Task.id).where(Task.sample_id == sample_id), user).limit(1))
        ).scalar_one_or_none()
        if visible is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无权访问该样本")

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
            video_fps=sample.video_fps,
        ).model_dump()
    )


@scoped_router.post("/{sample_id}/ai-prelabel")
async def ai_prelabel(
    sample_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    """
    标注员点"AI预标注"时调这个接口：同步调用 algo_service /infer 拿到预测的
    行为片段，写一份 JSON 落到 NAS（跟 imu_csv_path 同目录，文件名加
    _ai_label.json 后缀），更新 sample.ai_label_path，同时把片段直接返回给
    前端——不用再多等一轮"写盘→前端再读盘"，标注界面可以立刻拿这次返回的
    结果预填标注框。

    访问权限跟 get_sample_media 一样：管理员任意样本都能点，标注员/审核员
    只有在这个样本上有自己能看的任务时才行。
    """
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    if user.role not in (UserRole.admin, UserRole.super_admin):
        visible = (
            await db.execute(apply_task_scope(select(Task.id).where(Task.sample_id == sample_id), user).limit(1))
        ).scalar_one_or_none()
        if visible is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无权访问该样本")

    if not sample.imu_csv_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "该样本没有 IMU CSV，无法做 AI 预标注")

    # AI 服务返回的片段时间是绝对墙钟时间字符串，标注工作台用的是"相对 CSV 第一行"
    # 的毫秒数，所以要先拿到 CSV 起点时间来换算。跟 /imu/meta 用同一套解析。
    try:
        csv_abs = resolve_nas_path(sample.imu_csv_path)
        meta = await asyncio.to_thread(get_meta, csv_abs)
    except PathTraversalError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "IMU 文件路径非法") from e
    except ImuReadError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    csv_start = _parse_ts(meta.get("start_timestamp"))
    if csv_start is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "IMU CSV 没有可用的时间戳列，无法换算 AI 片段时间")

    try:
        result = await algo_client.infer(sample.imu_csv_path, sample_id=sample.id)
    except algo_client.AlgoServiceError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e

    ai_label_relpath = os.path.splitext(sample.imu_csv_path)[0] + "_ai_label.json"
    full_path = os.path.join(settings.nas_root, ai_label_relpath)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    sample.ai_label_path = ai_label_relpath
    await db.commit()

    items, skipped = _flatten_segments(result.get("segments") or {}, csv_start)
    return ok(
        PrelabelResult(
            sample_id=sample.id,
            ai_label_path=ai_label_relpath,
            items=items,
            n_windows=int(result.get("n_windows") or 0),
            skipped=skipped,
        ).model_dump()
    )


_TS_FORMATS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S")


def _parse_ts(value: object) -> datetime | None:
    """
    解析 AI 服务/IMU meta 里的时间字符串。imu_train 用 strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    输出（毫秒精度），get_meta 给的是 isoformat。两边都是从同一个 CSV 的时间戳列来的，
    统一按 naive 时间比较；带时区的先把时区剥掉，避免 aware/naive 相减报错。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        dt = None
        for fmt in _TS_FORMATS:
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
    if dt is None:
        return None
    return dt.replace(tzinfo=None)


def _flatten_segments(segments: dict, csv_start: datetime) -> tuple[list[PrelabelItem], int]:
    """
    {类别: [{start_ts, end_ts, conf_max, ...}]} -> 按开始时间排好序的扁平列表，时间换成
    相对 CSV 起点的毫秒。时间戳缺失或换算后时长非正的片段跳过，只计数返回给前端提示。
    """
    items: list[PrelabelItem] = []
    skipped = 0
    for label_name, segs in segments.items():
        for seg in segs or []:
            start = _parse_ts(seg.get("start_ts"))
            end = _parse_ts(seg.get("end_ts"))
            if start is None or end is None:
                skipped += 1
                continue
            start_ms = int(round((start - csv_start).total_seconds() * 1000))
            end_ms = int(round((end - csv_start).total_seconds() * 1000))
            if end_ms <= start_ms or end_ms <= 0:
                skipped += 1
                continue
            conf = seg.get("conf_max")
            if conf is None:
                conf = seg.get("conf_mean")
            items.append(
                PrelabelItem(
                    label_name=str(label_name),
                    start_time_ms=max(0, start_ms),
                    end_time_ms=end_ms,
                    confidence=float(conf) if conf is not None else 0.0,
                )
            )
    items.sort(key=lambda it: (it.start_time_ms, it.end_time_ms))
    return items, skipped


@router.post("/import-scan")
async def import_scan(admin: User = Depends(get_current_user)):
    """立即后台开始一次扫描，不阻塞请求。已有扫描在跑时不会重复启动。"""
    started = await start_scan_background(settings.nas_root, admin.id)
    return ok(ScanStartResult(already_running=not started).model_dump())


@router.get("/import-scan/status")
async def import_scan_status():
    """前端轮询这个接口显示进度条。"""
    p = get_progress()
    return ok(
        ScanProgressOut(
            status=p.status,
            total_groups=p.total_groups,
            processed=p.processed,
            created=p.created,
            skipped_existing=p.skipped_existing,
            verified=p.verified,
            errors=p.errors,
            detail=p.detail,
            error_message=p.error_message,
            elapsed_sec=p.elapsed_sec,
            estimated_remaining_sec=p.estimated_remaining_sec,
        ).model_dump()
    )
