"""
任务认领/心跳/草稿/提交。三角色共用，统一走 apply_task_scope() 过滤，
不允许在这里各自写 WHERE 条件。业务逻辑在 services/task_service.py，
这里只做参数校验+调用+异常转换。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import case, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.review import ReviewRecord
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.schemas.task import (
    BulkTaskCreate,
    BulkTaskCreateResult,
    DraftOut,
    DraftSaveRequest,
    LabelItemOut,
    ProjectScopeRequest,
    ReopenRequest,
    TaskCreate,
    TaskIdsRequest,
    TaskOut,
)
from app.services.ai_prelabel_service import start_project_prelabel
from app.services.review_service import ReviewConflictError, reopen_task
from app.services.task_scope import apply_task_scope
from app.services.dog_name_service import dog_label, imu_dog_map
from app.services.task_service import (
    TaskConflictError,
    claim_all_in_project,
    claim_task,
    heartbeat,
    release_all_in_project,
    release_task,
    purge_task_children,
    sample_brief,
    save_draft,
    submit_task,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def create_task(body: TaskCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)):
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    sample = await db.get(Sample, body.sample_id)
    if sample is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "样本不存在")

    task = Task(
        project_id=body.project_id,
        sample_id=body.sample_id,
        task_type=body.task_type,
        segment_start_ms=body.segment_start_ms,
        segment_end_ms=body.segment_end_ms,
        assigned_to=body.assigned_to,
        created_by=admin.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    # 选了"AI预标注+人工修改"就直接把 AI 跑上，不用人再一个个认领进去点
    if task.task_type == TaskType.ai_assisted:
        await start_project_prelabel(task.project_id, task_ids=[task.id])
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/bulk", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def bulk_create_tasks(
    body: BulkTaskCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    """
    批量建任务：样本页是按日期分组的，一天几十个样本很常见，一个个点「新建任务」
    太麻烦，这里一次性把整批样本各建一个长任务（覆盖整个样本，不切片段）。

    已经在这个项目下建过任务的样本会跳过，不重复建（比如同一天导入了两次）。
    """
    project = await db.get(Project, body.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if not body.sample_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有选中任何样本")

    existing_ids = set((await db.execute(select(Sample.id).where(Sample.id.in_(body.sample_ids)))).scalars().all())
    missing = set(body.sample_ids) - existing_ids
    if missing:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"样本不存在: {sorted(missing)}")

    already_has_task = set(
        (
            await db.execute(
                select(Task.sample_id).where(
                    Task.project_id == body.project_id, Task.sample_id.in_(body.sample_ids)
                )
            )
        )
        .scalars()
        .all()
    )

    created = 0
    new_tasks: list[Task] = []
    for sample_id in body.sample_ids:
        if sample_id in already_has_task:
            continue
        t = Task(
            project_id=body.project_id,
            sample_id=sample_id,
            task_type=body.task_type,
            assigned_to=body.assigned_to,
            created_by=admin.id,
        )
        db.add(t)
        new_tasks.append(t)
        created += 1
    await db.commit()
    # "AI预标注+人工修改"类型：建完直接后台批量跑 AI，项目页能看到进度
    if body.task_type == TaskType.ai_assisted and new_tasks:
        await start_project_prelabel(body.project_id, task_ids=[t.id for t in new_tasks], mode=body.infer_mode)

    skipped = sorted(already_has_task)
    return ok(
        BulkTaskCreateResult(created=created, skipped=len(skipped), skipped_sample_ids=skipped).model_dump()
    )


@router.post("/{task_id}/reopen")
async def reopen(
    task_id: int,
    body: ReopenRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    把已通过/已驳回的任务退回重标（轮次+1，上一轮内容原样带过去）。
    管理员/审核员随时能退；标注员只能退自己被驳回的那条（reopen_task 里判断），
    所以这里不按角色卡权限，交给 service 按具体任务判断。
    """
    try:
        task = await reopen_task(db, task_id, user, body.comment)
    except ReviewConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


async def _delete_tasks(db: AsyncSession, task_ids: list[int]) -> int:
    """
    任务下面挂着标注记录/标签条目/候选/审核记录，外键都指向 tasks，得先按顺序
    清干净才能删任务本身——顺序统一放在 purge_task_children 里，删项目那边走的
    是同一个（之前两边各写各的，加了候选表之后双双漏掉，删项目直接 500）。
    被它当作父任务的子任务不跟着删，只把 parent_task_id 置空，避免误伤已拆分的短任务。
    """
    if not task_ids:
        return 0
    await purge_task_children(db, task_ids)
    result = await db.execute(delete(Task).where(Task.id.in_(task_ids)))
    await db.commit()
    return result.rowcount


@router.delete("/{task_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    """管理员删除任务。"""
    task = await db.get(Task, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    await _delete_tasks(db, [task_id])
    return ok(msg="任务已删除")


@router.post("/delete-batch", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def delete_tasks_batch(body: TaskIdsRequest, db: AsyncSession = Depends(get_db)):
    """
    批量删任务：主要用来清掉 IMU CSV 是空的那些（打开就报"CSV 没有数据行"），
    别把这种坏数据分给标注员。前端按 imu_row_count 筛出来再调这里。
    """
    n = await _delete_tasks(db, list(set(body.task_ids)))
    return ok({"count": n})


@router.get("")
async def list_tasks(
    project_id: int | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    query = apply_task_scope(select(Task), user)
    if project_id is not None:
        query = query.where(Task.project_id == project_id)
    query = query.order_by(Task.created_at.desc())
    result = await db.execute(query)
    tasks = result.scalars().all()

    # 下面几个聚合查询以前是把上万个 task_id 拼成 IN (...) 发过去，MySQL 直接放弃
    # 范围优化（日志里的 range_optimizer_max_mem_size exceeded），退化成全表扫。
    # 改成 JOIN 这个子查询：条件一样，但是能走索引，SQL 文本也不会几百 KB。
    scoped_ids = apply_task_scope(select(Task.id), user)
    if project_id is not None:
        scoped_ids = scoped_ids.where(Task.project_id == project_id)
    scope = scoped_ids.subquery()

    # 待认领但已经有人标过一部分（比如中途放弃）的任务，前端要标出来提示
    # "有草稿"，不是从零开始
    # 同时带上当前轮已经存了多少段：标注中的任务光看状态分不出"只是认领了进去
    # 看了一眼"和"已经标了一堆"，列表里要靠这个数区分
    draft_counts: dict[int, int] = {}
    task_ids = [t.id for t in tasks]
    if task_ids:
        rows = await db.execute(
            select(AnnotationRecord.task_id, func.count(AnnotationLabelItem.id))
            .join(Task, Task.id == AnnotationRecord.task_id)
            .join(scope, scope.c.id == Task.id)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .where(AnnotationRecord.round_no == Task.round_no)
            .group_by(AnnotationRecord.task_id)
        )
        draft_counts = {task_id: int(n) for task_id, n in rows.all()}

    # 每个任务当前轮各类别有几段、其中多少是 AI 给的还没人确认的——列表里直接
    # 显示"抓挠 5 / 睡觉 3"，想专门审抓挠的一眼就能挑出哪些任务去看，不用逐个点开
    label_counts: dict[int, dict[int, dict[str, int]]] = {}
    if task_ids:
        ai_pending = case(
            (
                (AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
                & (AnnotationLabelItem.ai_confirmed.is_(False))
                & (AnnotationLabelItem.is_modified.is_(False))
                # 标了「待定」的已经处理过了（人看了，拿不准），不该再催着确认
                & (AnnotationLabelItem.uncertain.is_(False)),
                1,
            ),
            else_=0,
        )
        rows = await db.execute(
            select(
                AnnotationRecord.task_id,
                AnnotationLabelItem.label_id,
                func.count(AnnotationLabelItem.id),
                func.sum(ai_pending),
            )
            .join(Task, Task.id == AnnotationRecord.task_id)
            .join(scope, scope.c.id == Task.id)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .where(AnnotationRecord.round_no == Task.round_no)
            .group_by(AnnotationRecord.task_id, AnnotationLabelItem.label_id)
        )
        for task_id, label_id, n, n_pending in rows.all():
            label_counts.setdefault(task_id, {})[label_id] = {"n": int(n), "ai_pending": int(n_pending or 0)}

    # 被驳回的任务把审核意见带出来，标注员一看就知道要改什么，不用另外去问审核员
    rejected_ids = [t.id for t in tasks if t.status == TaskStatus.REJECTED]
    review_comments: dict[int, str | None] = {}
    if rejected_ids:
        rows = await db.execute(
            select(ReviewRecord.task_id, ReviewRecord.comment)
            .join(Task, Task.id == ReviewRecord.task_id)
            .where(ReviewRecord.task_id.in_(rejected_ids), ReviewRecord.round_no == Task.round_no)
        )
        review_comments = dict(rows.all())

    # 样本编号 + 指派人名字：非管理员拿不到 /samples、/users，列表里不能只给 ID。
    # 同样用 JOIN 子查询取，不拼上万个 sample_id 的 IN 列表
    brief_rows = await db.execute(
        select(Sample.id, Sample.sample_code, Sample.video_duration_sec, Sample.imu_row_count)
        .join(Task, Task.sample_id == Sample.id)
        .join(scope, scope.c.id == Task.id)
        .distinct()
    )
    dog_map = await imu_dog_map()
    briefs = {
        sid: {
            "sample_code": code,
            "video_duration_sec": dur,
            "imu_row_count": rows_n,
            "dog_label": dog_label(code, dog_map),
        }
        for sid, code, dur, rows_n in brief_rows.all()
    }
    user_names: dict[int, str] = {}
    user_roles: dict[int, str] = {}
    if tasks:
        uids = {t.assigned_to for t in tasks if t.assigned_to is not None}
        if uids:
            rows = await db.execute(select(User.id, User.display_name, User.username, User.role).where(User.id.in_(uids)))
            for uid, dn, un, role in rows.all():
                user_names[uid] = dn or un
                user_roles[uid] = role.value if hasattr(role, "value") else str(role)

    return ok(
        [
            {
                **TaskOut.model_validate(t).model_dump(),
                "has_draft": draft_counts.get(t.id, 0) > 0,
                "draft_item_count": draft_counts.get(t.id, 0),
                "label_counts": label_counts.get(t.id, {}),
                "review_comment": review_comments.get(t.id),
                **briefs.get(t.sample_id, {}),
                "assigned_to_name": user_names.get(t.assigned_to) if t.assigned_to is not None else None,
                "assigned_to_role": user_roles.get(t.assigned_to) if t.assigned_to is not None else None,
            }
            for t in tasks
        ]
    )


@router.get("/{task_id}")
async def get_task(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_task_scope(select(Task).where(Task.id == task_id), user)
    result = await db.execute(query)
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")
    # 带上样本简介（样本名/时长/是哪只狗）：皮肤跟踪表那边是拿单个任务直接开
    # 工作台的，不走列表接口，没有这一段标题上就没有狗名
    brief = (await sample_brief(db, [task])).get(task.sample_id, {})
    return ok({**TaskOut.model_validate(task).model_dump(), **brief})


@router.post("/claim-all")
async def claim_all(body: ProjectScopeRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """一次领完项目里所有待认领（且没预指派给别人）的任务，返回领到几个。"""
    n = await claim_all_in_project(db, body.project_id, user)
    return ok({"count": n})


@router.post("/release-all")
async def release_all(body: ProjectScopeRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """一次放弃项目里自己名下所有标注中的任务，草稿保留，返回放弃了几个。"""
    n = await release_all_in_project(db, body.project_id, user)
    return ok({"count": n})


@router.post("/{task_id}/claim")
async def claim(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await claim_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.post("/{task_id}/release")
async def release(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """标注员主动放弃任务，退回公共池；草稿保留，换人接手能接着标。"""
    try:
        task = await release_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())


@router.patch("/{task_id}/heartbeat")
async def send_heartbeat(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        await heartbeat(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(msg="心跳成功")


@router.get("/{task_id}/draft")
async def get_draft(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    query = apply_task_scope(select(Task).where(Task.id == task_id), user)
    task = (await db.execute(query)).scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")

    record = (
        await db.execute(
            select(AnnotationRecord).where(
                AnnotationRecord.task_id == task_id, AnnotationRecord.round_no == task.round_no
            )
        )
    ).scalar_one_or_none()
    if record is None:
        return ok(DraftOut(round_no=task.round_no, items=[]).model_dump())

    items = (
        (await db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)))
        .scalars()
        .all()
    )
    return ok(
        DraftOut(
            round_no=task.round_no,
            items=[LabelItemOut.model_validate(i).model_dump() for i in items],
        ).model_dump()
    )


@router.put("/{task_id}/draft")
async def put_draft(
    task_id: int,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        await save_draft(db, task_id, user, body.items)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(msg="草稿已保存")


@router.post("/{task_id}/submit")
async def submit(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await submit_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())
