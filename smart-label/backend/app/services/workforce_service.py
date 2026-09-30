"""人力管理：分配台账、每类片段的确认耗时、剩余工作量预估。

三块，回答三个问题：
  台账    9-23 的项目什么时候分给了谁、做到哪了、几天做完的
  效率    这个人确认一段抓挠要多久、判一条疑似要多久、每天出多少活
  预估    按他的速度，这个项目剩下的还要几小时——定的任务量是不是过大

**每段耗时怎么算**：把一个人的动作按时间排成一条流——确认/改/新加一段片段
（annotation_label_items.touched_at）、判一条候选（ai_candidates.decided_at）、
提交任务（annotation_records.submitted_at）——相邻两次动作的间隔归到**后一个**动作
的类别上，间隔超过 GAP_MAX 当作离开了（吃饭、下班），不计。每类取中位数。
比"任务总用时 ÷ 片段数"准：一个任务里各类片段混在一起，平均数会把静止那种
一眼过的和抓挠这种要反复看的抹平。

touched_at 是新加的列，部署之前的片段没有这个时间，只能从部署后开始积累；
候选判定时间一直都有，疑似抓挠的耗时历史数据就能算。
"""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.audit_log import AuditLog
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.annotator_work_service import SCRATCH_PREFIX, local_offset, utc_to_local

GAP_MAX = 10 * 60          # 相邻动作隔了 10 分钟以上，当作人离开了，这段不算工时
CAND_CATEGORY = "疑似抓挠"
SUBMIT_CATEGORY = "提交任务"


def _category(label_name: str) -> str:
    """片段归到哪一类：抓挠-头颈耳 / 抓挠-躯干 都算「抓挠」；别的按一级名（舔-前爪 → 舔）。"""
    if label_name.startswith(SCRATCH_PREFIX):
        return SCRATCH_PREFIX
    return label_name.split("-", 1)[0]


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


async def _events(db: AsyncSession, lo: datetime, hi: datetime) -> list[tuple[int, datetime, str, int]]:
    """[(user_id, 本地时间, 类别, task_id)]，三种动作合在一起，按时间排好。lo/hi 是本地时间。"""
    off = local_offset()
    ev: list[tuple[int, datetime, str, int]] = []
    rows = (await db.execute(
        select(AnnotationLabelItem.touched_by, AnnotationLabelItem.touched_at, LabelDefinition.display_name,
               AnnotationRecord.task_id)
        .join(LabelDefinition, LabelDefinition.id == AnnotationLabelItem.label_id)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .where(AnnotationLabelItem.touched_by.is_not(None), AnnotationLabelItem.touched_at >= lo,
               AnnotationLabelItem.touched_at < hi))).all()
    ev += [(u, t, _category(n), tid) for u, t, n, tid in rows]
    rows = (await db.execute(
        select(AiCandidate.decided_by, AiCandidate.decided_at, AiCandidate.task_id)
        .where(AiCandidate.decided_by.is_not(None), AiCandidate.decided_at >= lo - off,
               AiCandidate.decided_at < hi - off))).all()
    ev += [(u, utc_to_local(t), CAND_CATEGORY, tid) for u, t, tid in rows]
    rows = (await db.execute(
        select(Task.assigned_to, AnnotationRecord.submitted_at, Task.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(Task.assigned_to.is_not(None), AnnotationRecord.submitted_at.is_not(None),
               AnnotationRecord.submitted_at >= lo - off, AnnotationRecord.submitted_at < hi - off))).all()
    ev += [(u, utc_to_local(t), SUBMIT_CATEGORY, tid) for u, t, tid in rows]
    ev.sort(key=lambda e: (e[0], e[1]))
    return ev


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


async def efficiency(db: AsyncSession, date_from: date, date_to: date) -> list[dict]:
    """每个人：各类动作的条数、每条中位耗时、每天的动作数。"""
    lo = datetime.combine(date_from, datetime.min.time())
    hi = datetime.combine(date_to + timedelta(days=1), datetime.min.time())
    ev = await _events(db, lo, hi)
    names = {}
    uids = {e[0] for e in ev}
    if uids:
        names = {uid: (dn or un) for uid, dn, un in (await db.execute(
            select(User.id, User.display_name, User.username).where(User.id.in_(uids)))).all()}
    per_user: dict[int, dict] = {}
    prev: dict[int, datetime] = {}
    for uid, t, cat, _tid in ev:
        u = per_user.setdefault(uid, {"user_id": uid, "user_name": names.get(uid, str(uid)),
                                      "categories": defaultdict(lambda: {"n": 0, "gaps": []}),
                                      "days": defaultdict(lambda: {"actions": 0, "work_seconds": 0.0})})
        c = u["categories"][cat]
        c["n"] += 1
        d = u["days"][t.date().isoformat()]
        d["actions"] += 1
        if uid in prev:
            gap = (t - prev[uid]).total_seconds()
            if 0 <= gap <= GAP_MAX:
                c["gaps"].append(gap)
                d["work_seconds"] += gap
        prev[uid] = t
    out = []
    for u in per_user.values():
        cats = [{"category": k, "n": v["n"], "median_seconds": _median(v["gaps"]),
                 "mean_seconds": round(sum(v["gaps"]) / len(v["gaps"]), 1) if v["gaps"] else None,
                 "n_timed": len(v["gaps"])}
                for k, v in sorted(u["categories"].items(), key=lambda kv: -kv[1]["n"])]
        days = [{"day": k, "actions": v["actions"], "work_seconds": int(v["work_seconds"])}
                for k, v in sorted(u["days"].items())]
        out.append({"user_id": u["user_id"], "user_name": u["user_name"], "categories": cats, "days": days,
                    "total_actions": sum(c["n"] for c in cats),
                    "total_work_seconds": sum(d["work_seconds"] for d in days)})
    out.sort(key=lambda x: -x["total_actions"])
    return out


async def ledger(db: AsyncSession) -> list[dict]:
    """分配台账：一行一个（项目, 标注员）。"""
    rows = (await db.execute(
        select(Task.project_id, Task.assigned_to, func.count(Task.id),
               func.sum(case((Task.status.in_((TaskStatus.SUBMITTED, TaskStatus.APPROVED)), 1), else_=0)),
               func.sum(case((Task.status == TaskStatus.APPROVED, 1), else_=0)),
               func.min(Task.created_at))
        .join(Project, Project.id == Task.project_id)
        .where(Task.assigned_to.is_not(None), Project.is_active.is_(True))
        .group_by(Task.project_id, Task.assigned_to))).all()
    if not rows:
        return []
    pids = {r[0] for r in rows}
    uids = {r[1] for r in rows}
    pnames = dict((await db.execute(select(Project.id, Project.name).where(Project.id.in_(pids)))).all())
    unames = {uid: (dn or un) for uid, dn, un in (await db.execute(
        select(User.id, User.display_name, User.username).where(User.id.in_(uids)))).all()}

    # 分配时间：audit_logs 里的 task.assign（detail 里有 assigned_to）；没有就退回任务创建时间
    assigned_at: dict[tuple[int, int], datetime] = {}
    for pid, det, t in (await db.execute(
            select(AuditLog.target_id, AuditLog.detail, AuditLog.created_at)
            .where(AuditLog.action == "task.assign", AuditLog.target_type == "project",
                   AuditLog.target_id.in_(pids)))).all():
        try:
            uid = int((json.loads(det or "{}") or {}).get("assigned_to"))
        except (TypeError, ValueError):
            continue
        k = (pid, uid)
        if k not in assigned_at or t < assigned_at[k]:
            assigned_at[k] = t

    # 每个（项目, 人）还剩多少：抓挠待确认、疑似待判；最早/最晚动手；最后一次提交
    pending_pairs = (Task.project_id, Task.assigned_to)
    is_scratch = LabelDefinition.display_name.like(f"{SCRATCH_PREFIX}%")
    pend = ((AnnotationLabelItem.source_type == LabelItemSource.ai_generated)
            & (AnnotationLabelItem.ai_confirmed.is_(False)) & (AnnotationLabelItem.is_modified.is_(False))
            & (AnnotationLabelItem.uncertain.is_(False)))
    scratch = {(p, u): (int(n or 0), int(x or 0)) for p, u, n, x in (await db.execute(
        select(*pending_pairs, func.sum(case((is_scratch, 1), else_=0)), func.sum(case((is_scratch & pend, 1), else_=0)))
        .select_from(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .join(LabelDefinition, LabelDefinition.id == AnnotationLabelItem.label_id)
        .where(Task.project_id.in_(pids), Task.assigned_to.is_not(None), AnnotationRecord.round_no == Task.round_no)
        .group_by(*pending_pairs))).all()}
    cands = {(p, u): (int(n), int(x or 0)) for p, u, n, x in (await db.execute(
        select(*pending_pairs, func.count(AiCandidate.id),
               func.sum(case((AiCandidate.status == CandidateStatus.pending, 1), else_=0)))
        .select_from(AiCandidate).join(Task, Task.id == AiCandidate.task_id)
        .where(Task.project_id.in_(pids), Task.assigned_to.is_not(None), AiCandidate.round_no == Task.round_no)
        .group_by(*pending_pairs))).all()}
    touch = {(p, u): (a, b) for p, u, a, b in (await db.execute(
        select(*pending_pairs, func.min(AnnotationLabelItem.touched_at), func.max(AnnotationLabelItem.touched_at))
        .select_from(AnnotationLabelItem)
        .join(AnnotationRecord, AnnotationRecord.id == AnnotationLabelItem.annotation_record_id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(Task.project_id.in_(pids), AnnotationLabelItem.touched_at.is_not(None))
        .group_by(*pending_pairs))).all()}
    decided = {(p, u): (utc_to_local(a), utc_to_local(b)) for p, u, a, b in (await db.execute(
        select(Task.project_id, AiCandidate.decided_by, func.min(AiCandidate.decided_at), func.max(AiCandidate.decided_at))
        .select_from(AiCandidate).join(Task, Task.id == AiCandidate.task_id)
        .where(Task.project_id.in_(pids), AiCandidate.decided_at.is_not(None))
        .group_by(Task.project_id, AiCandidate.decided_by))).all()}
    last_submit = {(p, u): utc_to_local(t) for p, u, t in (await db.execute(
        select(*pending_pairs, func.max(AnnotationRecord.submitted_at))
        .select_from(AnnotationRecord).join(Task, Task.id == AnnotationRecord.task_id)
        .where(Task.project_id.in_(pids), Task.assigned_to.is_not(None), AnnotationRecord.submitted_at.is_not(None))
        .group_by(*pending_pairs))).all()}

    out = []
    for pid, uid, n, done, approved, created in rows:
        k = (pid, uid)
        firsts = [x for x in (touch.get(k, (None, None))[0], decided.get(k, (None, None))[0]) if x]
        lasts = [x for x in (touch.get(k, (None, None))[1], decided.get(k, (None, None))[1], last_submit.get(k)) if x]
        s_total, s_pend = scratch.get(k, (0, 0))
        c_total, c_pend = cands.get(k, (0, 0))
        all_done = int(done or 0) >= int(n) and not s_pend and not c_pend
        started = assigned_at.get(k) or created
        finished = last_submit.get(k) if all_done else None
        out.append({
            "project_id": pid, "project_name": pnames.get(pid, str(pid)),
            "user_id": uid, "user_name": unames.get(uid, str(uid)),
            "tasks_total": int(n), "tasks_submitted": int(done or 0), "tasks_approved": int(approved or 0),
            "scratch_total": s_total, "scratch_pending": s_pend,
            "cand_total": c_total, "cand_pending": c_pend,
            "assigned_at": _iso(started), "assigned_logged": k in assigned_at,
            "first_touch": _iso(min(firsts)) if firsts else None,
            "last_touch": _iso(max(lasts)) if lasts else None,
            "finished_at": _iso(finished),
            "days_used": round(((finished or datetime.now()) - started).total_seconds() / 86400, 1) if started else None,
            "done": all_done,
        })
    out.sort(key=lambda r: (r["done"], (r["project_name"] or ""), r["user_name"]), reverse=True)
    return out


def estimate(ledger_rows: list[dict], eff: list[dict]) -> list[dict]:
    """按每个人实测的每条耗时，算每个（项目, 人）剩下的活还要多久。
    没测到那一类的速度（还没做过、或部署前的数据）就用全员中位数，再没有就空着。"""
    def med_of(user: dict | None, cat: str) -> float | None:
        if not user:
            return None
        for c in user["categories"]:
            if c["category"] == cat and c["median_seconds"] is not None and c["n_timed"] >= 5:
                return c["median_seconds"]
        return None

    by_uid = {e["user_id"]: e for e in eff}
    pool = {cat: _median([v for v in (med_of(e, cat) for e in eff) if v is not None])
            for cat in (SCRATCH_PREFIX, CAND_CATEGORY, SUBMIT_CATEGORY)}
    # 每个任务除了抓挠/疑似之外的收尾（看别的类别、提交）：拿「提交任务」那一类的中位间隔当每任务固定开销
    out = []
    for r in ledger_rows:
        if r["done"]:
            continue
        u = by_uid.get(r["user_id"])
        s_sec = med_of(u, SCRATCH_PREFIX) or pool[SCRATCH_PREFIX]
        c_sec = med_of(u, CAND_CATEGORY) or pool[CAND_CATEGORY]
        t_sec = med_of(u, SUBMIT_CATEGORY) or pool[SUBMIT_CATEGORY]
        tasks_left = r["tasks_total"] - r["tasks_submitted"]
        parts = {
            "scratch": (r["scratch_pending"] * s_sec) if s_sec is not None else None,
            "cand": (r["cand_pending"] * c_sec) if c_sec is not None else None,
            "tasks": (tasks_left * t_sec) if t_sec is not None else None,
        }
        known = [v for v in parts.values() if v is not None]
        # 每天按 6 小时有效标注时间折算成天
        total = sum(known) if known else None
        out.append({
            "project_id": r["project_id"], "project_name": r["project_name"],
            "user_id": r["user_id"], "user_name": r["user_name"],
            "tasks_left": tasks_left, "scratch_pending": r["scratch_pending"], "cand_pending": r["cand_pending"],
            "sec_per_scratch": s_sec, "sec_per_cand": c_sec, "sec_per_task": t_sec,
            "using_pool": {"scratch": med_of(u, SCRATCH_PREFIX) is None, "cand": med_of(u, CAND_CATEGORY) is None,
                           "tasks": med_of(u, SUBMIT_CATEGORY) is None},
            "hours_left": round(total / 3600, 1) if total is not None else None,
            "days_left": round(total / 3600 / 6, 1) if total is not None else None,
            "missing": [k for k, v in parts.items() if v is None],
        })
    return out
