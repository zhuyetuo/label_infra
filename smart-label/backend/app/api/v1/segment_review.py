"""
片段审核：审核、退回、修改的最小单位是**一条片段**，不是一整个任务。

为什么要它：人手少，不可能把所有项目的片段都标完、审完再用。实际要做的是
「重点补某几类想识别的数据」——挑一个类别（比如 抓挠-头颈耳），跨所有项目、所有
任务把这一类片段一条条看：起止准不准、类别对不对、有没有混进别的动作。
通过的才算高质量数据；导出训练集可以只要这些（scope=seg_approved）。

流程：
  审核员 / 管理员  选类别 → 领一批（领了别人看不到，过期自动放回）→ 逐条
                   「通过」/「退回（写原因）」/ 直接改好起止或类别再通过
  标注员          「退回给我的片段」里逐条改；改了起止 / 类别就自动回到待审，
                   没改也确认没问题的点「改好了」
原来按整个任务提交 / 审核的流程照旧，两套并存。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import label_tree
from app.services.task_scope import exclude_sensitive, is_privileged

router = APIRouter(prefix="/segments", tags=["segment-review"])

STATUSES = ("pending", "returned", "approved")
# 领一批默认留多久：一个人一天审得完；过了还没处理就放回去给别人
CLAIM_HOURS = 24


def _now() -> datetime:
    return datetime.now()


def _decided_at() -> datetime:
    """ai_candidates.decided_at 这一列按 UTC 存（跟工作台里的决定、提交时间一致），
    读的时候统一 +本地时差。别的 DATETIME 列（touched_at 等）是库本地时间，别混用。"""
    return datetime.now(UTC).replace(tzinfo=None)


def _is_reviewer(user: User) -> bool:
    return user.role in (UserRole.admin, UserRole.super_admin, UserRole.reviewer)


def _base(user: User):
    """当前轮、活跃项目、不是「待定」的片段，按角色限范围。"""
    q = (
        select(AnnotationLabelItem, Task, Sample.sample_code, Project.name)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .join(Sample, Sample.id == Task.sample_id)
        .join(Project, Project.id == Task.project_id)
        .where(
            AnnotationRecord.round_no == Task.round_no,
            Project.is_active.is_(True),
            AnnotationLabelItem.uncertain.is_(False),
        )
    )
    if is_privileged(user):
        return q
    q = exclude_sensitive(q, user)
    if user.role == UserRole.reviewer:
        return q
    # 标注员：只看自己名下任务里的片段（「退回给我的」）
    return q.where(Task.assigned_to == user.id)


def _touched():
    """人碰过的片段：点过「通过」、改过、或者本来就是人加的。没人看过的纯 AI 片段不进审核。"""
    return or_(
        AnnotationLabelItem.ai_confirmed.is_(True),
        AnnotationLabelItem.is_modified.is_(True),
        AnnotationLabelItem.source_type == LabelItemSource.human_added,
    )


def _status_cond(s: str):
    if s == "pending":
        # 打了 🔖 备忘的「先放着」，不进待审队列（清掉备忘就回来）
        return AnnotationLabelItem.seg_status.is_(None) & AnnotationLabelItem.marks.is_(None)
    return AnnotationLabelItem.seg_status == s


def _free_for(user_id: int):
    """没被别人领着的：没人领、领了过期了、或者就是自己领的。"""
    return or_(
        AnnotationLabelItem.seg_claimed_by.is_(None),
        AnnotationLabelItem.seg_claim_expires_at < _now(),
        AnnotationLabelItem.seg_claimed_by == user_id,
    )


def _mine(user_id: int):
    return and_(AnnotationLabelItem.seg_claimed_by == user_id, AnnotationLabelItem.seg_claim_expires_at >= _now())


async def _label_ids(db: AsyncSession, label_id: int | None, label_name: str | None = None) -> set[int] | None:
    """要审的类别 → 标签 id。按**名字**跨项目找：标签是每个项目各一套的，同一个
    「抓挠-头颈耳」在每个项目里 id 都不一样，按 id 只能审一个项目。
    选了「抓挠」也包括它底下的「抓挠-头颈耳」这些细类。"""
    if label_name:
        ids = set((await db.execute(
            select(LabelDefinition.id).where(LabelDefinition.display_name == label_name))).scalars().all())
        return await label_tree.expand_ids(db, ids) if ids else {-1}
    if label_id is None:
        return None
    return await label_tree.expand_ids(db, {label_id})


_DUR = AnnotationLabelItem.end_time_ms - AnnotationLabelItem.start_time_ms


def _order(order: str):
    """long = 最长的先（长片段往往更干净，先审先进数据池）；默认按任务、时间顺序"""
    if order == "long":
        return (_DUR.desc(), AnnotationLabelItem.id)
    return (Task.id, AnnotationLabelItem.start_time_ms)


def _filters(q, *, label_ids, source: str, project_id: int | None, min_sec: float | None = None):
    if min_sec:
        q = q.where(_DUR >= int(min_sec * 1000))
    if label_ids is not None:
        q = q.where(AnnotationLabelItem.label_id.in_(label_ids))
    if source != "all":
        q = q.where(_touched())
    if project_id:
        q = q.where(Task.project_id == project_id)
    return q


@router.get("/returned-summary")
async def returned_summary(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """退回给我、还没改好的片段有多少，按项目分。

    给标注员的红色数字用（左侧菜单「退回的片段」、项目列表每一行）：审核员退回了
    几十条，不用再私聊一个个通知。标注员只算自己名下任务里的；管理员 / 审核员按可见范围算。"""
    rows = (await db.execute(
        _base(user).where(_status_cond("returned"))
        .with_only_columns(Task.project_id, func.count())
        .group_by(Task.project_id)
    )).all()
    by_project = {int(pid): int(n) for pid, n in rows}
    return ok({"total": sum(by_project.values()), "by_project": by_project})


@router.get("/queue")
async def queue(
    label_id: int | None = None,
    label_name: str | None = None,
    seg_status: str = "pending",
    source: str = "touched",
    project_id: int | None = None,
    mine: bool = False,
    limit: int = 300,
    min_sec: float | None = None,
    order: str = "time",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """片段列表 + 各状态的条数。mine = 只看我领着的。"""
    if seg_status not in (*STATUSES, "all"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "seg_status 只能是 pending / returned / approved / all")
    label_ids = await _label_ids(db, label_id, label_name)
    base = _filters(_base(user), label_ids=label_ids, source=source, project_id=project_id, min_sec=min_sec)

    q = base
    if seg_status != "all":
        q = q.where(_status_cond(seg_status))
    if mine:
        q = q.where(_mine(user.id))
    elif _is_reviewer(user) and seg_status == "pending":
        # 待审的只列没被别人领走的，免得两个人审同一条
        q = q.where(_free_for(user.id))
    rows = (await db.execute(q.order_by(*_order(order)).limit(max(1, min(limit, 2000))))).all()

    # 各状态多少条（同样的类别 / 来源 / 项目筛选），给页面顶上那排数字
    counts: dict[str, int] = {}
    sub = base.with_only_columns(AnnotationLabelItem.seg_status, func.count()).group_by(AnnotationLabelItem.seg_status)
    for st, n in (await db.execute(sub)).all():
        counts[st or "pending"] = counts.get(st or "pending", 0) + int(n)
    mine_n = (await db.execute(base.with_only_columns(func.count()).where(_mine(user.id)))).scalar_one()

    names = await _label_names(db)
    uids = {r[0].seg_claimed_by for r in rows} | {r[0].seg_reviewed_by for r in rows} | {r[0].review_flag_by for r in rows}
    unames = await _user_names(db, {u for u in uids if u})
    return ok({
        "counts": {s: counts.get(s, 0) for s in STATUSES},
        "mine": int(mine_n),
        "items": [_out(it, task, code, pname, names, unames) for it, task, code, pname in rows],
    })


def _out(it: AnnotationLabelItem, task: Task, sample_code: str, project_name: str,
         names: dict[int, str], unames: dict[int, str]) -> dict:
    claimed = it.seg_claimed_by if (it.seg_claim_expires_at and it.seg_claim_expires_at >= _now()) else None
    return {
        "id": it.id,
        "task_id": task.id,
        "task_status": task.status.value if hasattr(task.status, "value") else str(task.status),
        "project_id": task.project_id,
        "project_name": project_name,
        "sample_code": sample_code,
        "label_id": it.label_id,
        "label_name": names.get(it.label_id, f"#{it.label_id}"),
        "start_time_ms": it.start_time_ms,
        "end_time_ms": it.end_time_ms,
        "source_type": it.source_type.value if hasattr(it.source_type, "value") else str(it.source_type),
        "ai_confirmed": bool(it.ai_confirmed),
        "is_modified": bool(it.is_modified),
        "ai_confidence": it.ai_confidence,
        "from_candidate_id": it.from_candidate_id,
        "seg_status": it.seg_status or "pending",
        "review_note": it.review_note,
        "review_flag_by_name": unames.get(it.review_flag_by) if it.review_flag_by else None,
        "seg_reviewed_by_name": unames.get(it.seg_reviewed_by) if it.seg_reviewed_by else None,
        "seg_reviewed_at": it.seg_reviewed_at.isoformat(sep=" ", timespec="minutes") if it.seg_reviewed_at else None,
        "claimed_by": claimed,
        "claimed_by_name": unames.get(claimed) if claimed else None,
        "n_boundary_edits": (it.boundary_edits or "").count('"from"'),
    }


async def _label_names(db: AsyncSession) -> dict[int, str]:
    return {i: n for i, n in (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name))).all()}


async def _user_names(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = (await db.execute(select(User.id, User.display_name, User.username).where(User.id.in_(ids)))).all()
    return {i: dn or un for i, dn, un in rows}


class ClaimIn(BaseModel):
    label_id: int | None = None
    # 按名字跨项目领（推荐）；label_id 只领那一个项目的
    label_name: str | None = None
    n: int = Field(30, ge=1, le=500)
    source: str = "touched"
    project_id: int | None = None
    hours: int = Field(CLAIM_HOURS, ge=1, le=168)
    # 只领不短于这么多秒的；order=long 从最长的领起
    min_sec: float | None = Field(None, ge=0)
    order: str = "time"


@router.post("/claim")
async def claim(body: ClaimIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """按类别领一批待审的片段。领了别人在列表里就看不到这些；过期没审完自动放回。"""
    if not _is_reviewer(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能领片段来审")
    if body.label_id is None and not body.label_name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "先选要审的类别")
    label_ids = await _label_ids(db, body.label_id, body.label_name)
    q = _filters(_base(user), label_ids=label_ids, source=body.source, project_id=body.project_id, min_sec=body.min_sec)
    # 只领还没人领（或领了过期）的；自己已经领着的不重复算
    q = q.where(_status_cond("pending"),
                or_(AnnotationLabelItem.seg_claimed_by.is_(None), AnnotationLabelItem.seg_claim_expires_at < _now()))
    ids = [r[0] for r in (await db.execute(
        q.with_only_columns(AnnotationLabelItem.id).order_by(*_order(body.order)).limit(body.n)
    )).all()]
    if ids:
        await db.execute(
            update(AnnotationLabelItem)
            .where(AnnotationLabelItem.id.in_(ids))
            .values(seg_claimed_by=user.id, seg_claim_expires_at=_now() + timedelta(hours=body.hours))
            .execution_options(synchronize_session=False)
        )
        await db.commit()
    return ok({"claimed": len(ids)})


class ReleaseIn(BaseModel):
    ids: list[int] | None = None


@router.post("/release")
async def release(body: ReleaseIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """把我领着的（全部或指定几条）放回去。"""
    stmt = update(AnnotationLabelItem).where(AnnotationLabelItem.seg_claimed_by == user.id)
    if body.ids:
        stmt = stmt.where(AnnotationLabelItem.id.in_(body.ids))
    r = await db.execute(stmt.values(seg_claimed_by=None, seg_claim_expires_at=None)
                         .execution_options(synchronize_session=False))
    await db.commit()
    return ok({"released": r.rowcount})


async def _load(db: AsyncSession, item_id: int, user: User) -> tuple[AnnotationLabelItem, Task]:
    row = (await db.execute(_base(user).where(AnnotationLabelItem.id == item_id))).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "片段不存在、不在当前这一轮，或者你看不到")
    return row[0], row[1]


def _check_not_taken(it: AnnotationLabelItem, user: User) -> None:
    # 管理员 / 超级管理员不受「别人领着」限制：复查别人审过的、直接改直接通过（领着的人那边会重新拉到）
    if user.role in (UserRole.admin, UserRole.super_admin):
        return
    if it.seg_claimed_by and it.seg_claimed_by != user.id and it.seg_claim_expires_at and it.seg_claim_expires_at >= _now():
        raise HTTPException(status.HTTP_409_CONFLICT, "这条被别人领去审了")


class DecideIn(BaseModel):
    # approved = 通过 / returned = 退回（要写原因）/ pending = 回到待审（标注员改好了、或撤回结论）
    decision: str
    note: str | None = Field(None, max_length=300)


@router.post("/{item_id}/decide")
async def decide(item_id: int, body: DecideIn, db: AsyncSession = Depends(get_db),
                 user: User = Depends(get_current_user)):
    it, task = await _load(db, item_id, user)
    now = _now()
    if body.decision in ("approved", "returned"):
        if not _is_reviewer(user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能通过或退回片段")
        _check_not_taken(it, user)
        if body.decision == "returned":
            note = (body.note or "").strip()
            if not note:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "退回要写原因（起止不准 / 类别错了 / 混了别的动作…）")
            it.review_note, it.review_flag_by, it.review_flag_at = note, user.id, now
        else:
            it.review_note = it.review_flag_by = it.review_flag_at = None
            # 审核通过的 AI 片段就算确认过了（不然按片段导出时它还是"没人看过"）
            if it.source_type == LabelItemSource.ai_generated and not it.is_modified:
                it.ai_confirmed = True
        it.seg_status = body.decision
        it.seg_reviewed_by, it.seg_reviewed_at = user.id, now
        # 重新通过 = 重新认可：之前手动移出数据池的作废，跟着「通过」回到池里
        if body.decision == "approved" and it.pool_state == "out":
            it.pool_state = None
        it.seg_claimed_by = it.seg_claim_expires_at = None
    elif body.decision == "pending":
        # 标注员：退回给我的这条改好了（或者看过确认没问题），交回去重审
        if not _is_reviewer(user) and task.assigned_to != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "这条不在你名下")
        it.seg_status = None
        it.review_note = it.review_flag_by = it.review_flag_at = None
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "decision 只能是 approved / returned / pending")
    it.touched_at, it.touched_by = now, user.id
    await db.commit()
    return ok({"id": it.id, "seg_status": it.seg_status or "pending"})


class EditIn(BaseModel):
    start_time_ms: int = Field(..., ge=0)
    end_time_ms: int = Field(..., ge=0)
    label_id: int | None = None


class SendBackIn(BaseModel):
    note: str | None = Field(None, max_length=300)


@router.post("/{item_id}/send-back-reviewer")
async def send_back_to_reviewer(item_id: int, body: SendBackIn, db: AsyncSession = Depends(get_db),
                                user: User = Depends(get_current_user)):
    """复查发现别人「通过」的这条有问题：撤销通过、领给原来通过它的人（3 天），让他自己重审。
    只有管理员 / 超级管理员能做。note 写进备忘备注，他打开就能看到为什么退回。"""

    if user.role not in (UserRole.admin, UserRole.super_admin):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有管理员能退回别人通过的片段")
    it, _task = await _load(db, item_id, user)
    if it.seg_status != "approved" or not it.seg_reviewed_by:
        raise HTTPException(status.HTTP_409_CONFLICT, "这条不是审核通过的，没有可以退回的人")
    who = it.seg_reviewed_by
    now = _now()
    it.seg_status = None
    it.seg_reviewed_by = it.seg_reviewed_at = None
    it.seg_claimed_by, it.seg_claim_expires_at = who, now + timedelta(days=3)
    if it.pool_state == "in":
        it.pool_state = None
    note = (body.note or "").strip()
    if note:
        it.mark_note = f"复查退回：{note}"[:300]
    it.touched_at, it.touched_by = now, user.id
    await db.commit()
    return ok({"id": it.id, "sent_to": who, "seg_status": "pending"})


@router.put("/{item_id}")
async def edit(item_id: int, body: EditIn, db: AsyncSession = Depends(get_db),
               user: User = Depends(get_current_user)):
    """在片段审核里直接改起止 / 类别。审核员改完接着「通过」；标注员改了就自动交回待审。"""
    from app.services.task_service import _append_boundary_edit

    if body.end_time_ms - body.start_time_ms < 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "结束要比开始晚至少 0.1 秒")
    it, task = await _load(db, item_id, user)
    reviewer = _is_reviewer(user)
    if not reviewer and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这条不在你名下")
    if reviewer:
        _check_not_taken(it, user)
    # 有人正开着这个任务在标也照样改：他下次存草稿时，前端拉草稿之后别人改过的片段
    # 不会被他手里的旧版本覆盖（save_draft 的 loaded_at），他那边会重新拉到这里改的
    if body.label_id is not None:
        exists = (await db.execute(select(LabelDefinition.id).where(
            LabelDefinition.id == body.label_id, LabelDefinition.project_id == task.project_id))).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这个项目里没有这个标签")
    span_changed = (it.start_time_ms, it.end_time_ms) != (body.start_time_ms, body.end_time_ms)
    label_changed = body.label_id is not None and body.label_id != it.label_id
    if span_changed:
        it.boundary_edits = _append_boundary_edit(
            it.boundary_edits, (it.start_time_ms, it.end_time_ms), (body.start_time_ms, body.end_time_ms), user)
        it.start_time_ms, it.end_time_ms = body.start_time_ms, body.end_time_ms
    if label_changed:
        it.label_id = body.label_id
    if span_changed or label_changed:
        if it.source_type == LabelItemSource.ai_generated:
            it.is_modified = True
            it.ai_confirmed = False
        it.touched_at, it.touched_by = _now(), user.id
        if it.pool_state == "in":
            it.pool_state = None          # 手动加进数据池的，改过就要重新认可
        if not reviewer:
            # 标注员改了就算处理过退回意见，交回待审
            it.seg_status = None
            it.review_note = it.review_flag_by = it.review_flag_at = None
        else:
            # 审核员 / 管理员亲手改的就是认可的版本：直接算通过（进数据池），不用再点一次「通过」
            it.seg_status = "approved"
            it.seg_reviewed_by, it.seg_reviewed_at = user.id, _now()
            it.review_note = it.review_flag_by = it.review_flag_at = None
            it.seg_claimed_by = it.seg_claim_expires_at = None
    await db.commit()
    return ok({"id": it.id, "start_time_ms": it.start_time_ms, "end_time_ms": it.end_time_ms,
               "label_id": it.label_id, "seg_status": it.seg_status or "pending"})


class MarksIn(BaseModel):
    marks: list[str] = Field(default_factory=list)
    note: str | None = Field(None, max_length=300)


@router.put("/{item_id}/marks")
async def set_marks(item_id: int, body: MarksIn, db: AsyncSession = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """打标记（复合类别 / 边界拿不准 / 画面跟 IMU 对不上 / 其它）。只看不改的时候也能打：
    标记只是记号，不动类别起止、不改审核状态。任务的标注员和审核员 / 管理员能打"""
    from app.services.task_service import clean_marks

    it, task = await _load(db, item_id, user)
    if not _is_reviewer(user) and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这条不在你名下")
    it.marks = clean_marks(",".join(body.marks))
    it.mark_note = (body.note or "").strip()[:300] or None
    await db.commit()
    return ok({"id": it.id, "marks": it.marks, "mark_note": it.mark_note})


class SplitIn(BaseModel):
    at_ms: int = Field(..., ge=0)


SPLIT_MIN_MS = 300


@router.delete("/{item_id}")
async def delete_item(item_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """删掉一条片段（重复的、标错不要的）。审核员 / 管理员不用认领，标注员只能删自己名下任务里的。

    标注员正开着这个任务也照样删：他下次存草稿时，前端拉草稿之后被删掉的片段不会被他手里
    的旧版本重建回来（save_draft 的 loaded_at）。
    从「疑似片段」确认来的那条，对应候选一起标成「排除」——不然打开工作台时「补回确认过的
    候选」会按候选再建一条回来。"""
    from app.models.ai_candidate import AiCandidate, CandidateStatus

    it, task = await _load(db, item_id, user)
    if not _is_reviewer(user) and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这条不在你名下")
    if it.from_candidate_id is not None:
        cand = await db.get(AiCandidate, it.from_candidate_id)
        if cand is not None and cand.status == CandidateStatus.confirmed:
            cand.status = CandidateStatus.rejected
            cand.decided_by, cand.decided_at = user.id, _decided_at()
    await db.delete(it)
    await db.commit()
    return ok({"id": item_id, "deleted": True})


class DedupeIn(BaseModel):
    task_id: int


@router.post("/dedupe")
async def dedupe(body: DedupeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    task = await db.get(Task, body.task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    if not _is_reviewer(user) and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这个任务不在你名下")
    out = await _dedupe_task(db, task, user)
    await db.commit()
    return ok(out)


@router.post("/carve-motion")
async def carve_motion(body: DedupeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """把压在具体行为（抓挠/舔/啃…）下面的「活动 / 静止/休息」按重叠处挖空切分成多段，
    让列表与波形跟标注习惯一致，方便逐段核对和调边界。"""
    task = await db.get(Task, body.task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    if not _is_reviewer(user) and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这个任务不在你名下")
    out = await _carve_motion_task(db, task, user)
    await db.commit()
    return ok(out)


class MergeAdjacentIn(BaseModel):
    task_id: int
    groups: list[list[int]] = Field(..., min_length=1)


@router.post("/merge-adjacent")
async def merge_adjacent(body: MergeAdjacentIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """把用户确认的一组或多组相邻同类别片段合并成一条（起止取并集），
    保留最靠谱那条的记录与审核状态，其余条目删掉并妥善处理候选来源。"""
    from app.models.ai_candidate import AiCandidate, CandidateStatus
    from app.services.task_service import _append_boundary_edit

    task = await db.get(Task, body.task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在")
    if not _is_reviewer(user) and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这个任务不在你名下")

    items = (await db.execute(
        select(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no)
    )).scalars().all()
    by_id = {x.id: x for x in items}
    now = _now()

    def rank(x: AnnotationLabelItem):
        human = bool(x.ai_confirmed or x.is_modified or x.source_type == LabelItemSource.human_added)
        return (x.seg_status == "approved", human, x.end_time_ms - x.start_time_ms, -x.id)

    deleted: set[int] = set()
    cand_to_reject: set[int] = set()
    n_groups = 0
    n_removed = 0

    for raw_ids in body.groups:
        uniq = list(dict.fromkeys(i for i in raw_ids if i in by_id and i not in deleted))
        if len(uniq) < 2:
            continue
        grp = [by_id[i] for i in uniq]
        if len({x.label_id for x in grp}) != 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "只能合并同一类别的片段")
        keeper = max(grp, key=rank)
        old = (keeper.start_time_ms, keeper.end_time_ms)
        keeper.start_time_ms = min(x.start_time_ms for x in grp)
        keeper.end_time_ms = max(x.end_time_ms for x in grp)
        keeper.uncertain = all(x.uncertain for x in grp)
        # 合并备忘标记（去重保序）
        merged_marks: list[str] = []
        for x in grp:
            for mk in (x.marks or "").split(","):
                mk = mk.strip()
                if mk and mk not in merged_marks:
                    merged_marks.append(mk)
        if merged_marks:
            keeper.marks = ",".join(merged_marks)
        # 组里只要全部或主条原本已通过，继续保持通过；不把全是待审的强行标成通过
        if all(x.seg_status == "approved" for x in grp):
            keeper.seg_status = "approved"
        if (keeper.start_time_ms, keeper.end_time_ms) != old:
            keeper.boundary_edits = _append_boundary_edit(
                keeper.boundary_edits, old, (keeper.start_time_ms, keeper.end_time_ms), user
            )
            if keeper.source_type == LabelItemSource.ai_generated:
                keeper.is_modified = True
            keeper.touched_at, keeper.touched_by = now, user.id
        for x in grp:
            if x is keeper:
                continue
            deleted.add(x.id)
            n_removed += 1
            if x.from_candidate_id is not None:
                if keeper.from_candidate_id is None:
                    keeper.from_candidate_id = x.from_candidate_id
                else:
                    cand_to_reject.add(x.from_candidate_id)
        n_groups += 1

    for x in items:
        if x.id in deleted:
            await db.delete(x)
    for cid in cand_to_reject:
        cand = await db.get(AiCandidate, cid)
        if cand is not None and cand.status == CandidateStatus.confirmed:
            cand.status = CandidateStatus.rejected
            cand.decided_by, cand.decided_at = user.id, _decided_at()
    await db.commit()
    return ok({"groups_merged": n_groups, "removed": n_removed})


class DedupeProjectIn(BaseModel):
    project_id: int


@router.post("/dedupe-project")
async def dedupe_project(body: DedupeProjectIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """整个项目一键去重：每个任务（当前这一轮）各跑一遍上面那套，只给审核员 / 管理员。
    返回合计 + 动过的任务，同类别冲突（要人看画面的）只报数"""
    if not _is_reviewer(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能整个项目去重")
    tasks = (await db.execute(select(Task).where(Task.project_id == body.project_id).order_by(Task.id))).scalars().all()
    tot = {"tasks": len(tasks), "tasks_changed": 0, "merged": 0, "removed_parent": 0, "conflicts_left": 0, "changed": []}
    for t in tasks:
        r = await _dedupe_task(db, t, user)
        # 每个任务做完就提交：原来整个项目几百个任务在一个事务里，做完才提交——
        # 这期间被改到的片段全锁着，别人点「保存起止」/ 存草稿要干等锁（几十秒），全部项目一起去重时全站卡住
        await db.commit()
        tot["merged"] += r["merged"]
        tot["removed_parent"] += r["removed_parent"]
        tot["conflicts_left"] += r["conflicts_left"]
        if r["merged"] or r["removed_parent"]:
            tot["tasks_changed"] += 1
            tot["changed"].append({"task_id": t.id, **r})
    await db.commit()
    return ok(tot)


def _subtract_spans(
    start_ms: int,
    end_ms: int,
    cutters: list[tuple[int, int]],
    min_piece_ms: int = 300,
) -> list[tuple[int, int]]:
    """从 [start_ms, end_ms] 中挖掉所有 cutters 区间，保留时长 ≥ min_piece_ms 的剩余子段。"""
    clipped = sorted(
        (max(start_ms, cs), min(end_ms, ce))
        for cs, ce in cutters
        if min(end_ms, ce) > max(start_ms, cs)
    )
    if not clipped:
        return [(start_ms, end_ms)]
    merged: list[list[int]] = []
    for cs, ce in clipped:
        if merged and cs <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], ce)
        else:
            merged.append([cs, ce])
    out: list[tuple[int, int]] = []
    cur = start_ms
    for cs, ce in merged:
        if cs - cur >= min_piece_ms:
            out.append((cur, cs))
        cur = max(cur, ce)
    if end_ms - cur >= min_piece_ms:
        out.append((cur, end_ms))
    return out


async def _carve_motion_task(db: AsyncSession, task: Task, user: User) -> dict:
    """把当前这一轮里压在具体行为（behavior / 无轨具体行为）下面的 motion 轨（活动 / 静止/休息）
    按重叠区间挖空切分成多段。保留原来的来源、置信度、审核状态，不擅自标通过。"""
    from app.services.label_tracks import OVERLAP_MIN_MS, track_of
    from app.services.task_service import _append_boundary_edit

    items = (await db.execute(
        select(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no)
        .order_by(AnnotationLabelItem.start_time_ms, AnnotationLabelItem.id)
    )).scalars().all()
    if not items:
        return {"carved": 0, "created": 0, "removed": 0}
    labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == task.project_id))).scalars().all()
    parent_of = {l.id: l.parent_id for l in labels}
    own = {l.id: l.track for l in labels}
    names = {l.id: getattr(l, "display_name", "") for l in labels}

    def _is_rest_name(name: str) -> bool:
        s = (name or "").strip()
        return s in {"静止/休息", "静止", "休息", "睡觉", "睡眠"} or s.startswith("静止/")

    def _is_activity_name(name: str) -> bool:
        s = (name or "").strip()
        return s == "活动" or s.startswith("活动-")

    behaviors = [
        (x.start_time_ms, x.end_time_ms)
        for x in items
        if track_of(parent_of, own, x.label_id, names) in ("behavior", "")
    ]
    activities = [
        (x.start_time_ms, x.end_time_ms)
        for x in items
        if track_of(parent_of, own, x.label_id, names) == "motion" and _is_activity_name(names.get(x.label_id, ""))
    ]
    if not behaviors and not activities:
        return {"carved": 0, "created": 0, "removed": 0}

    now = _now()
    carved = 0
    created = 0
    removed = 0
    for m in items:
        if track_of(parent_of, own, m.label_id, names) != "motion":
            continue
        # 静止/休息 既让位给具体行为，也让位给 活动（重叠部分归活动）
        cutters = (behaviors + activities) if _is_rest_name(names.get(m.label_id, "")) else behaviors
        hits = [
            (bs, be)
            for bs, be in cutters
            if min(m.end_time_ms, be) - max(m.start_time_ms, bs) >= OVERLAP_MIN_MS
        ]
        if not hits:
            continue
        pieces = _subtract_spans(m.start_time_ms, m.end_time_ms, hits, min_piece_ms=SPLIT_MIN_MS)
        carved += 1
        if not pieces:
            await db.delete(m)
            removed += 1
            continue
        old = (m.start_time_ms, m.end_time_ms)
        m.start_time_ms, m.end_time_ms = pieces[0]
        if (m.start_time_ms, m.end_time_ms) != old:
            m.boundary_edits = _append_boundary_edit(m.boundary_edits, old, (m.start_time_ms, m.end_time_ms), user)
            if m.source_type == LabelItemSource.ai_generated:
                m.is_modified = True
            m.touched_at, m.touched_by = now, user.id
        for ps, pe in pieces[1:]:
            db.add(AnnotationLabelItem(
                annotation_record_id=m.annotation_record_id,
                label_id=m.label_id,
                start_time_ms=ps,
                end_time_ms=pe,
                source_type=m.source_type,
                ai_confidence=m.ai_confidence,
                ai_confirmed=m.ai_confirmed,
                is_modified=True if m.source_type == LabelItemSource.ai_generated else m.is_modified,
                uncertain=m.uncertain,
                uncertain_reason=m.uncertain_reason,
                marks=m.marks,
                mark_note=m.mark_note,
                seg_status=m.seg_status,
                seg_reviewed_by=m.seg_reviewed_by,
                seg_reviewed_at=m.seg_reviewed_at,
                created_by=m.created_by,
                touched_at=now,
                touched_by=user.id,
            ))
            created += 1
    await db.flush()
    return {"carved": carved, "created": created, "removed": removed}


async def _dedupe_task(db: AsyncSession, task: Task, user: User, approve: bool = True) -> dict:
    """一键去重（当前这一轮）：
      · 同一类别互相重叠（≥0.2s）的：并成一条，起止取并集。留「最靠谱」的那条——审核通过的 >
        人确认 / 改过 / 人加的 > 时长长的，其余删掉
      · 父子类别压在一起（抓挠 + 抓挠-躯干），细的盖住了粗的八成以上：删粗的
      · 同一轨的不同类别（类别冲突）不动：得人看画面判断，只报个数
    审核员 / 管理员不用认领；标注员只能动自己名下的。并过之后起止变了的，跟片段接口的改一样处理
    （审核员改的算通过；改了就离开手动加入的数据池）。
    approve=False：只合并、不把改过的段标成审核通过（训练数据集里的一键去重用）。
    数据集是旧快照，去重不等于有人看过内容，顺手标通过会把没人复审的数据混进数据池。"""
    from app.models.ai_candidate import AiCandidate, CandidateStatus
    from app.services.label_tracks import OVERLAP_MIN_MS, conflict_checker, track_of
    from app.services.task_service import _append_boundary_edit

    reviewer = _is_reviewer(user)
    items = (await db.execute(
        select(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no)
    )).scalars().all()
    labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == task.project_id))).scalars().all()
    parent_of = {l.id: l.parent_id for l in labels}
    own = {l.id: l.track for l in labels}
    now = _now()

    def rank(x: AnnotationLabelItem):
        human = bool(x.ai_confirmed or x.is_modified or x.source_type == LabelItemSource.human_added)
        return (x.seg_status == "approved", human, x.end_time_ms - x.start_time_ms, -x.id)

    deleted: set[int] = set()
    cand_to_reject: set[int] = set()

    def drop(x: AnnotationLabelItem, keeper: AnnotationLabelItem | None):
        deleted.add(x.id)
        if x.from_candidate_id is not None:
            # 出处挪给留下的那条（它没有的话），不然打开工作台「补回确认过的候选」会按候选再建一条
            if keeper is not None and keeper.from_candidate_id is None:
                keeper.from_candidate_id = x.from_candidate_id
            else:
                cand_to_reject.add(x.from_candidate_id)

    def touched(x: AnnotationLabelItem, old: tuple[int, int]):
        if (x.start_time_ms, x.end_time_ms) == old:
            return
        x.boundary_edits = _append_boundary_edit(x.boundary_edits, old, (x.start_time_ms, x.end_time_ms), user)
        if x.source_type == LabelItemSource.ai_generated:
            x.is_modified = True
        x.touched_at, x.touched_by = now, user.id
        if x.pool_state == "in":
            x.pool_state = None
        # 起止变了，之前的人工复审结论作废——要重新看一眼
        x.pool_review = None
        x.pool_review_by = x.pool_review_at = None
        if reviewer and approve:
            x.seg_status = "approved"
            x.seg_reviewed_by, x.seg_reviewed_at = user.id, now
        else:
            x.seg_status = None

    # 1) 同类别重叠的并成一条
    n_merged = 0
    by_label: dict[int, list[AnnotationLabelItem]] = {}
    for x in items:
        by_label.setdefault(x.label_id, []).append(x)
    for group in by_label.values():
        group.sort(key=lambda x: x.start_time_ms)
        cluster: list[AnnotationLabelItem] = []
        end = -1

        def flush():
            nonlocal n_merged
            if len(cluster) < 2:
                return
            keeper = max(cluster, key=rank)
            old = (keeper.start_time_ms, keeper.end_time_ms)
            keeper.start_time_ms = min(c.start_time_ms for c in cluster)
            keeper.end_time_ms = max(c.end_time_ms for c in cluster)
            keeper.uncertain = all(c.uncertain for c in cluster)
            for c in cluster:
                if c is not keeper:
                    drop(c, keeper)
                    n_merged += 1
            touched(keeper, old)

        for x in group:
            if cluster and x.start_time_ms <= end - OVERLAP_MIN_MS:
                cluster.append(x)
                end = max(end, x.end_time_ms)
            else:
                flush()
                cluster, end = [x], x.end_time_ms
        flush()

    # 2) 父子类别重叠（≥0.2s）：
    #    - 粗类只跟同一种细类有交集（如 抓挠 15s + 抓挠-头颈耳 7s）：合并成一条细类，起止取并集
    #    - 粗类同时压着多种不同细类（如 抓挠-头颈耳 + 抓挠-躯干）：细类合计盖住粗类八成以上时删粗类
    def ancestors(i: int) -> set[int]:
        out: set[int] = set()
        cur = parent_of.get(i)
        while cur is not None and cur not in out:
            out.add(cur)
            cur = parent_of.get(cur)
        return out

    alive = [x for x in items if x.id not in deleted]
    n_parent = 0
    for coarse in alive:
        if coarse.id in deleted:
            continue
        dur = max(1, coarse.end_time_ms - coarse.start_time_ms)
        fines = [
            fine for fine in alive
            if fine.id not in deleted
            and fine is not coarse
            and coarse.label_id in ancestors(fine.label_id)
            and min(coarse.end_time_ms, fine.end_time_ms) - max(coarse.start_time_ms, fine.start_time_ms) >= OVERLAP_MIN_MS
        ]
        if not fines:
            continue
        if len({f.label_id for f in fines}) == 1:
            keeper = max(fines, key=rank)
            old = (keeper.start_time_ms, keeper.end_time_ms)
            group_all = [coarse, *fines]
            keeper.start_time_ms = min(x.start_time_ms for x in group_all)
            keeper.end_time_ms = max(x.end_time_ms for x in group_all)
            keeper.uncertain = all(x.uncertain for x in group_all)
            # 若粗段原本已审核通过，合并后的细段在 approve=True 时继续保持通过
            if coarse.seg_status == "approved" and keeper.seg_status != "approved" and approve:
                keeper.seg_status = "approved"
                keeper.seg_reviewed_by, keeper.seg_reviewed_at = user.id, now
            drop(coarse, keeper)
            n_parent += 1
            for f in fines:
                if f is not keeper:
                    drop(f, keeper)
                    n_merged += 1
            touched(keeper, old)
        else:
            # 多种不同细类盖在粗类上：算细类并集覆盖粗类的比例，≥80% 删粗类保留各细类
            spans = sorted(
                (max(coarse.start_time_ms, f.start_time_ms), min(coarse.end_time_ms, f.end_time_ms))
                for f in fines
            )
            cov, cur_end = 0, -1
            for s0, e0 in spans:
                if s0 > cur_end:
                    cov += e0 - s0
                    cur_end = e0
                elif e0 > cur_end:
                    cov += e0 - cur_end
                    cur_end = e0
            if cov >= 0.8 * dur:
                drop(coarse, fines[0])
                n_parent += 1

    for x in items:
        if x.id in deleted:
            await db.delete(x)
    for cid in cand_to_reject:
        cand = await db.get(AiCandidate, cid)
        if cand is not None and cand.status == CandidateStatus.confirmed:
            cand.status = CandidateStatus.rejected
            cand.decided_by, cand.decided_at = user.id, _decided_at()
    await db.flush()
    carve_res = await _carve_motion_task(db, task, user)

    # 3) 剩下的同轨不同类冲突：在运动轨挖空（含休息让位给活动）后再统计
    conflicts = conflict_checker(labels)
    alive = (await db.execute(
        select(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no)
        .order_by(AnnotationLabelItem.start_time_ms, AnnotationLabelItem.id)
    )).scalars().all()
    conflict_ids: set[int] = set()
    for i, a in enumerate(alive):
        for b in alive[i + 1:]:
            if b.start_time_ms >= a.end_time_ms:
                break
            if min(a.end_time_ms, b.end_time_ms) - b.start_time_ms < OVERLAP_MIN_MS:
                continue
            if track_of(parent_of, own, a.label_id) == track_of(parent_of, own, b.label_id) and conflicts(a.label_id, b.label_id):
                conflict_ids.update((a.id, b.id))

    return {
        "merged": n_merged,
        "removed_parent": n_parent,
        "carved_motion": carve_res["carved"],
        "conflicts_left": len(conflict_ids),
    }


class CreateIn(BaseModel):
    task_id: int
    label_id: int
    start_time_ms: int = Field(..., ge=0)
    end_time_ms: int = Field(..., ge=0)


@router.post("/create")
async def create(body: CreateIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """审核员 / 管理员在「查看标注」（只读）里直接补一段，不用认领整个任务。

    直接落进当前这一轮的记录；跟「直接改」一样，亲手标的就算认可的版本——直接通过。
    标注员正开着这个任务也不怕：touched_by 是别人、touched_at 在他拉草稿之后，
    他下次存草稿不会把这条当成「前端没有」删掉（save_draft 的 loaded_at）。"""
    from app.services.task_service import _get_or_create_record

    if not _is_reviewer(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能在查看里直接新建片段，标注员请先认领任务")
    if body.end_time_ms - body.start_time_ms < 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "结束要比开始晚至少 0.1 秒")
    q = (select(Task).join(Project, Project.id == Task.project_id)
         .where(Task.id == body.task_id, Project.is_active.is_(True)))
    task = (await db.execute(exclude_sensitive(q, user))).scalar_one_or_none()
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "任务不存在，或者你看不到")
    exists = (await db.execute(select(LabelDefinition.id).where(
        LabelDefinition.id == body.label_id, LabelDefinition.project_id == task.project_id))).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这个项目里没有这个标签")
    rec = await _get_or_create_record(db, task)
    now = _now()
    it = AnnotationLabelItem(
        annotation_record_id=rec.id,
        label_id=body.label_id,
        start_time_ms=body.start_time_ms,
        end_time_ms=body.end_time_ms,
        source_type=LabelItemSource.human_added,
        is_modified=False,
        ai_confirmed=False,
        uncertain=False,
        created_by=user.id,
        touched_at=now,
        touched_by=user.id,
        seg_status="approved",
        seg_reviewed_by=user.id,
        seg_reviewed_at=now,
    )
    db.add(it)
    await db.commit()
    return ok({"id": it.id, "start_time_ms": it.start_time_ms, "end_time_ms": it.end_time_ms,
               "label_id": it.label_id, "seg_status": "approved"})


@router.post("/{item_id}/split")
async def split(item_id: int, body: SplitIn, db: AsyncSession = Depends(get_db),
                user: User = Depends(get_current_user)):
    """把一条片段从 at_ms 拆成两条（审核员要求「应该拆成几段」时用）。类别不变，
    左半段是原来那条（起止调整记一笔），右半段新建。两条都回到待审：
    标注员拆完就算处理了退回意见；审核员拆完再对两条各自下结论。"""
    from app.services.task_service import _append_boundary_edit

    it, task = await _load(db, item_id, user)
    reviewer = _is_reviewer(user)
    if not reviewer and task.assigned_to != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "这条不在你名下")
    if reviewer:
        _check_not_taken(it, user)
    at = body.at_ms
    if at - it.start_time_ms < SPLIT_MIN_MS or it.end_time_ms - at < SPLIT_MIN_MS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "拆分点离起点或终点太近（两边至少 0.3 秒）")
    now = _now()
    old_end = it.end_time_ms
    it.boundary_edits = _append_boundary_edit(it.boundary_edits, (it.start_time_ms, old_end), (it.start_time_ms, at), user)
    it.end_time_ms = at
    if it.source_type == LabelItemSource.ai_generated:
        it.is_modified = True
        it.ai_confirmed = False
    it.seg_status = None
    if it.pool_state == "in":
        it.pool_state = None
    it.review_note = it.review_flag_by = it.review_flag_at = None
    it.seg_claimed_by = it.seg_claim_expires_at = None
    it.touched_at, it.touched_by = now, user.id
    right = AnnotationLabelItem(
        annotation_record_id=it.annotation_record_id,
        label_id=it.label_id,
        start_time_ms=at,
        end_time_ms=old_end,
        source_type=LabelItemSource.human_added,
        is_modified=False,
        ai_confirmed=False,
        uncertain=False,
        created_by=user.id,
        touched_at=now,
        touched_by=user.id,
    )
    db.add(right)
    await db.commit()
    return ok({"left": {"id": it.id, "start_time_ms": it.start_time_ms, "end_time_ms": it.end_time_ms},
               "right": {"id": right.id, "start_time_ms": right.start_time_ms, "end_time_ms": right.end_time_ms},
               "label_id": it.label_id})
