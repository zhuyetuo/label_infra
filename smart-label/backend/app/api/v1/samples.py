"""
样本导入/查询（admin）。扫描 NAS data_raw/ 目录，按会话分组2或3路视频+IMU CSV写入 samples 表。
调度器（app/workers/scheduler.py）每10分钟自动扫一次一次新数据，这里的手动触发只是
"不想等，立刻扫一次"的快捷方式，不是唯一入口。
"""

import asyncio
import json
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.dog import Dog
from app.models.clip import ClipJob
from app.models.inference_run import SampleInferenceRun
from app.models.media_file import MediaFile
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.model_version import PrelabelResult
from app.schemas.sample import (
    SampleDeleteBulk,
    SampleDogBulk,
    SampleMediaOut,
    SampleOut,
    SampleSensitiveBulk,
    SampleUpdate,
    ScanProgressOut,
    ScanStartResult,
)
from app.services.ai_prelabel_service import PrelabelError, ai_label_relpath, infer_sample, replace_candidates
from app.services import sample_health_service as health
from app.services.sample_delete_service import delete_samples
from app.services.sample_import_service import MISSING_FILES_PREFIX, get_progress, start_scan_background
from app.services.task_service import purge_task_children
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


@router.patch("/dog")
async def set_dog_bulk(body: SampleDogBulk, db: AsyncSession = Depends(get_db)):
    """
    一批样本一起关联到同一只狗（dog_id 传 null = 解除关联）。

    一天一个机位就有 30 份样本（每小时一段），而同一天同一个机位戴在哪只狗身上
    是固定的——挨个下拉去选 30 次纯属白费功夫。

    这条路由必须写在 PATCH /{sample_id} 前面：FastAPI 按声明顺序匹配，写在后面
    的话 "dog" 会先撞上 /{sample_id}，报的是 int 解析失败的 422，看着完全不像
    路由撞了。
    """
    if not body.sample_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选中任何样本")
    if body.dog_id is not None and await db.get(Dog, body.dog_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "狗不存在")
    result = await db.execute(
        update(Sample).where(Sample.id.in_(body.sample_ids)).values(dog_id=body.dog_id)
    )
    await db.commit()
    return ok({"updated": result.rowcount or 0})


@router.post("/batch-delete")
async def delete_samples_bulk(body: SampleDeleteBulk, db: AsyncSession = Depends(get_db)):
    """
    删一批样本，连同它们上面的任务和任务下面的东西。

    NAS 上的文件一个都不动——删的只是数据库里的登记。主要用来清掉空 CSV 的样本
    （文件建出来了但一行数据都没写），这些样本打开就报错，也算不出任何指标。

    media_files 里那几条路径登记也一起删掉：它是按路径唯一的，留着的话既是孤儿，
    又会让「这个文件还在系统里」这件事看起来是真的。
    """
    if not body.sample_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选中任何样本")
    samples = (await db.execute(select(Sample).where(Sample.id.in_(body.sample_ids)))).scalars().all()
    result = await delete_samples(db, samples)
    await db.commit()
    return ok(result)


@router.get("/imu-health")
async def imu_health(
    limit: int = Query(400, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
):
    """体检：哪些样本的 IMU 数据其实用不了。

    起因是一段真实素材——文件名是配对好的（cam1 配 imu1）、画面正常、能预览、
    能建任务，但视频里烧着的 overlay 从头到尾写着 `[Bibi] MISSING`：它配对的
    那路 IMU 整段没连上。这种样本在库里跟正常的长得一模一样，人翻不出来，
    只有等标注员标到一半发现波形是平的，或者更糟——训练集里混进一批没有标签
    依据的片段。

    只读，不写库、不删文件。判据是 CSV 行数 ÷（视频时长 × 采样率）：把"有文件"
    和"有数据"区分开。这类判断错一次的代价（误删一天的数据）比漏一次高得多，
    所以只列出来给人看。
    """
    rows = (
        await db.execute(
            select(Sample)
            .where(Sample.imu_csv_path.isnot(None))
            .order_by(Sample.session_date.desc(), Sample.sample_code)
            .limit(limit)
        )
    ).scalars().all()

    nas_root = settings.nas_root
    # 逐条读 CSV 是阻塞 IO，几百条就够把事件循环卡住十几秒——扔线程里
    def _scan():
        out = []
        for s in rows:
            r = health.check_one(nas_root, s.imu_csv_path, s.video_duration_sec, s.sample_hz,
                                 declared_hz=s.imu_sample_rate_hz)
            out.append((s, r))
        return out

    checked = await asyncio.to_thread(_scan)
    summary: dict[str, int] = {}
    items = []
    for s, r in checked:
        summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1
        if r["verdict"] in health.NEEDS_ATTENTION:
            items.append({
                "id": s.id, "sample_code": s.sample_code, "session_date": str(s.session_date or ""),
                "dog_id": s.dog_id, "imu_csv_path": s.imu_csv_path,
                "duration_sec": s.video_duration_sec, **r,
            })
    return ok({"checked": len(checked), "summary": summary, "items": items})


@router.get("/missing-files")
async def list_missing_file_samples(db: AsyncSession = Depends(get_db)):
    """
    列出「NAS 上文件已经没了」的样本：当天重录过、或者手工删过原始数据，样本行
    还留在库里，点预览就是 No such file or directory。

    判断由扫描那边做（import_error 打了固定前缀），这里只负责读出来给界面用，
    顺带数一下每个样本上还挂着几个任务——有任务的删掉会连标注一起没，得让人
    看见再决定。
    """
    rows = (
        await db.execute(
            select(Sample)
            .where(Sample.import_error.like(f"{MISSING_FILES_PREFIX}%"))
            .order_by(Sample.session_date.desc(), Sample.sample_code)
        )
    ).scalars().all()
    ids = [s.id for s in rows]
    task_count: dict[int, int] = {}
    if ids:
        for sid in (await db.execute(select(Task.sample_id).where(Task.sample_id.in_(ids)))).scalars():
            task_count[sid] = task_count.get(sid, 0) + 1
    return ok(
        {
            "total": len(rows),
            "with_tasks": sum(1 for s in rows if task_count.get(s.id)),
            "items": [
                {
                    "id": s.id,
                    "sample_code": s.sample_code,
                    "session_date": s.session_date.isoformat() if s.session_date else None,
                    "task_count": task_count.get(s.id, 0),
                    "import_error": s.import_error,
                }
                for s in rows
            ],
        }
    )


@router.post("/missing-files/cleanup")
async def cleanup_missing_file_samples(db: AsyncSession = Depends(get_db)):
    """
    把上面那批删掉。NAS 上的文件一个都不动——本来也已经不在了。

    只删扫描标记过的那些，而标记的前提是「这个样本所在的日期目录还在，只是它
    自己的文件没了」。整个目录都读不到（NAS 没挂上、网线掉了）的一律不标记，
    所以不会因为一次挂载抖动就把一天的数据从库里抹掉。
    """
    samples = (
        await db.execute(select(Sample).where(Sample.import_error.like(f"{MISSING_FILES_PREFIX}%")))
    ).scalars().all()
    result = await delete_samples(db, samples)
    await db.commit()
    return ok(result)


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

    cam_paths = [sample.video_cam1_path, sample.video_cam2_path, sample.video_cam3_path]
    return ok(
        SampleMediaOut(
            video1_id=by_path.get(sample.video_cam1_path),
            video2_id=by_path.get(sample.video_cam2_path),
            video3_id=by_path.get(sample.video_cam3_path),
            csv_id=by_path.get(sample.imu_csv_path),
            video_fps=sample.video_fps,
            video_paths=cam_paths,
            # 样本上登记了路径、媒体库里却没有这条：文件没传上 NAS，或者传了还没扫到
            video_missing_in_library=[p for p in cam_paths if p and p not in by_path],
        ).model_dump()
    )


@scoped_router.get("/{sample_id}/ai-label-info")
async def ai_label_info(sample_id: int, db: AsyncSession = Depends(get_db)):
    """
    这个样本现在的 AI 结果是哪个版本、哪个模型跑的、什么时候跑的。

    工作台上「AI 预标注」旁边要显示这个：项目页批量跑过之后，标注员看到的片段
    到底出自哪个模型并不明显，换了模型重跑更是完全看不出来。信息就在 NAS 上那份
    结果 JSON 里（mode / model_path），顺带用文件修改时间当"什么时候跑的"。
    """
    sample = await db.get(Sample, sample_id)
    if sample is None or not sample.imu_csv_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在或没有 IMU CSV")
    relpath = ai_label_relpath(sample.imu_csv_path)
    full = os.path.join(settings.nas_root, relpath)

    def _read() -> dict:
        if not os.path.isfile(full):
            return {"exists": False}
        try:
            with open(full, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {"exists": False}
        return {
            "exists": True,
            "mode": data.get("mode"),
            "model_path": data.get("model_path"),
            "n_windows": data.get("n_windows"),
            "missing_seconds": data.get("missing_seconds"),
            "generated_at": datetime.fromtimestamp(os.path.getmtime(full)).strftime("%Y-%m-%d %H:%M:%S"),
        }

    return ok(await asyncio.to_thread(_read))


@scoped_router.post("/{sample_id}/ai-prelabel")
async def ai_prelabel(
    sample_id: int,
    mode: str | None = None,
    task_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
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

    # 同步推理要等几十秒，等的时候先把数据库连接还回池子里（下面用到 db 时会自己
    # 重新拿），否则几个人同时点「AI预标注」就能把连接池占满
    await db.close()
    # 推理 + 时间换算 + 原始 JSON 落盘都在 ai_prelabel_service 里，跟项目批量预标注共用
    try:
        inf = await infer_sample(sample, mode=mode)
    except PrelabelError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e

    sample.ai_label_path = inf.ai_label_path
    # 带了 task_id（工作台里点的）就把疑似抓挠候选一并存下来，人工在片段面板下面
    # 那个「疑似抓挠」列表里逐条确认/排除
    if task_id is not None:
        task = (
            await db.execute(apply_task_scope(select(Task).where(Task.id == task_id), user).limit(1))
        ).scalar_one_or_none()
        if task is not None and task.sample_id == sample.id:
            await replace_candidates(db, task, inf.candidates)
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
