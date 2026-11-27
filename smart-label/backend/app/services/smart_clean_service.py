"""项目批量智能处理服务：
1. 每日定时（及手动）快速检测全部启用项目，统计有多少项目/任务需要：
   - 智能挖洞（行为 / 未佩戴 / 无信号压住活动，活动压住静止/休息）
   - 自动去重（同类重叠 + 父子粗类）
   - 自动合并（相邻 ≤1.5s 同类碎片）
   并把检测报告落盘，页面打开即提示用户按需点击处理。
2. 后台异步批量处理（去无信号 → 智能挖洞 → 去重 → 合并 → 再去重 → 再合并 → 终轮挖洞），
   按任务实时更新进度与预计剩余时间，支持随时取消，处理完自动刷新检测报告。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User
from app.services.label_tracks import OVERLAP_MIN_MS, conflict_checker, track_of

logger = logging.getLogger("smart-label.smart_clean")

_SCAN_FILE = os.path.join(settings.nas_root, "data_labeled_ai", "_smart_clean_scan.json")
_ZERO_CACHE_FILE = os.path.join(settings.nas_root, "data_labeled_ai", "_zero_signal_cache.json")


def _load_zero_cache() -> dict[str, dict]:
    try:
        if os.path.isfile(_ZERO_CACHE_FILE):
            with open(_ZERO_CACHE_FILE, encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception:  # noqa: BLE001
        pass
    return {}


def _save_zero_cache(cache: dict[str, dict]) -> None:
    try:
        os.makedirs(os.path.dirname(_ZERO_CACHE_FILE), exist_ok=True)
        tmp = _ZERO_CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, _ZERO_CACHE_FILE)
    except Exception as e:  # noqa: BLE001
        logger.warning("保存无信号 CSV 缓存失败: %s", e)


def _scan_zero_worker(args: tuple[str, str, int]) -> tuple[str, float, int, list[list[int]]]:
    """多进程 worker：扫描单个 CSV 的三轴全 0 断流区间。"""
    nas_root, rel_path, min_zero_ms = args
    from app.services import imu_service

    full_path = os.path.join(nas_root, rel_path.lstrip("/"))
    try:
        st = os.stat(full_path)
        spans = imu_service.find_zero_signal_spans(full_path, None, None, min_zero_ms)
        return rel_path, st.st_mtime, st.st_size, [[int(s), int(e)] for s, e in spans]
    except Exception:  # noqa: BLE001
        return rel_path, 0.0, 0, []

_running = False
_cancel_req = False
_progress: dict = {
    "status": "idle",
    "projects_total": 0,
    "projects_done": 0,
    "tasks_total": 0,
    "tasks_done": 0,
    "current_project": None,
    "started_at": None,
    "finished_at": None,
    "elapsed_sec": 0,
    "eta_sec": None,
    "error": None,
    "summary": {
        "tasks_changed": 0,
        "zero_runs": 0,
        "zero_carved": 0,
        "zero_deleted": 0,
        "no_signal_added": 0,
        "carved_motion": 0,
        "dedupe_merged": 0,
        "removed_parent": 0,
        "adj_groups_merged": 0,
        "adj_removed": 0,
        "conflicts_left": 0,
    },
}


def get_progress() -> dict:
    p = dict(_progress)
    p["summary"] = dict(_progress["summary"])
    if p["status"] == "running" and p["started_at"]:
        elapsed = max(1, int(time.time() - p["started_at"]))
        p["elapsed_sec"] = elapsed
        done = int(p["tasks_done"] or 0)
        tot = int(p["tasks_total"] or 0)
        if done > 0 and tot > done:
            p["eta_sec"] = int(elapsed * (tot - done) / done)
        else:
            p["eta_sec"] = None
    return p


def request_cancel() -> bool:
    global _cancel_req
    if not _running:
        return False
    _cancel_req = True
    return True


def load_cached_scan() -> dict | None:
    try:
        if os.path.isfile(_SCAN_FILE):
            with open(_SCAN_FILE, encoding="utf-8") as f:
                return json.load(f)
    except Exception:  # noqa: BLE001
        pass
    return None


def _save_scan(report: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_SCAN_FILE), exist_ok=True)
        tmp = _SCAN_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False)
        os.replace(tmp, _SCAN_FILE)
    except Exception as e:  # noqa: BLE001
        logger.warning("保存智能检测报告失败: %s", e)


def _is_rest_name(name: str) -> bool:
    s = (name or "").strip()
    return s in {"静止/休息", "静止", "休息", "睡觉", "睡眠"} or s.startswith("静止/")


def _is_activity_name(name: str) -> bool:
    s = (name or "").strip()
    return s == "活动" or s.startswith("活动-")


async def scan_all_projects(db: AsyncSession, max_gap_ms: int = 1500) -> dict:
    """快速扫描所有启用项目的当前轮次片段，统计可智能挖洞 / 去重 / 合并的项目与任务数。"""
    t0 = time.time()
    projects = (await db.execute(
        select(Project).where(Project.is_active.is_(True)).order_by(Project.id)
    )).scalars().all()
    if not projects:
        rep = {
            "scanned_at": datetime.now().isoformat(timespec="seconds"),
            "elapsed_sec": 0.0,
            "projects_total": 0,
            "projects_need_clean": 0,
            "tasks_total": 0,
            "tasks_need_clean": 0,
            "n_carve": 0,
            "n_dedupe": 0,
            "n_merge": 0,
            "n_conflicts": 0,
            "project_ids": [],
            "by_project": [],
        }
        _save_scan(rep)
        return rep

    pids = [p.id for p in projects]
    pname = {p.id: p.name for p in projects}

    labels = (await db.execute(
        select(LabelDefinition).where(LabelDefinition.project_id.in_(pids))
    )).scalars().all()
    labels_by_proj: dict[int, list[LabelDefinition]] = defaultdict(list)
    for lb in labels:
        labels_by_proj[lb.project_id].append(lb)

    rows = (await db.execute(
        select(
            Task.project_id,
            Task.id,
            AnnotationLabelItem.id,
            AnnotationLabelItem.label_id,
            AnnotationLabelItem.start_time_ms,
            AnnotationLabelItem.end_time_ms,
            AnnotationLabelItem.uncertain,
        )
        .join(AnnotationRecord, (AnnotationRecord.task_id == Task.id) & (AnnotationRecord.round_no == Task.round_no))
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .where(Task.project_id.in_(pids))
    )).all()

    tasks_by_proj: dict[int, dict[int, list[tuple[int, int, int, int, bool]]]] = defaultdict(lambda: defaultdict(list))
    for pid, tid, iid, lid, s_ms, e_ms, unc in rows:
        tasks_by_proj[pid][tid].append((iid, lid, int(s_ms), int(e_ms), bool(unc)))

    total_tasks = 0
    tasks_need_clean = 0
    tot_carve = 0
    tot_dedupe = 0
    tot_merge = 0
    tot_conflicts = 0
    by_project: list[dict] = []

    for pid in pids:
        tmap = tasks_by_proj.get(pid)
        if not tmap:
            continue
        plabs = labels_by_proj.get(pid, [])
        parent_of = {l.id: l.parent_id for l in plabs}
        own = {l.id: l.track for l in plabs}
        names = {l.id: (l.display_name or "") for l in plabs}
        ltrack = {l.id: track_of(parent_of, own, l.id, names) for l in plabs}
        conflicts_fn = conflict_checker(plabs)

        anc_cache: dict[int, set[int]] = {}
        for l in plabs:
            anc: set[int] = set()
            cur = parent_of.get(l.id)
            while cur is not None and cur not in anc:
                anc.add(cur)
                cur = parent_of.get(cur)
            anc_cache[l.id] = anc

        p_tasks_need = 0
        p_carve = 0
        p_dedupe = 0
        p_merge = 0
        p_conf = 0

        for _tid, segs in tmap.items():
            total_tasks += 1
            if len(segs) < 2:
                continue
            segs.sort(key=lambda x: (x[2], x[3]))

            # 1) 智能挖洞检查
            behaviors = [(s, e) for _, lid, s, e, _ in segs if ltrack.get(lid) in ("behavior", "", "device")]
            activities = [(s, e) for _, lid, s, e, _ in segs if ltrack.get(lid) == "motion" and _is_activity_name(names.get(lid, ""))]
            t_carve = 0
            if behaviors or activities:
                for _, lid, s, e, _ in segs:
                    if ltrack.get(lid) != "motion":
                        continue
                    cutters = (behaviors + activities) if _is_rest_name(names.get(lid, "")) else behaviors
                    if any(min(e, be) - max(s, bs) >= OVERLAP_MIN_MS for bs, be in cutters):
                        t_carve += 1

            # 2) 去重 & 冲突检查
            t_dedupe = 0
            t_conf = 0
            n = len(segs)
            for i in range(n):
                _, lid1, s1, e1, _ = segs[i]
                tr1 = ltrack.get(lid1)
                for j in range(i + 1, n):
                    _, lid2, s2, e2, _ = segs[j]
                    if s2 >= e1:
                        break
                    if min(e1, e2) - s2 < OVERLAP_MIN_MS:
                        continue
                    if lid1 == lid2 or lid1 in anc_cache.get(lid2, ()) or lid2 in anc_cache.get(lid1, ()):
                        t_dedupe += 1
                    elif tr1 == ltrack.get(lid2) and conflicts_fn(lid1, lid2):
                        t_conf += 1

            # 3) 相邻合并检查
            by_lid: dict[int, list[tuple[int, int]]] = defaultdict(list)
            for _, lid, s, e, unc in segs:
                if not unc:
                    by_lid[lid].append((s, e))
            t_merge = 0
            for lid, arr in by_lid.items():
                if len(arr) < 2:
                    continue
                my_tr = ltrack.get(lid)
                in_grp = False
                for k in range(len(arr) - 1):
                    gap_lo, gap_hi = arr[k][1], arr[k + 1][0]
                    gap = gap_hi - gap_lo
                    if 0 <= gap <= max_gap_ms:
                        blocked = False
                        if gap_hi > gap_lo:
                            for _, olid, os0, oe0, _ in segs:
                                if olid == lid or min(oe0, gap_hi) <= max(os0, gap_lo):
                                    continue
                                otr = ltrack.get(olid)
                                if (
                                    otr == "device"
                                    or (my_tr is not None and otr == my_tr)
                                    or (my_tr == "motion" and otr == "behavior")
                                    or (my_tr == "behavior" and otr == "motion")
                                ):
                                    blocked = True
                                    break
                        if not blocked:
                            if not in_grp:
                                t_merge += 1
                                in_grp = True
                        else:
                            in_grp = False
                    else:
                        in_grp = False

            if t_carve or t_dedupe or t_merge:
                p_tasks_need += 1
                p_carve += t_carve
                p_dedupe += t_dedupe
                p_merge += t_merge
            p_conf += t_conf

        if p_tasks_need > 0:
            tasks_need_clean += p_tasks_need
            tot_carve += p_carve
            tot_dedupe += p_dedupe
            tot_merge += p_merge
            by_project.append({
                "project_id": pid,
                "project_name": pname.get(pid, f"#{pid}"),
                "tasks_need": p_tasks_need,
                "n_carve": p_carve,
                "n_dedupe": p_dedupe,
                "n_merge": p_merge,
                "n_conflicts": p_conf,
            })
        tot_conflicts += p_conf

    by_project.sort(key=lambda x: x["tasks_need"], reverse=True)
    report = {
        "scanned_at": datetime.now().isoformat(timespec="seconds"),
        "elapsed_sec": round(time.time() - t0, 2),
        "projects_total": len(projects),
        "projects_need_clean": len(by_project),
        "tasks_total": total_tasks,
        "tasks_need_clean": tasks_need_clean,
        "n_carve": tot_carve,
        "n_dedupe": tot_dedupe,
        "n_merge": tot_merge,
        "n_conflicts": tot_conflicts,
        "project_ids": [x["project_id"] for x in by_project],
        "by_project": by_project[:50],
    }
    _save_scan(report)
    return report


async def start_smart_clean(
    project_ids: list[int] | None,
    user_id: int,
    max_gap_ms: int = 1500,
) -> bool:
    """后台启动批量智能处理；若已在运行则返回 False。"""
    global _running, _cancel_req
    if _running:
        return False
    _running = True
    _cancel_req = False
    asyncio.create_task(_run_smart_clean(project_ids, user_id, max_gap_ms))
    return True


async def _run_smart_clean(
    project_ids: list[int] | None,
    user_id: int,
    max_gap_ms: int = 1500,
) -> None:
    global _running, _cancel_req
    from app.api.v1.segment_review import (
        _carve_motion_task,
        _dedupe_task,
        _merge_adjacent_task,
        _trim_zero_signal_task,
    )

    _progress.update({
        "status": "running",
        "projects_total": 0,
        "projects_done": 0,
        "tasks_total": 0,
        "tasks_done": 0,
        "current_project": None,
        "started_at": time.time(),
        "finished_at": None,
        "elapsed_sec": 0,
        "eta_sec": None,
        "error": None,
        "summary": {
            "tasks_changed": 0,
            "zero_runs": 0,
            "zero_carved": 0,
            "zero_deleted": 0,
            "no_signal_added": 0,
            "carved_motion": 0,
            "dedupe_merged": 0,
            "removed_parent": 0,
            "adj_groups_merged": 0,
            "adj_removed": 0,
            "conflicts_left": 0,
        },
    })

    try:
        async with SessionLocal() as db:
            user = await db.get(User, user_id)
            if user is None:
                raise RuntimeError("找不到操作用户")
            pq = select(Project).where(Project.is_active.is_(True)).order_by(Project.id)
            if project_ids:
                pq = pq.where(Project.id.in_(project_ids))
            projects = (await db.execute(pq)).scalars().all()
            pids = [p.id for p in projects]
            pname = {p.id: p.name for p in projects}
            tasks = (await db.execute(
                select(Task).where(Task.project_id.in_(pids)).order_by(Task.project_id, Task.id)
            )).scalars().all() if pids else []

            by_proj: dict[int, list[Task]] = defaultdict(list)
            for t in tasks:
                by_proj[t.project_id].append(t)

            _progress["projects_total"] = len(projects)
            _progress["tasks_total"] = len(tasks)
            s = _progress["summary"]

            # ── 加速步骤 1：2 秒 DB 快速筛出「真正有标注且可能需要处理」的任务 ──
            _progress["current_project"] = "预检数据库（跳过干净任务）..."
            dirty_db_tids: set[int] = set()
            has_items_tids: set[int] = set()
            if pids:
                labels = (await db.execute(
                    select(LabelDefinition).where(LabelDefinition.project_id.in_(pids))
                )).scalars().all()
                labels_by_proj: dict[int, list[LabelDefinition]] = defaultdict(list)
                for lb in labels:
                    labels_by_proj[lb.project_id].append(lb)

                item_rows = (await db.execute(
                    select(
                        Task.project_id,
                        Task.id,
                        AnnotationLabelItem.id,
                        AnnotationLabelItem.label_id,
                        AnnotationLabelItem.start_time_ms,
                        AnnotationLabelItem.end_time_ms,
                        AnnotationLabelItem.uncertain,
                    )
                    .join(AnnotationRecord, (AnnotationRecord.task_id == Task.id) & (AnnotationRecord.round_no == Task.round_no))
                    .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
                    .where(Task.project_id.in_(pids))
                )).all()
                t_segs: dict[tuple[int, int], list[tuple[int, int, int, int, bool]]] = defaultdict(list)
                for pid, tid, iid, lid, s_ms, e_ms, unc in item_rows:
                    has_items_tids.add(tid)
                    t_segs[(pid, tid)].append((iid, lid, int(s_ms), int(e_ms), bool(unc)))

                for pid in pids:
                    plabs = labels_by_proj.get(pid, [])
                    parent_of = {l.id: l.parent_id for l in plabs}
                    own = {l.id: l.track for l in plabs}
                    names = {l.id: (l.display_name or "") for l in plabs}
                    ltrack = {l.id: track_of(parent_of, own, l.id, names) for l in plabs}
                    anc_cache: dict[int, set[int]] = {}
                    for l in plabs:
                        anc: set[int] = set()
                        cur = parent_of.get(l.id)
                        while cur is not None and cur not in anc:
                            anc.add(cur)
                            cur = parent_of.get(cur)
                        anc_cache[l.id] = anc

                    for t in by_proj.get(pid, []):
                        segs = t_segs.get((pid, t.id))
                        if not segs or len(segs) < 2:
                            continue
                        segs.sort(key=lambda x: (x[2], x[3]))
                        # 快速判定是否有挖洞 / 去重 / 合并需求
                        need = False
                        behaviors = [(a, b) for _, lid, a, b, _ in segs if ltrack.get(lid) in ("behavior", "", "device")]
                        activities = [(a, b) for _, lid, a, b, _ in segs if ltrack.get(lid) == "motion" and _is_activity_name(names.get(lid, ""))]
                        if behaviors or activities:
                            for _, lid, a, b, _ in segs:
                                if ltrack.get(lid) != "motion":
                                    continue
                                cutters = (behaviors + activities) if _is_rest_name(names.get(lid, "")) else behaviors
                                if any(min(b, be) - max(a, bs) >= OVERLAP_MIN_MS for bs, be in cutters):
                                    need = True
                                    break
                        if not need:
                            n = len(segs)
                            for i in range(n):
                                _, lid1, s1, e1, _ = segs[i]
                                for j in range(i + 1, n):
                                    _, lid2, s2, e2, _ = segs[j]
                                    if s2 >= e1:
                                        break
                                    if min(e1, e2) - s2 < OVERLAP_MIN_MS:
                                        continue
                                    if lid1 == lid2 or lid1 in anc_cache.get(lid2, ()) or lid2 in anc_cache.get(lid1, ()):
                                        need = True
                                        break
                                if need:
                                    break
                        if not need:
                            by_lid: dict[int, list[tuple[int, int]]] = defaultdict(list)
                            for _, lid, a, b, unc in segs:
                                if not unc:
                                    by_lid[lid].append((a, b))
                            for lid, arr in by_lid.items():
                                if len(arr) < 2:
                                    continue
                                for k in range(len(arr) - 1):
                                    if 0 <= arr[k + 1][0] - arr[k][1] <= max_gap_ms:
                                        need = True
                                        break
                                if need:
                                    break
                        if need:
                            dirty_db_tids.add(t.id)

            # ── 加速步骤 2：按唯一 CSV 去重 + 12 核多进程并行扫无信号 + 持久化磁盘缓存 ──
            sids = list({t.sample_id for t in tasks if t.id in has_items_tids})
            sample_csv: dict[int, str] = {}
            if sids:
                srows = (await db.execute(
                    select(Sample.id, Sample.imu_csv_path).where(Sample.id.in_(sids), Sample.imu_csv_path.is_not(None))
                )).all()
                sample_csv = {sid: p for sid, p in srows if p}

            zero_cache = _load_zero_cache()
            unique_csvs = sorted(set(sample_csv.values()))
            to_scan: list[str] = []
            csv_spans: dict[str, list[tuple[int, int]]] = {}
            for rel in unique_csvs:
                full_p = os.path.join(settings.nas_root, rel.lstrip("/"))
                ent = zero_cache.get(rel)
                try:
                    st = os.stat(full_p)
                    if ent and ent.get("mtime") == st.st_mtime and ent.get("size") == st.st_size:
                        csv_spans[rel] = [(int(a), int(b)) for a, b in (ent.get("spans") or [])]
                        continue
                except OSError:
                    csv_spans[rel] = []
                    continue
                to_scan.append(rel)

            if to_scan and not _cancel_req:
                n_workers = min(12, max(2, (os.cpu_count() or 4) // 2))
                _progress["current_project"] = f"并行检测无信号 CSV (0/{len(to_scan)}，{n_workers}核)..."
                loop = asyncio.get_running_loop()
                batch_sz = 48
                scanned_cnt = 0
                with ProcessPoolExecutor(max_workers=n_workers) as pool:
                    for b0 in range(0, len(to_scan), batch_sz):
                        if _cancel_req:
                            break
                        part = to_scan[b0 : b0 + batch_sz]
                        futs = [loop.run_in_executor(pool, _scan_zero_worker, (settings.nas_root, rel, 300)) for rel in part]
                        res_list = await asyncio.gather(*futs)
                        for rel, mt, sz, spans in res_list:
                            csv_spans[rel] = [(a, b) for a, b in spans]
                            if mt > 0:
                                zero_cache[rel] = {"mtime": mt, "size": sz, "spans": spans}
                        scanned_cnt += len(part)
                        _progress["current_project"] = f"并行检测无信号 CSV ({scanned_cnt}/{len(to_scan)}，{n_workers}核)..."
                _save_zero_cache(zero_cache)

            # ── 加速步骤 3：只对真正有问题的任务执行清洗 + 收敛即停 + 每 20 任务批量提交 ──
            dirty_commit_cnt = 0
            for pid in pids:
                if _cancel_req:
                    break
                _progress["current_project"] = pname.get(pid, f"#{pid}")
                for t in by_proj.get(pid, []):
                    if _cancel_req:
                        break
                    rel = sample_csv.get(t.sample_id)
                    dropouts = csv_spans.get(rel, []) if rel else []
                    has_zero = bool(dropouts) and (t.id in has_items_tids)
                    need_db = t.id in dirty_db_tids

                    if not has_zero and not need_db:
                        _progress["tasks_done"] += 1
                        continue

                    z = await _trim_zero_signal_task(db, t, user, precomputed_dropouts=dropouts) if has_zero else {
                        "zero_runs": 0, "items_carved": 0, "items_deleted": 0, "pieces_created": 0, "no_signal_added": 0,
                    }
                    c1 = await _carve_motion_task(db, t, user)
                    d1 = await _dedupe_task(db, t, user)
                    m1 = await _merge_adjacent_task(db, t, user, max_gap_ms=max_gap_ms)
                    # 收敛剪枝：第一轮合并没改动时，第二轮去重/合并与终轮挖洞必然为空，直接跳过
                    if m1["groups_merged"] > 0:
                        d2 = await _dedupe_task(db, t, user)
                        if d2["merged"] or d2["removed_parent"] or d2.get("carved_motion", 0):
                            m2 = await _merge_adjacent_task(db, t, user, max_gap_ms=max_gap_ms)
                        else:
                            m2 = {"groups_merged": 0, "removed": 0}
                        c2 = await _carve_motion_task(db, t, user)
                    else:
                        d2 = {"merged": 0, "removed_parent": 0, "carved_motion": 0, "conflicts_left": d1["conflicts_left"]}
                        m2 = {"groups_merged": 0, "removed": 0}
                        c2 = {"carved": 0}

                    s["zero_runs"] += z["zero_runs"]
                    s["zero_carved"] += z["items_carved"]
                    s["zero_deleted"] += z["items_deleted"]
                    s["no_signal_added"] += z["no_signal_added"]
                    s["carved_motion"] += c1["carved"] + d1.get("carved_motion", 0) + d2.get("carved_motion", 0) + c2["carved"]
                    s["dedupe_merged"] += d1["merged"] + d2["merged"]
                    s["removed_parent"] += d1["removed_parent"] + d2["removed_parent"]
                    s["adj_groups_merged"] += m1["groups_merged"] + m2["groups_merged"]
                    s["adj_removed"] += m1["removed"] + m2["removed"]
                    s["conflicts_left"] += d2["conflicts_left"]

                    changed = bool(
                        z["items_carved"] or z["items_deleted"] or z["no_signal_added"]
                        or c1["carved"] or c2["carved"]
                        or d1["merged"] or d1["removed_parent"] or d1.get("carved_motion", 0)
                        or m1["groups_merged"]
                        or d2["merged"] or d2["removed_parent"] or d2.get("carved_motion", 0)
                        or m2["groups_merged"]
                    )
                    if changed:
                        s["tasks_changed"] += 1
                    dirty_commit_cnt += 1
                    if dirty_commit_cnt >= 20:
                        await db.commit()
                        dirty_commit_cnt = 0

                    _progress["tasks_done"] += 1
                    await asyncio.sleep(0)
                if dirty_commit_cnt > 0:
                    await db.commit()
                    dirty_commit_cnt = 0
                if not _cancel_req:
                    _progress["projects_done"] += 1

            # 处理完立刻刷新检测报告，让提示条归零
            await scan_all_projects(db, max_gap_ms=max_gap_ms)

        _progress["status"] = "cancelled" if _cancel_req else "done"
    except Exception as e:  # noqa: BLE001
        logger.exception("批量智能处理异常")
        _progress["status"] = "error"
        _progress["error"] = f"{type(e).__name__}: {e}"
    finally:
        _progress["finished_at"] = time.time()
        if _progress["started_at"]:
            _progress["elapsed_sec"] = int(_progress["finished_at"] - _progress["started_at"])
        _progress["eta_sec"] = 0
        _running = False
        _cancel_req = False
