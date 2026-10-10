import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.review import ReviewDecision, ReviewRecord
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.services.task_scope import exclude_own_annotation, exclude_sensitive


class ReviewConflictError(Exception):
    pass


async def claim_review(db: AsyncSession, task_id: int, reviewer: User) -> Task:
    """原子认领待审核任务，语义同 task_service.claim_task。"""
    lock_expires = datetime.now(UTC) + timedelta(hours=settings.review_timeout_hours)
    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.status == TaskStatus.SUBMITTED,
            (Task.reviewer_id.is_(None)) | (Task.reviewer_id == reviewer.id),
        )
        .values(reviewer_id=reviewer.id, locked_by=reviewer.id, lock_expires_at=lock_expires)
    )
    # 敏感样本上的任务只有管理员能审；审核员自己标的任务不能自己审
    stmt = exclude_sensitive(stmt, reviewer)
    stmt = exclude_own_annotation(stmt, reviewer)
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise ReviewConflictError("任务已被其他审核员认领或不处于待审核状态")
    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def release_review(db: AsyncSession, task_id: int, reviewer: User) -> Task:
    """审核员主动放弃认领：任务还是 SUBMITTED，退回待审核队列给别人接手。"""
    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.reviewer_id == reviewer.id, Task.status == TaskStatus.SUBMITTED)
        .values(reviewer_id=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise ReviewConflictError("任务不在你名下或已不是待审核状态，无法放弃")
    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def _clone_record_forward(db: AsyncSession, task: Task, new_round_no: int) -> None:
    """驳回重标：把当前轮次的标注内容拷贝到新一轮，标注员重新认领后能接着改，不用从空白开始（决策⑧）。"""
    old_record = (
        await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no
            )
        )
    ).scalar_one_or_none()
    if old_record is None:
        return

    new_record = AnnotationRecord(task_id=task.id, round_no=new_round_no, source_type=old_record.source_type)
    db.add(new_record)
    await db.flush()

    old_items = (
        (await db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == old_record.id)))
        .scalars()
        .all()
    )
    for item in old_items:
        db.add(
            AnnotationLabelItem(
                annotation_record_id=new_record.id,
                label_id=item.label_id,
                start_time_ms=item.start_time_ms,
                end_time_ms=item.end_time_ms,
                source_type=item.source_type,
                is_modified=item.is_modified,
                ai_confidence=item.ai_confidence,
                ai_confirmed=item.ai_confirmed,
                uncertain=item.uncertain,
                uncertain_reason=item.uncertain_reason,
                created_by=item.created_by,
            )
        )


async def reopen_task(db: AsyncSession, task_id: int, operator: User, comment: str | None) -> Task:
    """
    把已通过（或已驳回待重标）的任务退回重标：当时审通过了，后来复查发现问题，
    需要能打回去重新标，而不是只能删掉重建（那样会丢掉历史轮次）。

    处理方式跟驳回一致：轮次+1、把上一轮内容拷到新一轮、回到待分配。
    不写 review_records —— (task_id, round_no) 上有唯一约束，那一轮的审核结论
    确实就是"通过"，历史不该被改写；退回这个动作记到 audit_logs 里。

    权限：管理员/超级管理员/审核员随时能退，另外——如果这条正是自己被驳回的，
    标注员本人也能自己点，不用等审核员或管理员回头操作（人少的时候经常是
    自己一路标到审，被自己驳回了还得等自己去后台点一下，纯属多余）。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise ReviewConflictError("任务不存在")
    if task.status not in (TaskStatus.APPROVED, TaskStatus.REJECTED):
        raise ReviewConflictError("只有已通过/已驳回的任务才能退回重标")
    is_privileged = operator.role in (UserRole.admin, UserRole.super_admin, UserRole.reviewer)
    is_own_rejected = task.status == TaskStatus.REJECTED and task.assigned_to == operator.id
    if not is_privileged and not is_own_rejected:
        raise ReviewConflictError("没有权限退回这个任务")

    new_round_no = task.round_no + 1
    await _clone_record_forward(db, task, new_round_no)
    task.round_no = new_round_no
    task.status = TaskStatus.PENDING_ASSIGN
    task.assigned_to = None
    task.reviewer_id = None
    task.locked_by = None
    task.lock_expires_at = None

    db.add(
        AuditLog(
            user_id=operator.id,
            action="task.reopen",
            target_type="task",
            target_id=task.id,
            detail=json.dumps({"new_round_no": new_round_no, "comment": comment}, ensure_ascii=False),
        )
    )

    await db.commit()
    await db.refresh(task)
    return task


async def decide_review(
    db: AsyncSession, task_id: int, reviewer: User, decision: ReviewDecision, comment: str | None
) -> Task:
    task = await db.get(Task, task_id)
    if task is None:
        raise ReviewConflictError("任务不存在")
    if task.locked_by != reviewer.id or task.status != TaskStatus.SUBMITTED:
        raise ReviewConflictError("任务不在你名下或已不在待审核状态")

    db.add(
        ReviewRecord(
            task_id=task.id,
            round_no=task.round_no,
            reviewer_id=reviewer.id,
            decision=decision,
            comment=comment,
        )
    )

    if decision == ReviewDecision.approved:
        task.status = TaskStatus.APPROVED
        task.locked_by = None
        task.lock_expires_at = None
    else:
        # 驳回先停在 REJECTED 这个状态上（不是马上转回待分配）：之前的写法是驳回
        # 立刻 round+1 打回待分配，任务在列表里一晃就变回"待认领"，标注员根本
        # 看不出这条被驳回过、也看不到审核意见。assigned_to/reviewer_id 都不清，
        # 原来的标注员和审核员是谁一目了然，"只看指派给我的"筛选也还能看到它。
        # 真正的 round+1/清空指派要等标注员自己点"退回重标"开始改的时候才发生
        # （见 reopen_task），审核意见就留在这一轮的 review_records 里。
        task.status = TaskStatus.REJECTED
        task.locked_by = None
        task.lock_expires_at = None

    await db.commit()
    await db.refresh(task)
    return task


async def _unfinished_tasks(db: AsyncSession, task_ids: list[int]) -> tuple[set[int], set[int]]:
    """这些任务里：还有 AI 片段没人确认 / 改过的（不含待定）、还有疑似片段没判的。各返回一组任务 id。"""
    from app.models.ai_candidate import AiCandidate, CandidateStatus
    from app.models.annotation import LabelItemSource

    if not task_ids:
        return set(), set()
    unconfirmed = set((await db.execute(
        select(AnnotationRecord.task_id)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(task_ids), AnnotationRecord.round_no == Task.round_no,
               AnnotationLabelItem.source_type == LabelItemSource.ai_generated,
               AnnotationLabelItem.ai_confirmed.is_(False), AnnotationLabelItem.is_modified.is_(False),
               AnnotationLabelItem.uncertain.is_(False))
        .group_by(AnnotationRecord.task_id))).scalars().all())
    cand_pending = set((await db.execute(
        select(AiCandidate.task_id).join(Task, Task.id == AiCandidate.task_id)
        .where(AiCandidate.task_id.in_(task_ids), AiCandidate.round_no == Task.round_no,
               AiCandidate.status == CandidateStatus.pending)
        .group_by(AiCandidate.task_id))).scalars().all())
    return unconfirmed, cand_pending


async def bulk_approve(db: AsyncSession, operator: User, project_id: int | None = None) -> dict:
    """超级管理员一键通过：已提交（SUBMITTED）、而且**人都确认完了**的任务全部通过，可以只限一个项目。

    只通过"人看完了"的任务：里面每一段 AI 片段都被人确认 / 改过（或标了待定），疑似片段也都判了。
    还有 AI 片段没人确认的、疑似没判完的跳过——一键通过的本意是省掉审核这一步，不是把没人看过的
    AI 输出当成真值放进训练集。还在标注中 / 待认领的任务本来就不在 SUBMITTED 里，碰不到。
    别的审核员已经认领、正在审的也跳过。

    跟逐条通过一样每条写一条 review_records（审核人 = 操作的人，备注「批量通过」），另记一条 audit_log。
    通过错了用 unapprove 退回待审核，原样回去。"""
    if operator.role != UserRole.super_admin:
        raise ReviewConflictError("只有超级管理员能一键通过")
    q = select(Task).where(Task.status == TaskStatus.SUBMITTED)
    if project_id is not None:
        q = q.where(Task.project_id == project_id)
    tasks = (await db.execute(q)).scalars().all()
    unconfirmed, cand_pending = await _unfinished_tasks(db, [t.id for t in tasks])
    approved: list[int] = []
    skipped = {"locked": 0, "unconfirmed": 0, "cand_pending": 0}
    for t in tasks:
        if t.locked_by is not None and t.locked_by != operator.id:
            skipped["locked"] += 1
            continue
        if t.id in unconfirmed:
            skipped["unconfirmed"] += 1
            continue
        if t.id in cand_pending:
            skipped["cand_pending"] += 1
            continue
        db.add(ReviewRecord(task_id=t.id, round_no=t.round_no, reviewer_id=operator.id,
                            decision=ReviewDecision.approved, comment=BULK_COMMENT))
        t.status = TaskStatus.APPROVED
        t.reviewer_id = operator.id
        t.locked_by = None
        t.lock_expires_at = None
        approved.append(t.id)
    db.add(AuditLog(user_id=operator.id, action="review.bulk_approve",
                    target_type="project" if project_id is not None else "all",
                    target_id=project_id,
                    detail=json.dumps({"n": len(approved), "skipped": skipped, "task_ids": approved[:500]},
                                      ensure_ascii=False)))
    await db.commit()
    return {"approved": len(approved), "skipped": sum(skipped.values()), **{f"skipped_{k}": v for k, v in skipped.items()}}


BULK_COMMENT = "批量通过"


async def unapprove(db: AsyncSession, operator: User, task_ids: list[int] | None = None,
                    project_id: int | None = None, only_bulk: bool = True) -> dict:
    """把已通过的任务退回待审核（SUBMITTED），**原样**：轮次不变、片段 / 候选一条不动、指派的标注员不变。

    给"通过之后发现片段有问题"用：退回来再审（或驳回让标注员改）。跟「退回重标」不同——那个是
    轮次 +1、回到待分配，标注员要重新认领；这个只是把"已通过"这一步撤掉。

    范围：task_ids 给了就是这几条；否则按 project_id（不给 = 全部项目）。only_bulk=True 时只退
    「批量通过」的那些，逐条审过的不动。这一轮的审核记录删掉（(task_id, round_no) 唯一，不删就没法
    再审一次），删之前把它记进 audit_log。"""
    if operator.role not in (UserRole.super_admin, UserRole.admin):
        raise ReviewConflictError("只有管理员能退回待审核")
    q = select(Task).where(Task.status == TaskStatus.APPROVED)
    if task_ids:
        q = q.where(Task.id.in_(task_ids))
    elif project_id is not None:
        q = q.where(Task.project_id == project_id)
    tasks = (await db.execute(q)).scalars().all()
    recs = {(r.task_id, r.round_no): r for r in (await db.execute(
        select(ReviewRecord).where(ReviewRecord.task_id.in_([t.id for t in tasks] or [-1]))
    )).scalars().all()}
    done: list[dict] = []
    for t in tasks:
        rec = recs.get((t.id, t.round_no))
        if only_bulk and not task_ids and (rec is None or rec.comment != BULK_COMMENT):
            continue
        if rec is not None:
            done.append({"task_id": t.id, "round_no": t.round_no, "reviewer_id": rec.reviewer_id,
                         "comment": rec.comment})
            await db.delete(rec)
        else:
            done.append({"task_id": t.id, "round_no": t.round_no})
        t.status = TaskStatus.SUBMITTED
        t.reviewer_id = None
        t.locked_by = None
        t.lock_expires_at = None
    db.add(AuditLog(user_id=operator.id, action="review.unapprove",
                    target_type="tasks" if task_ids else ("project" if project_id is not None else "all"),
                    target_id=project_id,
                    detail=json.dumps({"n": len(done), "only_bulk": only_bulk, "records": done[:500]},
                                      ensure_ascii=False)))
    await db.commit()
    return {"reverted": len(done)}


async def approved_summary(db: AsyncSession) -> list[dict]:
    """每个项目：已通过几个、其中批量通过的几个（审核页「撤回通过」用）。"""
    from sqlalchemy import case, func

    from app.models.project import Project

    rows = (await db.execute(
        select(Task.project_id, Project.name, func.count(Task.id),
               func.sum(case((ReviewRecord.comment == BULK_COMMENT, 1), else_=0)))
        .join(Project, Project.id == Task.project_id)
        .outerjoin(ReviewRecord, (ReviewRecord.task_id == Task.id) & (ReviewRecord.round_no == Task.round_no))
        .where(Task.status == TaskStatus.APPROVED)
        .group_by(Task.project_id, Project.name)
        .order_by(Project.name.desc()))).all()
    return [{"project_id": pid, "project_name": n, "approved": int(a), "bulk_approved": int(b or 0)}
            for pid, n, a, b in rows]
