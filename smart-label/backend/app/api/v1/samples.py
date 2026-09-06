"""
样本导入/查询（admin）。扫描 NAS data_raw/ 目录，按会话分组2或3路视频+IMU CSV写入 samples 表。
调度器（app/workers/scheduler.py）每10分钟自动扫一次一次新数据，这里的手动触发只是
"不想等，立刻扫一次"的快捷方式，不是唯一入口。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
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
from app.schemas.model_version import PrelabelResult
from app.schemas.sample import (
    SampleMediaOut,
    SampleOut,
    SampleSensitiveBulk,
    SampleUpdate,
    ScanProgressOut,
    ScanStartResult,
)
from app.services.ai_prelabel_service import PrelabelError, infer_sample
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


@router.patch("/sensitive")
async def set_sensitive_bulk(body: SampleSensitiveBulk, db: AsyncSession = Depends(get_db)):
    """
    一批样本一起标记/解除"含敏感隐私信息"。标了之后标注员/审核员在任何地方都
    看不到这些样本和它们上面的任务（列表、认领、视频、IMU 全挡），只有管理员能看能标。
    """
    if not body.sample_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选中任何样本")
    values: dict = {"is_sensitive": body.is_sensitive}
    if body.is_sensitive:
        values["sensitive_note"] = body.sensitive_note
    else:
        values["sensitive_note"] = None
    result = await db.execute(update(Sample).where(Sample.id.in_(body.sample_ids)).values(**values))
    await db.commit()
    return ok({"updated": result.rowcount or 0})


@router.patch("/{sample_id}")
async def update_sample(sample_id: int, body: SampleUpdate, db: AsyncSession = Depends(get_db)):
    """手动关联到哪只狗；单个样本标记/解除敏感。"""
    sample = await db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")
    updates = body.model_dump(exclude_unset=True)
    if "dog_id" in updates and updates["dog_id"] is not None:
        dog = await db.get(Dog, updates["dog_id"])
        if dog is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "狗不存在")
    if updates.get("is_sensitive") is False:
        updates["sensitive_note"] = None
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

    # 推理 + 时间换算 + 原始 JSON 落盘都在 ai_prelabel_service 里，跟项目批量预标注共用
    try:
        inf = await infer_sample(sample)
    except PrelabelError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e

    sample.ai_label_path = inf.ai_label_path
    await db.commit()

    return ok(
        PrelabelResult(
            sample_id=sample.id,
            ai_label_path=inf.ai_label_path,
            items=inf.items,
            n_windows=inf.n_windows,
            skipped=inf.skipped,
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
