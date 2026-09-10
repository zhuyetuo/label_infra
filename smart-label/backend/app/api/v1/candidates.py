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
from app.models.task import Task
from app.models.user import User
from app.schemas.envelope import ok
from app.services.task_scope import apply_task_scope

router = APIRouter(prefix="/candidates", tags=["candidates"])


def _out(c: AiCandidate) -> dict:
    return {
        "id": c.id, "task_id": c.task_id, "round_no": c.round_no, "label_name": c.label_name,
        "start_time_ms": c.start_time_ms, "end_time_ms": c.end_time_ms,
        "confidence": c.confidence, "spec": c.spec, "reason": c.reason,
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
                        (LabelDefinition.display_name == c.label_name) | (LabelDefinition.code == c.label_name),
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
                        (LabelDefinition.display_name == cand.label_name) | (LabelDefinition.code == cand.label_name),
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
