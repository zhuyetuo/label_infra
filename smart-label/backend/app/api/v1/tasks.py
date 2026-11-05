"""
任务认领/心跳/草稿/提交。三角色共用，统一走 apply_task_scope() 过滤，
不允许在这里各自写 WHERE 条件。业务逻辑在 services/task_service.py，
这里只做参数校验+调用+异常转换。
"""

import json
import logging
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, case, delete, func, insert, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.ai_candidate import AiCandidate, CandidateStatus
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
    ReviewNoteIn,
    TaskCreate,
    TaskIdsRequest,
    TaskOut,
)
from app.services.ai_prelabel_service import start_project_prelabel
from app.services.review_service import ReviewConflictError, reopen_task
from app.services.task_scope import apply_task_scope
from app.services.dog_name_service import dog_label_of, dog_names_by_id, imu_dog_map, site_imu_dog_map
from app.services.task_service import (
    TaskConflictError,
    claim_all_in_project,
    claim_task,
    heartbeat,
    release_all_in_project,
    release_task,
    edit_again,
    purge_task_children,
    sample_brief,
    save_draft,
    submit_task,
)

# 任务号 → (签名, {类别: 重叠段数})。列表接口每次刷新都要这个数，见 list_tasks 里「重叠」那段
_OVERLAP_CACHE: dict[int, tuple[tuple, dict[int, int]]] = {}

router = APIRouter(prefix="/tasks", tags=["tasks"])
logger = logging.getLogger("smart-label.tasks")


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

    # IN 列表不能一次塞几千个：MySQL 的 range optimizer 有内存上限
    # （range_optimizer_max_mem_size，默认 8MB），超了它就放弃区间优化改走扫描，
    # 日志里刷一堆 "Range optimization was not done" 而且慢。分批查。
    existing_ids: set[int] = set()
    for i in range(0, len(body.sample_ids), 1000):
        chunk = body.sample_ids[i : i + 1000]
        existing_ids |= set((await db.execute(select(Sample.id).where(Sample.id.in_(chunk)))).scalars())
    missing = set(body.sample_ids) - existing_ids
    if missing:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"样本不存在: {sorted(missing)[:50]}")

    # 这个项目下已经有任务的样本。按 project_id 一次查完再在内存里筛，比拿几千个
    # sample_id 去 IN 快得多——project_id 上有索引，而且一个项目的任务数本来就有限
    already_has_task = set(
        (await db.execute(select(Task.sample_id).where(Task.project_id == body.project_id))).scalars()
    )

    # 一次几百上千个样本很常见（十几天一起建项目时更是上万）。逐个 db.add 是走
    # ORM 的工作单元，几千行会明显慢；这里直接一条 executemany 插进去。
    # MySQL 没有 RETURNING，插完还得再查一次拿 id：同样按 project_id 查（不用
    # IN 几千个 sample_id），再在内存里挑出这一批新建的。
    new_sample_ids = [sid for sid in body.sample_ids if sid not in already_has_task]
    created = len(new_sample_ids)
    new_task_ids: list[int] = []
    if new_sample_ids:
        await db.execute(
            insert(Task),
            [
                {
                    "project_id": body.project_id,
                    "sample_id": sid,
                    "task_type": body.task_type,
                    "status": TaskStatus.PENDING_ASSIGN,
                    "round_no": 1,
                    "assigned_to": body.assigned_to,
                    "created_by": admin.id,
                }
                for sid in new_sample_ids
            ],
        )
        if body.assigned_to is not None:
            db.add(AuditLog(user_id=admin.id, action="task.assign", target_type="project", target_id=body.project_id,
                            detail=json.dumps({"assigned_to": body.assigned_to, "n": created}, ensure_ascii=False)))
        await db.commit()
        wanted = set(new_sample_ids)
        new_task_ids = [
            tid
            for tid, sid in (
                await db.execute(
                    select(Task.id, Task.sample_id).where(Task.project_id == body.project_id)
                )
            ).all()
            if sid in wanted
        ]
    # "AI预标注+人工修改"类型：建完直接后台批量跑 AI，项目页能看到进度。
    # 这个项目本来就没有任务的话（新建项目最常见），直接说"整个项目"，别拿几千个
    # task_id 去 IN——那又是一次超出 range optimizer 内存上限的大查询
    if body.task_type == TaskType.ai_assisted and new_task_ids:
        await start_project_prelabel(
            body.project_id,
            task_ids=None if not already_has_task else new_task_ids,
            mode=body.infer_mode,
        )

    skipped = sorted(already_has_task)
    return ok(
        BulkTaskCreateResult(created=created, skipped=len(skipped), skipped_sample_ids=skipped).model_dump()
    )


@router.put("/{task_id}/items/{item_id}/review-note")
async def set_review_note(
    task_id: int,
    item_id: int,
    body: ReviewNoteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """给当前这一轮的某条片段标「有问题」（或清掉）。

    以前只能整个任务退回，标注员拿回去不知道该看哪几条。标了之后，驳回 / 退回重标
    开新一轮时这些标记跟着过去，标注员默认只看这几条。

    权限：管理员 / 审核员能标能清，任务什么状态都行（看已通过的任务时发现问题也能标）；
    标注员只能在自己正在标的任务里**清掉**（表示改好了），不能给别人标。
    不改片段本身，也不改任务状态——退回是另外一步。
    """
    task = (await db.execute(apply_task_scope(select(Task).where(Task.id == task_id), user))).scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在或无权访问")
    note = (body.note or "").strip() or None
    privileged = user.role in (UserRole.admin, UserRole.super_admin, UserRole.reviewer)
    if not privileged and not (note is None and task.locked_by == user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能标「有问题」；标注员只能在自己认领的任务里清掉")
    item = (await db.execute(
        select(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationLabelItem.id == item_id, AnnotationRecord.task_id == task_id,
               AnnotationRecord.round_no == task.round_no)
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这条片段不在当前这一轮里（任务已经进入新一轮？刷新一下）")
    item.review_note = note
    item.review_flag_by = user.id if note else None
    item.review_flag_at = datetime.now(UTC).replace(tzinfo=None) if note else None
    # 「有问题」就是片段级的退回：跟「片段审核」那边是同一个状态。清掉（改好了 / 撤销）回到待审
    item.seg_status = "returned" if note else None
    if note:
        item.seg_reviewed_by, item.seg_reviewed_at = user.id, datetime.now()
    await db.commit()
    await db.refresh(item)
    return ok(LabelItemOut.model_validate(item).model_dump())


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
    project_id: int | None = None, ids: str | None = None, lite: bool = False,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    """ids：逗号分隔的任务 id，只算这几个（工作台关掉 / 存草稿 / 通过一段之后只刷那一行，
    不用把几千个任务整份重算一遍）
    lite：只要任务本身 + 样本 / 指派人名字，不算片段 / 重叠 / 候选这些统计。项目页先用它把
    每个项目「共几个、待认领几个」秒出来，完整统计后到再补上"""
    only_ids = [int(x) for x in ids.split(",") if x.strip()] if ids else None
    # 分段计时：整个接口超过 2 秒就把各段耗时记到 api.log（系统监控页搜 tasks-timing），
    # 好知道慢在哪一段，不用猜
    _t0 = _tl = time.perf_counter()
    _laps: list[str] = []

    def _lap(name: str) -> None:
        nonlocal _tl
        now = time.perf_counter()
        _laps.append(f"{name}={now - _tl:.2f}s")
        _tl = now

    query = apply_task_scope(select(Task), user)
    if project_id is not None:
        query = query.where(Task.project_id == project_id)
    if only_ids:
        query = query.where(Task.id.in_(only_ids))
    query = query.order_by(Task.created_at.desc())
    result = await db.execute(query)
    tasks = result.scalars().all()

    # 下面几个聚合查询以前是把上万个 task_id 拼成 IN (...) 发过去，MySQL 直接放弃
    # 范围优化（日志里的 range_optimizer_max_mem_size exceeded），退化成全表扫。
    # 改成 JOIN 这个子查询：条件一样，但是能走索引，SQL 文本也不会几百 KB。
    scoped_ids = apply_task_scope(select(Task.id), user)
    if project_id is not None:
        scoped_ids = scoped_ids.where(Task.project_id == project_id)
    if only_ids:
        scoped_ids = scoped_ids.where(Task.id.in_(only_ids))
    scope = scoped_ids.subquery()

    _lap("tasks")
    # 待认领但已经有人标过一部分（比如中途放弃）的任务，前端要标出来提示
    # "有草稿"，不是从零开始
    # 同时带上当前轮已经存了多少段：标注中的任务光看状态分不出"只是认领了进去
    # 看了一眼"和"已经标了一堆"，列表里要靠这个数区分
    draft_counts: dict[int, int] = {}
    # lite 时下面几段统计都跳过（task_ids 置空）
    task_ids = [] if lite else [t.id for t in tasks]
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

    _lap("draft")
    # 每个任务当前轮各类别有几段、其中多少是 AI 给的还没人确认的——列表里直接
    # 显示"抓挠 5 / 睡觉 3"，想专门审抓挠的一眼就能挑出哪些任务去看，不用逐个点开
    label_counts: dict[int, dict[int, dict[str, int]]] = {}
    seg_sig: dict[int, list[tuple]] = {}
    if task_ids:
        from app.services.data_pool import in_pool_cond
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
                # 片段审核：通过了几段、退回了还没处理的几段（项目页按类别看「哪些 OK、哪些在等标注员改」）
                # 「有问题」标记也算退回：片段审核上线前标的只有 review_note（迁移已补，这里再兜一层）
                func.sum(case(((AnnotationLabelItem.seg_status == "approved") & AnnotationLabelItem.review_note.is_(None), 1),
                              else_=0)),
                func.sum(case(((AnnotationLabelItem.seg_status == "returned") | AnnotationLabelItem.review_note.is_not(None), 1),
                              else_=0)),
                # 已在数据池里的（项目页「加入数据池」按钮看这个）。待定的不进池，不算
                func.sum(case((in_pool_cond() & AnnotationLabelItem.uncertain.is_(False), 1), else_=0)),
                # 最长一段 / 合计时长：项目页按类别看时挑长片段进数据池
                func.max(AnnotationLabelItem.end_time_ms - AnnotationLabelItem.start_time_ms),
                func.sum(AnnotationLabelItem.end_time_ms - AnnotationLabelItem.start_time_ms),
                # 下面两个只给「重叠」那段做缓存签名用：段的位置 / 增删变了，签名就变
                func.sum(AnnotationLabelItem.start_time_ms),
                func.sum(AnnotationLabelItem.id),
                func.min(AnnotationRecord.id),
            )
            .join(Task, Task.id == AnnotationRecord.task_id)
            .join(scope, scope.c.id == Task.id)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .where(AnnotationRecord.round_no == Task.round_no)
            .group_by(AnnotationRecord.task_id, AnnotationLabelItem.label_id)
        )
        for task_id, label_id, n, n_pending, n_ok, n_ret, n_pool, mx, tot, s_start, s_id, rec_id in rows.all():
            seg_sig.setdefault(task_id, []).append((rec_id, label_id, int(n), int(s_start or 0), int(tot or 0), int(s_id or 0)))
            label_counts.setdefault(task_id, {})[label_id] = {
                "n": int(n), "ai_pending": int(n_pending or 0),
                "approved": int(n_ok or 0), "returned": int(n_ret or 0), "pool": int(n_pool or 0),
                "max_ms": int(mx or 0), "ms": int(tot or 0),
            }

    _lap("labels")
    # 有重叠的片段数（同一轨上互相压着的：同类重复 / 父子 / 类别冲突）。项目页每行标个
    # 「重叠 N」，点进去只看这些——不然重复、矛盾的段只能一个个任务点开去找
    #
    # 在数据库里用窗口函数算，只回每个任务一个数：原来把所有任务的所有片段拉到 Python 里扫，
    # 超级管理员看全部项目时是几十万行，列表接口直接超时。
    # 口径：同一条记录、同一轨里按开始时间排，跟它前面任一段重叠 ≥0.2s 的算一处
    # （所以 N = 多出来的那几段；三段压在一起算 2 处）
    overlap_counts: dict[int, int] = {}
    overlap_by_label: dict[int, dict[int, int]] = {}
    if task_ids:
        from app.models.label import LabelDefinition
        from app.services.label_tracks import OVERLAP_MIN_MS, track_of

        lab_rows = (await db.execute(select(LabelDefinition.id, LabelDefinition.parent_id, LabelDefinition.track))).all()
        parent_of = {i: p_ for i, p_, _t in lab_rows}
        own = {i: t for i, _p, t in lab_rows}
        trk_of = {i: track_of(parent_of, own, i) for i, _p, _t in lab_rows}
        trk_map = {i: t for i, t in trk_of.items() if t}
        it = AnnotationLabelItem
        trk = case(trk_map, value=it.label_id, else_="") if trk_map else literal("")
        win = {"partition_by": (it.annotation_record_id, trk), "order_by": (it.start_time_ms, it.id)}
        prev_end = func.max(it.end_time_ms).over(rows=(None, -1), **win)
        next_start = func.lead(it.start_time_ms).over(**win)
        inner = (
            select(AnnotationRecord.task_id.label("tid"), it.label_id.label("lid"), it.start_time_ms.label("s"),
                   it.end_time_ms.label("e"), prev_end.label("pe"), next_start.label("ns"))
            .join(Task, Task.id == AnnotationRecord.task_id)
            .join(scope, scope.c.id == Task.id)
            .join(it, it.annotation_record_id == AnnotationRecord.id)
            .where(AnnotationRecord.round_no == Task.round_no)
        ).subquery()
        # 一段算「有重叠」：跟前面任一段压了 ≥0.2s，或者后面紧跟的那段在它结束前 0.2s 以上就开始了。
        # 数的是**卷进重叠的片段数**（跟工作台里「⚠ 重叠 N」一个口径），按类别分开数，
        # 项目页按某个类别看时只算那一类
        ov_end = case((inner.c.pe < inner.c.e, inner.c.pe), else_=inner.c.e)
        hit = or_(and_(inner.c.pe.is_not(None), ov_end - inner.c.s >= OVERLAP_MIN_MS),
                  and_(inner.c.ns.is_not(None), inner.c.e - inner.c.ns >= OVERLAP_MIN_MS))
        # 缓存：窗口函数要把范围里**每一段**排一遍，一万多个任务一次 13 秒，列表每刷一次都算。
        # 每个任务按「各类别段数 / 起点和 / 时长和 / id 和」做签名（上面 labels 那次聚合顺手算的，
        # 不多一次查询），签名没变就用上次的结果，只重算变了的那几个任务。
        # 轨道配置也进签名：改了哪个类别属于哪条轨，所有任务都要重算
        trk_sig = hash(tuple(sorted(trk_map.items())))
        sig_now = {t: (trk_sig, tuple(sorted(seg_sig.get(t, [])))) for t in task_ids}
        stale = [t for t in task_ids if seg_sig.get(t) and _OVERLAP_CACHE.get(t, (None,))[0] != sig_now[t]]
        fresh: dict[int, dict[int, int]] = {t: {} for t in stale}

        async def _run(q):
            for t, lid, n in (await db.execute(q)).all():
                fresh.setdefault(int(t), {})[int(lid)] = int(n)

        base = select(inner.c.tid, inner.c.lid, func.count()).where(hit).group_by(inner.c.tid, inner.c.lid)
        if len(stale) > 2000:
            await _run(base)          # 第一次 / 大面积变了：整个范围一次算完
        else:
            # 只算变了的。inner 已经按 scope 过滤，这里再按任务号收窄（窗口按记录分区，收窄不影响结果）
            for i in range(0, len(stale), 500):
                await _run(base.where(inner.c.tid.in_(stale[i:i + 500])))
        for t in task_ids:
            if t in fresh or not seg_sig.get(t):
                _OVERLAP_CACHE[t] = (sig_now[t], fresh.get(t, {}))
            by = _OVERLAP_CACHE[t][1]
            if by:
                overlap_by_label[t] = dict(by)
                overlap_counts[t] = sum(by.values())
        if len(_OVERLAP_CACHE) > 300_000:
            _OVERLAP_CACHE.clear()

    _lap("overlap")
    # 「疑似抓挠」候选的条数。它不在 annotation_records 里，所以上面那份 label_counts
    # 统计不到——而列表上只显示正式片段的话，一个"抓挠 0 段"的任务看着像没事干，
    # 其实底下压着十几条待判断的候选。两个数一起给：待确认多少、总共多少。
    cand_counts: dict[int, dict[str, int]] = {}
    # 候选是按哪个类别提的，也要一并给出来。项目列表的「含类别」原来只认片段：
    # 用一句话找画面给某个任务写了一条「舔-后爪」候选，回到项目页按「舔」筛，
    # 那个任务**找不着**——它确实还没有舔的片段，有的是一条等着判的候选。
    # 候选存的是 label_name（字符串），前端按名字对回项目标签
    cand_labels: dict[int, dict[str, dict[str, int]]] = {}
    if task_ids:
        rows = await db.execute(
            select(
                AiCandidate.task_id,
                AiCandidate.label_name,
                func.count(AiCandidate.id),
                func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)),
            )
            .join(Task, Task.id == AiCandidate.task_id)
            .join(scope, scope.c.id == Task.id)
            .where(AiCandidate.round_no == Task.round_no)
            .group_by(AiCandidate.task_id, AiCandidate.label_name)
        )
        for task_id, label_name, n, n_pending in rows.all():
            c = cand_counts.setdefault(task_id, {"n": 0, "pending": 0})
            c["n"] += int(n)
            c["pending"] += int(n_pending or 0)
            cand_labels.setdefault(task_id, {})[label_name] = {
                "n": int(n), "pending": int(n_pending or 0)}

    _lap("cands")
    # 被驳回的任务把审核意见带出来，标注员一看就知道要改什么，不用另外去问审核员
    rejected_ids = [] if lite else [t.id for t in tasks if t.status == TaskStatus.REJECTED]
    review_comments: dict[int, str | None] = {}
    if rejected_ids:
        rows = await db.execute(
            select(ReviewRecord.task_id, ReviewRecord.comment)
            .join(Task, Task.id == ReviewRecord.task_id)
            .where(ReviewRecord.task_id.in_(rejected_ids), ReviewRecord.round_no == Task.round_no)
        )
        review_comments = dict(rows.all())

    _lap("review")
    # 样本编号 + 指派人名字：非管理员拿不到 /samples、/users，列表里不能只给 ID。
    # 同样用 JOIN 子查询取，不拼上万个 sample_id 的 IN 列表
    brief_rows = await db.execute(
        select(
            Sample.id, Sample.sample_code, Sample.video_duration_sec,
            Sample.imu_row_count, Sample.dog_id, Sample.video_cam1_path,
        )
        .join(Task, Task.sample_id == Sample.id)
        .join(scope, scope.c.id == Task.id)
        .distinct()
    )
    dog_map = await imu_dog_map()
    site_map = await site_imu_dog_map()
    _brief_rows = brief_rows.all()
    dog_names = await dog_names_by_id(db, {r[4] for r in _brief_rows if r[4] is not None})
    briefs = {
        sid: {
            "sample_code": code,
            "video_duration_sec": dur,
            "imu_row_count": rows_n,
            "dog_label": dog_label_of(code, dog_names.get(dog_id), dog_map, site_map, cam1),
        }
        for sid, code, dur, rows_n, dog_id, cam1 in _brief_rows
    }
    user_names: dict[int, str] = {}
    user_roles: dict[int, str] = {}
    if tasks:
        uids = {t.assigned_to for t in tasks if t.assigned_to is not None} | {
            t.reclaimed_from for t in tasks if t.reclaimed_from is not None}
        if uids:
            rows = await db.execute(select(User.id, User.display_name, User.username, User.role).where(User.id.in_(uids)))
            for uid, dn, un, role in rows.all():
                user_names[uid] = dn or un
                user_roles[uid] = role.value if hasattr(role, "value") else str(role)

    _lap("briefs")
    if time.perf_counter() - _t0 > 2:
        logger.warning("tasks-timing n=%d project=%s total=%.2fs %s", len(tasks), project_id,
                       time.perf_counter() - _t0, " ".join(_laps))
    return ok(
        [
            {
                **TaskOut.model_validate(t).model_dump(),
                "has_draft": draft_counts.get(t.id, 0) > 0,
                "draft_item_count": draft_counts.get(t.id, 0),
                "label_counts": label_counts.get(t.id, {}),
                "overlap_count": overlap_counts.get(t.id, 0),
                "overlap_by_label": overlap_by_label.get(t.id, {}),
                "cand_count": cand_counts.get(t.id, {}).get("n", 0),
                "cand_pending": cand_counts.get(t.id, {}).get("pending", 0),
                # 候选按类别分：{类别名: {n, pending}}。项目页要按它筛、要列出
                # 「疑似抓挠里实有哪些类别」——项目全量标签列表里大半是没有的
                "cand_labels": cand_labels.get(t.id, {}),
                "review_comment": review_comments.get(t.id),
                **briefs.get(t.sample_id, {}),
                "assigned_to_name": user_names.get(t.assigned_to) if t.assigned_to is not None else None,
                "assigned_to_role": user_roles.get(t.assigned_to) if t.assigned_to is not None else None,
                "reclaimed_from_name": user_names.get(t.reclaimed_from) if t.reclaimed_from is not None else None,
            }
            for t in tasks
        ]
    )


@router.get("/progress")
async def tasks_progress(mine: bool = False, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """每个项目的完成情况（片段总数 / AI 给的还没人确认的、疑似总数 / 没判的），按项目汇总好再回。

    任务页的项目行要这个数，以前是把**全部任务**连同每个任务的片段统计、重叠、候选一起拉下来
    在前端加（1.1 万个任务十几秒，经常超过 15 秒的请求超时）。这里只做两次按项目的聚合。
    口径跟 list_tasks 里的 label_counts / cand_counts 一样（只算当前轮、只算看得到的任务）。
    mine：只算指派给我的（任务页「只看我的」）"""
    scoped = apply_task_scope(select(Task.id), user)
    if mine:
        scoped = scoped.where(Task.assigned_to == user.id)
    scope = scoped.subquery()
    ai_pending = case(
        ((AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
         & (AnnotationLabelItem.ai_confirmed.is_(False))
         & (AnnotationLabelItem.is_modified.is_(False))
         & (AnnotationLabelItem.uncertain.is_(False)), 1),
        else_=0,
    )
    out: dict[int, dict[str, int]] = {}

    def row(pid: int) -> dict[str, int]:
        return out.setdefault(int(pid), {"segs": 0, "seg_pending": 0, "cands": 0, "cand_pending": 0})

    seg_rows = await db.execute(
        select(Task.project_id, func.count(AnnotationLabelItem.id), func.sum(ai_pending))
        .join(scope, scope.c.id == Task.id)
        .join(AnnotationRecord, (AnnotationRecord.task_id == Task.id) & (AnnotationRecord.round_no == Task.round_no))
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .group_by(Task.project_id)
    )
    for pid, n, n_pending in seg_rows.all():
        r = row(pid)
        r["segs"], r["seg_pending"] = int(n), int(n_pending or 0)
    cand_rows = await db.execute(
        select(Task.project_id, func.count(AiCandidate.id),
               func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)))
        .join(scope, scope.c.id == Task.id)
        .join(AiCandidate, (AiCandidate.task_id == Task.id) & (AiCandidate.round_no == Task.round_no))
        .group_by(Task.project_id)
    )
    for pid, n, n_pending in cand_rows.all():
        r = row(pid)
        r["cands"], r["cand_pending"] = int(n), int(n_pending or 0)
    return ok({str(k): v for k, v in out.items()})


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


@router.post("/{task_id}/edit-again")
async def edit_again_api(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """提交之后自己再改：回到标注中、锁给自己，轮次和片段不变（见 edit_again）"""
    try:
        task = await edit_again(db, task_id, user)
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
    # 从疑似片段确认来的：附上那条候选当初猜的类别和来源，界面上显示「疑似舔 → 活动」
    cand_ids = {i.from_candidate_id for i in items if i.from_candidate_id}
    cands = {}
    if cand_ids:
        cands = {cid: (name, reason) for cid, name, reason in (await db.execute(
            select(AiCandidate.id, AiCandidate.label_name, AiCandidate.reason).where(AiCandidate.id.in_(cand_ids))
        )).all()}
    out = []
    for i in items:
        d = LabelItemOut.model_validate(i).model_dump()
        if i.from_candidate_id in cands:
            name, reason = cands[i.from_candidate_id]
            d["cand_label_name"], d["cand_reason"] = name, getattr(reason, "value", reason)
        out.append(d)
    return ok(DraftOut(round_no=task.round_no, items=out,
                       server_time=datetime.now().isoformat(timespec="microseconds")).model_dump())


@router.put("/{task_id}/draft")
async def put_draft(
    task_id: int,
    body: DraftSaveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        loaded_at = body.loaded_at.replace(tzinfo=None) if body.loaded_at else None
        record = await save_draft(db, task_id, user, body.items, loaded_at)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    # kept_others > 0：有片段刚被别人（管理员）改过，保留了他的版本，前端要重新拉一遍
    return ok({"kept_others": getattr(record, "kept_others", 0)}, msg="草稿已保存")


@router.post("/{task_id}/submit")
async def submit(task_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        task = await submit_task(db, task_id, user)
    except TaskConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ok(TaskOut.model_validate(task).model_dump())
