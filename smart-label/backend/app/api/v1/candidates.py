"""
疑似抓挠候选：AI 预标注（稳定版/v2）为了准会滤掉一部分真抓挠，label_service 用低门槛
再抽一遍（模型低置信 / 频谱像抓挠但没判）返回 candidates，存在 ai_candidates 里。

候选不进任务草稿——标注员在工作台里看「疑似抓挠」列表，跳过去看两秒视频，确认就变成
一条正式的人工片段（写进当前轮草稿），排除就记一笔。两种决定都是重训模型时最有价值的
数据：确认 = 模型漏检的正样本，排除 = 误报的负样本。
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import vision_index_service as vindex
from app.services import vision_sam_client
from app.services.grooming_labels import alias_names
from app.services.task_scope import apply_task_scope

router = APIRouter(prefix="/candidates", tags=["candidates"])


def _out(c: AiCandidate) -> dict:
    return {
        "id": c.id, "task_id": c.task_id, "round_no": c.round_no, "label_name": c.label_name,
        "start_time_ms": c.start_time_ms, "end_time_ms": c.end_time_ms,
        "confidence": c.confidence, "spec": c.spec, "reason": c.reason, "model": c.model,
        "status": c.status.value, "decided_by": c.decided_by,
        # 确认成了哪个类别（空 = 就是抓挠）：列表里要显示「已确认 → 甩身体」
        "decided_label_id": c.decided_label_id,
        "uncertain_reason": c.uncertain_reason,
        "decided_at": c.decided_at.isoformat() if c.decided_at else None,
    }


async def _visible_task(db: AsyncSession, task_id: int, user: User) -> Task:
    task = (
        await db.execute(apply_task_scope(select(Task).where(Task.id == task_id), user).limit(1))
    ).scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")
    return task


@router.get("")
async def list_candidates(
    task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    """某个任务当前轮的候选，可疑程度高的排前面（频谱来源优先，再按置信度倒序）。"""
    task = await _visible_task(db, task_id, user)
    rows = (
        await db.execute(
            select(AiCandidate)
            .where(AiCandidate.task_id == task.id, AiCandidate.round_no == task.round_no)
            .order_by(AiCandidate.start_time_ms)
        )
    ).scalars().all()
    return ok([_out(c) for c in rows])


@router.delete("/similar")
async def clear_similar(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """把这个任务当前轮里**还没判过的**「画面相似」候选全删掉。

    找相似常常只是试一下参数，找错了一堆没必要一条条排除；已经确认 / 排除 / 待定的
    是人的判断，不动。返回删了几条。
    """
    task = await _visible_task(db, task_id, user)
    rows = (await db.execute(
        select(AiCandidate).where(AiCandidate.task_id == task.id, AiCandidate.round_no == task.round_no,
                                  AiCandidate.reason == "similar", AiCandidate.status == CandidateStatus.pending)
    )).scalars().all()
    for r in rows:
        await db.delete(r)
    await db.commit()
    return ok({"deleted": len(rows)})


class DecideIn(BaseModel):
    decision: str  # confirmed / rejected / uncertain / pending
    label_id: int | None = None  # 确认时写进草稿用哪个标签，留空按 label_name 找
    uncertain_reason: str | None = None  # 待定时是哪一种：no_view / ambiguous / needs_split


@router.post("/repair-items")
async def repair_items(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """
    补回"确认过、但草稿里没有对应片段"的候选。

    为什么会缺：确认/改类别是这里直接往草稿里写一条，而工作台那边紧接着又用它
    本地那份列表（还不知道刚写的这条）存了一次草稿——存草稿是 replace-in-place，
    不在列表里的条目会被删掉，于是刚建的片段立刻就没了。前端的顺序已经改过来了，
    这里负责把之前丢掉的补回来。

    候选行上信息是全的（时间、确认成了哪个类别、置信度），重建是确定的；
    已经有对应片段的不重复建，可以反复调。
    """
    task = await _visible_task(db, task_id, user)
    cands = (
        await db.execute(
            select(AiCandidate).where(
                AiCandidate.task_id == task_id,
                AiCandidate.round_no == task.round_no,
                AiCandidate.status == CandidateStatus.confirmed,
            )
        )
    ).scalars().all()
    if not cands:
        return ok({"repaired": 0})

    record = (
        await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task_id, AnnotationRecord.round_no == task.round_no
            )
        )
    ).scalar_one_or_none()
    if record is None:
        record = AnnotationRecord(task_id=task_id, round_no=task.round_no, source_type=RecordSourceType.ai_revised)
        db.add(record)
        await db.flush()

    have = set(
        (
            await db.execute(
                select(AnnotationLabelItem.from_candidate_id).where(
                    AnnotationLabelItem.annotation_record_id == record.id,
                    AnnotationLabelItem.from_candidate_id.isnot(None),
                )
            )
        ).scalars()
    )
    n = 0
    for c in cands:
        if c.id in have:
            continue
        label_id = c.decided_label_id
        if label_id is None:
            label_id = (
                await db.execute(
                    select(LabelDefinition.id).where(
                        LabelDefinition.project_id == task.project_id,
                        (LabelDefinition.display_name.in_(alias_names(c.label_name))) | (LabelDefinition.code == c.label_name),
                    ).limit(1)
                )
            ).scalar_one_or_none()
        if label_id is None:
            continue
        db.add(
            AnnotationLabelItem(
                annotation_record_id=record.id,
                label_id=label_id,
                start_time_ms=c.start_time_ms,
                end_time_ms=c.end_time_ms,
                source_type=LabelItemSource.human_added,
                is_modified=False,
                ai_confidence=c.confidence,
                ai_confirmed=False,
                from_candidate_id=c.id,
                created_by=c.decided_by or user.id,
            )
        )
        n += 1
    if n:
        await db.commit()
    return ok({"repaired": n})


@router.post("/{candidate_id}/decide")
async def decide(
    candidate_id: int,
    body: DecideIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.decision not in ("confirmed", "rejected", "uncertain", "pending"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "decision 只能是 confirmed/rejected/uncertain/pending"
        )
    cand = await db.get(AiCandidate, candidate_id)
    if cand is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "候选不存在")
    task = await _visible_task(db, cand.task_id, user)

    if body.decision == "confirmed":
        label_id = body.label_id
        if label_id is None:
            label_id = (
                await db.execute(
                    select(LabelDefinition.id).where(
                        LabelDefinition.project_id == task.project_id,
                        (LabelDefinition.display_name.in_(alias_names(cand.label_name))) | (LabelDefinition.code == cand.label_name),
                    ).limit(1)
                )
            ).scalar_one_or_none()
        if label_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"项目里没有「{cand.label_name}」标签，先去标签管理里加")
        record = (
            await db.execute(
                select(AnnotationRecord).where(
                    AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no
                )
            )
        ).scalar_one_or_none()
        if record is None:
            record = AnnotationRecord(task_id=task.id, round_no=task.round_no, source_type=RecordSourceType.ai_revised)
            db.add(record)
            await db.flush()
        # 同类别已经有一条压在这段时间上，就把它撑开，别再加一条。
        #
        # 「疑似抓挠」候选常常跟 AI 已经出的抓挠片段指向同一次动作——确认一下就
        # 多出一条一模一样的，两条都留着的后果不是"多一行"：这些片段是原样送去
        # 算「今天抓了几次、共多久」的，同一次抓挠被算成两次，C 值跟着虚高。
        # 皮肤评估是拿来判断要不要干预的，数字虚高比没有数字更糟。
        #
        # 只在**真正重叠**时并（严格 < ，不含紧挨着的）：22:00:05 结束、
        # 22:00:05 开始的两条很可能就是分开的两次，并了反而少算。
        dup = (
            await db.execute(
                select(AnnotationLabelItem).where(
                    AnnotationLabelItem.annotation_record_id == record.id,
                    AnnotationLabelItem.label_id == label_id,
                    AnnotationLabelItem.start_time_ms < cand.end_time_ms,
                    AnnotationLabelItem.end_time_ms > cand.start_time_ms,
                )
            )
        ).scalars().first()
        if dup is not None:
            dup.start_time_ms = min(dup.start_time_ms, cand.start_time_ms)
            dup.end_time_ms = max(dup.end_time_ms, cand.end_time_ms)
            # 记上出处：点错了还能退回候选重新判断，跟新建那条一个待遇
            if dup.from_candidate_id is None:
                dup.from_candidate_id = cand.id
            # 人特意从候选里确认出来的，算人碰过——否则它还挂着"没人看过的AI片段"，
            # 按片段取的导出会把它跳过，等于白确认一场
            dup.ai_confirmed = True
            cand.status = CandidateStatus(body.decision)
            cand.decided_label_id = label_id
            cand.uncertain_reason = None
            cand.decided_by = user.id
            cand.decided_at = datetime.now(UTC).replace(tzinfo=None)
            await db.commit()
            await db.refresh(cand)
            return ok(_out(cand))

        db.add(
            AnnotationLabelItem(
                annotation_record_id=record.id,
                label_id=label_id,
                start_time_ms=cand.start_time_ms,
                end_time_ms=cand.end_time_ms,
                # 人工从候选里确认出来的 = 模型漏检、人补上的，算人工片段
                source_type=LabelItemSource.human_added,
                is_modified=False,
                ai_confidence=cand.confidence,
                ai_confirmed=False,
                # 记住出处，回头点错了能退回候选重新判断
                from_candidate_id=cand.id,
                created_by=user.id,
            )
        )

    cand.status = CandidateStatus(body.decision)
    # 记下确认成了哪个类别：抓挠以外的说明是"人纠正过的误报"，统计里要分开看
    cand.decided_label_id = label_id if body.decision == "confirmed" else None
    # 待定原因；不是待定就清掉，别留个孤零零的原因在库里
    cand.uncertain_reason = body.uncertain_reason if body.decision == "uncertain" else None
    cand.decided_by = user.id if body.decision != "pending" else None
    cand.decided_at = datetime.now(UTC).replace(tzinfo=None) if body.decision != "pending" else None
    await db.commit()
    await db.refresh(cand)
    return ok(_out(cand))


class SimilarIn(BaseModel):
    """以图搜图 / 一句话搜 → 候选。t_s 和 text 二选一。"""
    task_id: int
    label_name: str
    cam: str = "cam1"
    t_s: float | None = None
    text: str | None = None
    scope: str = "project"     # project / task / all（所有项目）
    top_k: int = 60
    min_score: float = 0.0
    # 相邻命中隔多久以内算同一段（秒）。小了一次舔拆成十几条，大了两次不同的舔并成一条
    gap_s: float = 15.0
    # 标签项目里还没有：管理员可以顺手建（找相似的时候常常就是在攒一个新类别）
    create_label: bool = False
    # 减掉所有帧的平均向量再比（去共同背景）。默认开
    center: bool = True
    # 姿态相似占多少（0~1）；不传用视觉服务默认。没姿态模型时自动只看画面
    pose_w: float | None = None
    # 只搜不写：先把命中摆出来看
    dry_run: bool = False


@router.post("/similar")
async def find_similar(body: SimilarIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """在工作台里看到一帧（比如舔尾巴），把项目里长得像的几秒全挑出来当候选。

    靠的是画面向量索引（项目页「建画面索引」先建好），不问大模型、不花钱。
    候选 reason=similar，标签是这里选的；跟已有同标签重叠的不重复写。
    """
    task = await _visible_task(db, body.task_id, user)
    if body.cam not in ("cam1", "cam2", "cam3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cam 只能是 cam1 / cam2 / cam3")
    if body.scope not in ("project", "task", "all"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "scope 只能是 project / task / all")
    if not (1 <= body.top_k <= 2000):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "top_k 要在 1~2000")
    label = (await db.execute(select(LabelDefinition.id).where(
        LabelDefinition.project_id == task.project_id, LabelDefinition.display_name == body.label_name,
        LabelDefinition.is_active.is_(True)).limit(1))).scalar_one_or_none()
    created_label = False
    if label is None and body.dry_run:
        pass    # 只看不写，标签有没有无所谓
    elif label is None:
        name = body.label_name.strip()
        if not body.create_label or user.role not in (UserRole.admin, UserRole.super_admin) or not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"项目里没有「{body.label_name}」标签（管理员可以在弹窗里勾「没有就新建」）")
        if len(name) > 50:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "标签名最长 50 字")
        # code 用名字本身：项目内唯一即可，跟标签管理页手工建的一样
        exists = (await db.execute(select(LabelDefinition.id).where(
            LabelDefinition.project_id == task.project_id, LabelDefinition.code == name).limit(1))).scalar_one_or_none()
        if exists is not None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"项目里已有 code 为「{name}」的标签（可能被停用了），去标签管理里看看")
        db.add(LabelDefinition(project_id=task.project_id, code=name, display_name=name, sort_order=200, created_by=user.id))
        await db.commit()
        created_label = True
    params = vindex.SimilarParams(label_name=body.label_name, cam=body.cam, t_s=body.t_s, text=body.text,
                                  scope=body.scope, top_k=body.top_k, min_score=body.min_score,
                                  gap_s=max(0.0, min(120.0, body.gap_s)), center=body.center, dry_run=body.dry_run,
                                  pose_w=(max(0.0, min(1.0, body.pose_w)) if body.pose_w is not None else None))
    try:
        r = await vindex.find_similar(db, task, params)
        r["created_label"] = created_label
        return ok(r)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e


class SimilarPreviewIn(BaseModel):
    task_id: int
    cam: str = "cam1"
    t_s: float


@router.post("/similar/preview")
async def similar_preview(body: SimilarPreviewIn, db: AsyncSession = Depends(get_db),
                          user: User = Depends(get_current_user)):
    """找相似之前看一眼样例：这一帧框到了哪几只狗、拿哪一块去搜。

    以图搜图是"先框狗、再拿框里那块算向量"，框错了（没框到、框到别的东西）搜出来
    全是错的；这里把框画给人看，不对就换一帧。
    """
    task = await _visible_task(db, body.task_id, user)
    if body.cam not in ("cam1", "cam2", "cam3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cam 只能是 cam1 / cam2 / cam3")
    sample = await db.get(Sample, task.sample_id)
    path = vindex.video_path_of(sample, body.cam) if sample else None
    if not path:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"这个任务的样本没有 {body.cam} 视频")
    try:
        return ok(await vision_sam_client.embed_preview(path, max(0.0, body.t_s)))
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e


@router.post("/similar/thumb-token")
async def similar_thumb_token(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """<img> 带不了 Authorization 头：换一个短期 token 拼进缩略图地址里（跟视频流一个办法）。"""
    from app.core.media_token import issue_media_token

    task = await _visible_task(db, task_id, user)
    return ok({"token": issue_media_token(task.id)})


@router.get("/similar/thumb")
async def similar_thumb(task_id: int, path: str, t: float, token: str, crop: bool = True,
                        db: AsyncSession = Depends(get_db)):
    """命中那一帧的缩略图（狗框那一块）。path 必须是这个任务所在项目里某份样本的视频。"""
    from fastapi.responses import Response

    from app.core.media_token import verify_media_token

    if not verify_media_token(task_id, token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "缩略图 token 无效或过期")
    task = await db.get(Task, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    # 找相似可以跨项目：path 是库里任何一份样本登记的视频就行（不能是任意文件路径）
    known = (await db.execute(select(Sample.id).where(
        (Sample.video_cam1_path == path) | (Sample.video_cam2_path == path) | (Sample.video_cam3_path == path)
    ).limit(1))).scalar_one_or_none()
    if known is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这个视频不是库里登记的样本视频")
    try:
        data = await vision_sam_client.embed_thumb(path, max(0.0, t), crop=crop)
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
