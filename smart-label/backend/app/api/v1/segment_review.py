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
from app.models.task import Task, TaskStatus
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
        return AnnotationLabelItem.seg_status.is_(None)
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


def _filters(q, *, label_ids, source: str, project_id: int | None):
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
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """片段列表 + 各状态的条数。mine = 只看我领着的。"""
    if seg_status not in (*STATUSES, "all"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "seg_status 只能是 pending / returned / approved / all")
    label_ids = await _label_ids(db, label_id, label_name)
    base = _filters(_base(user), label_ids=label_ids, source=source, project_id=project_id)

    q = base
    if seg_status != "all":
        q = q.where(_status_cond(seg_status))
    if mine:
        q = q.where(_mine(user.id))
    elif _is_reviewer(user) and seg_status == "pending":
        # 待审的只列没被别人领走的，免得两个人审同一条
        q = q.where(_free_for(user.id))
    rows = (await db.execute(q.order_by(Task.id, AnnotationLabelItem.start_time_ms).limit(max(1, min(limit, 2000))))).all()

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


@router.post("/claim")
async def claim(body: ClaimIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """按类别领一批待审的片段。领了别人在列表里就看不到这些；过期没审完自动放回。"""
    if not _is_reviewer(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "只有审核员 / 管理员能领片段来审")
    if body.label_id is None and not body.label_name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "先选要审的类别")
    label_ids = await _label_ids(db, body.label_id, body.label_name)
    q = _filters(_base(user), label_ids=label_ids, source=body.source, project_id=body.project_id)
    # 只领还没人领（或领了过期）的；自己已经领着的不重复算
    q = q.where(_status_cond("pending"),
                or_(AnnotationLabelItem.seg_claimed_by.is_(None), AnnotationLabelItem.seg_claim_expires_at < _now()))
    ids = [r[0] for r in (await db.execute(
        q.with_only_columns(AnnotationLabelItem.id).order_by(Task.id, AnnotationLabelItem.start_time_ms).limit(body.n)
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
    # 有人正开着这个任务在标：他下次存草稿会把本地那份旧起止写回来，把这里的改动冲掉
    if (task.status == TaskStatus.IN_PROGRESS and task.locked_by and task.locked_by != user.id
            and task.lock_expires_at and task.lock_expires_at.replace(tzinfo=None) > datetime.now(UTC).replace(tzinfo=None)):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "有人正在工作台里标这个任务，这里改了会被他下次保存冲掉。先让他保存退出，或者到工作台里改")
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
        if not reviewer:
            # 标注员改了就算处理过退回意见，交回待审
            it.seg_status = None
            it.review_note = it.review_flag_by = it.review_flag_at = None
    await db.commit()
    return ok({"id": it.id, "start_time_ms": it.start_time_ms, "end_time_ms": it.end_time_ms,
               "label_id": it.label_id, "seg_status": it.seg_status or "pending"})
