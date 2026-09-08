from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.ai_candidate import AiCandidate
from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.services.dog_name_service import dog_label, imu_dog_map
from app.models.user import User
from app.services.task_scope import exclude_sensitive
from app.schemas.task import LabelItemIn
from app.services.annotation_validation import find_first_overlap


class TaskConflictError(Exception):
    """认领/续期/保存 因状态不符或不是当前持有人而失败。"""


async def sample_brief(db: AsyncSession, tasks) -> dict[int, dict]:
    """
    任务列表要展示的样本信息 {sample_id: {sample_code, video_duration_sec}}。
    标注员/审核员拿不到 /samples，列表接口自己带；前端拿 sample_code 里的
    采集时间 + 时长拼成"几号 几点到几点、多长"这种人看得懂的名字。
    """
    ids = list({t.sample_id for t in tasks})
    if not ids:
        return {}
    # 分批：任务列表一页几十条无所谓，但"整个项目的任务"这种调用能到几千个
    # sample_id，一次 IN 进去会超出 MySQL range optimizer 的内存上限
    all_rows: list = []
    for i in range(0, len(ids), 1000):
        chunk = ids[i : i + 1000]
        all_rows += (
            await db.execute(
                select(
                    Sample.id, Sample.sample_code, Sample.video_duration_sec, Sample.imu_row_count
                ).where(Sample.id.in_(chunk))
            )
        ).all()
    rows = all_rows
    # 一个画面里同时有四只狗，标题上不写清楚"现在看的是哪只"就没法确认标注
    mapping = await imu_dog_map()
    return {
        sid: {
            "sample_code": code,
            "video_duration_sec": dur,
            "imu_row_count": rows_n,
            "dog_label": dog_label(code, mapping),
        }
        for sid, code, dur, rows_n in rows
    }


async def purge_task_children(db: AsyncSession, task_ids: list[int]) -> None:
    """
    删任务前先把挂在它下面的东西按外键顺序清干净。

    删项目和删任务两个入口都要做同一件事，之前各写各的，结果加了 ai_candidates
    这张表之后两边都漏了它——删项目直接 500（外键 1451）。所以统一到这里，
    以后再挂新表只改这一处。

    顺序（子指向父，从最里层往外删）：
      标签条目 → 候选（标签条目的 from_candidate_id 指向它，必须后于条目）
      → 标注记录 → 审核记录 → 断开子任务的 parent → 任务本身（调用方删）
    """
    if not task_ids:
        return
    # 一个项目上万个任务是常事（一天几千个样本各一个任务）。IN 一次塞几千个的话，
    # MySQL 的 range optimizer 会因为超出内存上限（range_optimizer_max_mem_size）
    # 放弃区间优化改走扫描，日志里刷警告而且很慢。分批走。
    def _chunks(seq: list[int], n: int = 1000):
        for i in range(0, len(seq), n):
            yield seq[i : i + n]

    for batch in _chunks(list(task_ids)):
        record_ids = list(
            (await db.execute(select(AnnotationRecord.id).where(AnnotationRecord.task_id.in_(batch)))).scalars()
        )
        for rec_batch in _chunks(record_ids):
            await db.execute(
                delete(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id.in_(rec_batch))
            )
        await db.execute(delete(AiCandidate).where(AiCandidate.task_id.in_(batch)))
        await db.execute(delete(AnnotationRecord).where(AnnotationRecord.task_id.in_(batch)))
        await db.execute(delete(ReviewRecord).where(ReviewRecord.task_id.in_(batch)))
        # 子任务的 parent 指向要删的任务，先断开，免得自引用外键挡住
        await db.execute(update(Task).where(Task.parent_task_id.in_(batch)).values(parent_task_id=None))


async def claim_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """
    原子认领：单条 UPDATE...WHERE 利用 InnoDB 行锁防止两人抢同一任务，
    不需要显式 SELECT...FOR UPDATE。
    - 开放任务池（assigned_to 为空）：谁先认领算谁的
    - 预指派（assigned_to 已指定）：只有被指定的人能认领
    """
    ttl_hours = settings.annotation_timeout_hours
    lock_expires = datetime.now(UTC) + timedelta(hours=ttl_hours)

    stmt = (
        update(Task)
        .where(
            Task.id == task_id,
            Task.status == TaskStatus.PENDING_ASSIGN,
            (Task.assigned_to.is_(None)) | (Task.assigned_to == user.id),
        )
        .values(
            status=TaskStatus.IN_PROGRESS,
            assigned_to=user.id,
            locked_by=user.id,
            lock_expires_at=lock_expires,
        )
    )
    # 敏感样本上的任务非管理员不能领（列表里本来就看不到，这里是防直接调接口）
    stmt = exclude_sensitive(stmt, user)
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务已被认领或不存在，请刷新列表")

    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def release_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """
    标注员主动放弃任务：不管标了没标、标了多少，草稿都留着不动（草稿按
    task_id+round_no 存，跟谁认领的没关系），只是把任务退回公共池，
    换个人认领之后打开工作台会看到上一个人留下的草稿，接着标即可。

    跟"退回重标"（reopen）不是一回事：那个是审核驳回专用，会开新一轮；
    这个是标注中途自己放弃，轮次不变。
    """
    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.locked_by == user.id, Task.status == TaskStatus.IN_PROGRESS)
        .values(status=TaskStatus.PENDING_ASSIGN, assigned_to=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务不在你名下或已不在进行中，无法放弃")

    await db.commit()
    task = await db.get(Task, task_id)
    assert task is not None
    return task


async def claim_all_in_project(db: AsyncSession, project_id: int, user: User) -> int:
    """一个人把项目里所有能领的任务一次领完（几百个一个个点太折磨人）。
    条件跟 claim_task 完全一样，只是不限定 task_id：待认领、且没预指派给
    别人的；同样是单条 UPDATE...WHERE，有人同时在抢的话各领各的、不会重复。
    返回实际领到的数量。"""
    lock_expires = datetime.now(UTC) + timedelta(hours=settings.annotation_timeout_hours)
    stmt = (
        update(Task)
        .where(
            Task.project_id == project_id,
            Task.status == TaskStatus.PENDING_ASSIGN,
            (Task.assigned_to.is_(None)) | (Task.assigned_to == user.id),
        )
        .values(
            status=TaskStatus.IN_PROGRESS,
            assigned_to=user.id,
            locked_by=user.id,
            lock_expires_at=lock_expires,
        )
    )
    stmt = exclude_sensitive(stmt, user)
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount


async def release_all_in_project(db: AsyncSession, project_id: int, user: User) -> int:
    """把项目里自己名下所有标注中的任务一次全放弃（不干了）。条件跟
    release_task 一样，草稿照样保留。返回实际放弃的数量。"""
    stmt = (
        update(Task)
        .where(Task.project_id == project_id, Task.locked_by == user.id, Task.status == TaskStatus.IN_PROGRESS)
        .values(status=TaskStatus.PENDING_ASSIGN, assigned_to=None, locked_by=None, lock_expires_at=None)
    )
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount


async def heartbeat(db: AsyncSession, task_id: int, user: User) -> None:
    """只有当前锁定人能续期，推迟 lock_expires_at。"""
    ttl_hours = settings.annotation_timeout_hours
    lock_expires = datetime.now(UTC) + timedelta(hours=ttl_hours)

    stmt = (
        update(Task)
        .where(Task.id == task_id, Task.locked_by == user.id, Task.status == TaskStatus.IN_PROGRESS)
        .values(lock_expires_at=lock_expires)
    )
    result = await db.execute(stmt)
    if result.rowcount != 1:
        await db.rollback()
        raise TaskConflictError("任务不在你名下或已不在进行中，心跳失败")
    await db.commit()


async def _get_or_create_record(db: AsyncSession, task: Task) -> AnnotationRecord:
    result = await db.execute(
        select(AnnotationRecord).where(
            AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        source_type = (
            RecordSourceType.ai_revised if task.task_type == TaskType.ai_assisted else RecordSourceType.human_only
        )
        record = AnnotationRecord(task_id=task.id, round_no=task.round_no, source_type=source_type)
        db.add(record)
        await db.flush()
    return record


async def save_draft(db: AsyncSession, task_id: int, user: User, items: list[LabelItemIn]) -> AnnotationRecord:
    """
    保存草稿：UPSERT annotation_records(task_id, round_no)，逐条 replace-in-place
    label items。草稿阶段允许时间重叠（画到一半的中间态），提交时才强制校验。
    """
    task = await db.get(Task, task_id)
    if task is None:
        raise TaskConflictError("任务不存在")
    if task.locked_by != user.id or task.status != TaskStatus.IN_PROGRESS:
        raise TaskConflictError("任务不在你名下或已不在进行中，无法保存")

    record = await _get_or_create_record(db, task)

    existing_result = await db.execute(
        select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)
    )
    existing_by_id = {item.id: item for item in existing_result.scalars().all()}

    keep_ids: set[int] = set()
    for incoming in items:
        origin = existing_by_id.get(incoming.origin_item_id) if incoming.origin_item_id else None
        if origin is not None:
            keep_ids.add(origin.id)
            changed = (
                origin.label_id != incoming.label_id
                or origin.start_time_ms != incoming.start_time_ms
                or origin.end_time_ms != incoming.end_time_ms
            )
            origin.label_id = incoming.label_id
            origin.start_time_ms = incoming.start_time_ms
            origin.end_time_ms = incoming.end_time_ms
            if changed:
                origin.is_modified = True
                origin.created_by = user.id
                # 改过之后原来的"确认正确"不再成立，除非这次请求明确再确认
                origin.ai_confirmed = bool(incoming.ai_confirmed)
            elif incoming.ai_confirmed is not None:
                origin.ai_confirmed = incoming.ai_confirmed
            if incoming.uncertain is not None:
                origin.uncertain = incoming.uncertain
                # 取消待定就把原因一起清掉，别留个孤零零的原因在库里
                origin.uncertain_reason = incoming.uncertain_reason if incoming.uncertain else None
        else:
            new_item = AnnotationLabelItem(
                annotation_record_id=record.id,
                label_id=incoming.label_id,
                start_time_ms=incoming.start_time_ms,
                end_time_ms=incoming.end_time_ms,
                source_type=incoming.source_type or LabelItemSource.human_added,
                is_modified=False,
                ai_confidence=incoming.ai_confidence
                if incoming.source_type == LabelItemSource.ai_generated
                else None,
                ai_confirmed=bool(incoming.ai_confirmed) and incoming.source_type == LabelItemSource.ai_generated,
                uncertain=bool(incoming.uncertain),
                uncertain_reason=incoming.uncertain_reason if incoming.uncertain else None,
                created_by=user.id,
            )
            db.add(new_item)
            await db.flush()
            keep_ids.add(new_item.id)

    for item_id, item in existing_by_id.items():
        if item_id not in keep_ids:
            await db.delete(item)

    await db.commit()
    await db.refresh(record)
    return record


async def submit_task(db: AsyncSession, task_id: int, user: User) -> Task:
    """提交：强制校验标签不重叠（决策③），通过后状态流转到 SUBMITTED。"""
    task = await db.get(Task, task_id)
    if task is None:
        raise TaskConflictError("任务不存在")
    if task.locked_by != user.id or task.status != TaskStatus.IN_PROGRESS:
        raise TaskConflictError("任务不在你名下或已不在进行中，无法提交")

    record = await _get_or_create_record(db, task)
    items_result = await db.execute(
        select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)
    )
    items = items_result.scalars().all()
    as_schema = [
        LabelItemIn(label_id=i.label_id, start_time_ms=i.start_time_ms, end_time_ms=i.end_time_ms) for i in items
    ]
    overlap = find_first_overlap(as_schema)
    if overlap is not None:
        raise TaskConflictError(
            f"存在时间重叠的标签（{overlap[0].start_time_ms}-{overlap[0].end_time_ms}ms 与 "
            f"{overlap[1].start_time_ms}-{overlap[1].end_time_ms}ms），请修正后再提交"
        )

    record.submitted_at = datetime.now(UTC)
    task.status = TaskStatus.SUBMITTED
    task.locked_by = None
    task.lock_expires_at = None
    await db.commit()
    await db.refresh(task)
    return task
