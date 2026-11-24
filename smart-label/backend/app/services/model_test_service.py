"""模型测试集：挑哪些数据给模型「考试」、每段是哪只狗/什么体型/里面标了什么、哪个模型见过它。

几条规矩：
  · 测试集里的样本不进任何训练导出（training_export_service.export_dataset 里排除，按整个样本算）
  · 冻结后不能增删；补数据就复制成新版本再加，报告注明用的哪一版
  · 「见过」= 这个样本出现在模型训练用的数据集（dataset_spec 里的 date / extra_date / extra_datasets）
    导出文件里。导出文件找不到的数据集如实报「不知道」，不猜
"""

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.dog import Dog
from app.models.label import LabelDefinition
from app.models.model_test import ModelTestItem
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.services import dog_name_service as DN
from app.services import site_layout as SL

# 测试关心的四类（按标签树最顶层的名字归），其余归「其他」
TOPS = ("抓挠", "活动", "静止/休息", "未佩戴")
SIZES = ("小", "中", "大")
SHORT_MAX_SEC = 180          # 窗口 ≤ 3 分钟算「短片段」，否则「长片段」
DOG_SHARE_WARN = 0.15        # 一只狗占总时长超过这个比例就提醒（多样性）
LABEL_COVER_MIN = 0.8        # 窗口里标注覆盖低于这个比例就提醒（没标的时间会把模型的报告冤成误报）


def pad_window(start_ms: int, end_ms: int, pad_ms: int, lo: int, hi: int | None) -> tuple[int, int]:
    """把 [start, end] 前后各延长一半凑够 pad_ms（本来就更长就不动）；碰到头尾就往另一边补。
    选了一段 10 秒的抓挠凑成 1 分钟：窗口里有事件前后的上下文，模型报早报晚、起止准不准（交并比）才测得出来"""
    length = end_ms - start_ms
    if pad_ms <= length:
        return start_ms, end_ms
    s = start_ms - (pad_ms - length) // 2
    e = s + pad_ms
    if s < lo:
        s, e = lo, lo + pad_ms
    if hi is not None and e > hi:
        s, e = max(lo, hi - pad_ms), hi
    return s, e


async def task_segments(db: AsyncSession, task_id: int) -> list[dict]:
    """任务当前轮的标注片段（挑事件用）：大类、细类、起止、待定"""
    lrows = (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name, LabelDefinition.parent_id))).all()
    lname = {i: n for i, n, _p in lrows}
    parent = {i: p for i, _n, p in lrows}

    def top(lid: int) -> str:
        cur, seen = lid, set()
        while parent.get(cur) is not None and cur not in seen:
            seen.add(cur)
            cur = parent[cur]
        return lname.get(cur, "?")

    rows = (await db.execute(
        select(AnnotationLabelItem.id, AnnotationLabelItem.label_id, AnnotationLabelItem.start_time_ms,
               AnnotationLabelItem.end_time_ms, AnnotationLabelItem.uncertain)
        .join(AnnotationRecord, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id == task_id, AnnotationRecord.round_no == Task.round_no)
        .order_by(AnnotationLabelItem.start_time_ms)
    )).all()
    return [{"id": i, "top": top(lid), "label": lname.get(lid, "?"), "start_ms": int(s), "end_ms": int(e),
             "uncertain": bool(u)} for i, lid, s, e, u in rows]


EXCLUDE_MARGIN_MS = 60_000   # 测试窗口前后各多挖 60 秒不进训练：训练窗口 4~8 秒，留够余量防「相邻几秒」漏进去


async def test_exclusion(db: AsyncSession) -> tuple[dict[int, list[tuple[int, int]] | None], set[int]]:
    """训练导出要避开的测试数据。
    返回 ({样本 id: [(起, 止) 已加余量] 或 None=整个样本}, 测试集自己的任务 id)。
    片段给了窗口（或任务本身是短任务）就只挖窗口 ±60 秒；整个任务加进来的才整个样本不要——
    第一批从 1 小时的样本里挑 1 分钟，按整个样本排除的话最新几天几百小时数据都进不了训练"""
    rows = (await db.execute(
        select(ModelTestItem.task_id, ModelTestItem.sample_id, ModelTestItem.start_ms, ModelTestItem.end_ms,
               Task.segment_start_ms, Task.segment_end_ms)
        .join(Task, Task.id == ModelTestItem.task_id))).all()
    excl: dict[int, list[tuple[int, int]] | None] = {}
    tasks: set[int] = set()
    for tid, sid, s, e, ts, te in rows:
        if ts is not None:
            tasks.add(tid)      # 专门为测试建的短任务整份不导出；挂在原任务上的（按条件挑的）只挖窗口
        if s is None or e is None:
            s, e = ts, te
        if s is None or e is None:
            excl[sid] = None
            continue
        if sid in excl and excl[sid] is None:
            continue
        excl.setdefault(sid, []).append((max(0, s - EXCLUDE_MARGIN_MS), e + EXCLUDE_MARGIN_MS))
    return excl, tasks


async def test_sample_ids(db: AsyncSession) -> set[int]:
    """所有测试集（冻结没冻结都算）里的样本。训练导出要排除它们。"""
    return set((await db.execute(select(ModelTestItem.sample_id).distinct())).scalars().all())


def datasets_of_spec(spec: str | None) -> list[str]:
    """模型训练记录 dataset_spec 里用到的数据集名。"""
    try:
        d = json.loads(spec or "{}")
    except ValueError:
        return []
    if not isinstance(d, dict):
        return []
    names: list[str] = []
    if isinstance(d.get("date"), str):
        names.append(d["date"])
    names += [x for x in (d.get("extra_date") or []) if isinstance(x, str)]
    names += [x["date"] for x in (d.get("extra_datasets") or []) if isinstance(x, dict) and isinstance(x.get("date"), str)]
    return list(dict.fromkeys(names))


_codes_cache: dict[str, tuple[float, frozenset[str]]] = {}


def dataset_sample_codes(name: str) -> frozenset[str] | None:
    """平台导出的数据集里装了哪些样本（sample_code）。找不到导出文件 None。按文件修改时间缓存。"""
    from app.services import training_export_service as TE
    if not TE._NAME_RE.match(name):
        return None
    path = os.path.join(TE.settings.nas_root, TE.TRAIN_DIR, name, "merged_tmp.json")
    if not os.path.isfile(path):
        return None
    mt = os.path.getmtime(path)
    hit = _codes_cache.get(name)
    if hit and hit[0] == mt:
        return hit[1]
    with open(path, encoding="utf-8") as f:
        tasks = json.load(f)
    codes = frozenset(
        (t.get("data") or {}).get("sample_code") for t in tasks
        if isinstance(t, dict) and (t.get("data") or {}).get("sample_code")
    )
    _codes_cache[name] = (mt, codes)
    return codes


async def describe_items(db: AsyncSession, items: list[ModelTestItem]) -> list[dict]:
    """每段：项目、日期、场地、狗（人工关联 / 按设备推断）、体型、窗口、长短、窗口里标了什么。"""
    if not items:
        return []
    tids = {i.task_id for i in items}
    tasks = {t.id: t for t in (await db.execute(select(Task).where(Task.id.in_(tids)))).scalars().all()}
    samples = {s.id: s for s in (await db.execute(
        select(Sample).where(Sample.id.in_({i.sample_id for i in items})))).scalars().all()}
    pids = {t.project_id for t in tasks.values()}
    projects = dict((await db.execute(select(Project.id, Project.name).where(Project.id.in_(pids)))).all()) if pids else {}
    dogs = {d.id: d for d in (await db.execute(select(Dog))).scalars().all()}
    idx = await DN.dog_index(db)
    prof = await DN.dog_profiles(db)

    lrows = (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name, LabelDefinition.parent_id))).all()
    lname = {i: n for i, n, _p in lrows}
    parent = {i: p for i, _n, p in lrows}

    def top(lid: int) -> str:
        cur, seen = lid, set()
        while parent.get(cur) is not None and cur not in seen:
            seen.add(cur)
            cur = parent[cur]
        n = lname.get(cur, "?")
        return n if n in TOPS else "其他"

    segs: dict[int, list[tuple[str, int, int, bool]]] = defaultdict(list)
    leaf_segs: dict[int, list[tuple[str, int, int]]] = defaultdict(list)
    for tid, lid, s, e, unc in (await db.execute(
        select(AnnotationRecord.task_id, AnnotationLabelItem.label_id, AnnotationLabelItem.start_time_ms,
               AnnotationLabelItem.end_time_ms, AnnotationLabelItem.uncertain)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(tids), AnnotationRecord.round_no == Task.round_no)
    )).all():
        segs[tid].append((top(lid), int(s), int(e), bool(unc)))
        if not unc and parent.get(lid) is not None:
            leaf_segs[tid].append((lname.get(lid, "?"), int(s), int(e)))   # 细类（抓挠-头颈耳…），配额表按部位看

    # 疑似片段（提示窗口里写的那几段）：按任务 / 状态数，列表上显示「疑似 抓挠 1 待判」
    from app.models.ai_candidate import AiCandidate
    cands: dict[int, list[tuple[str, str, int, int]]] = defaultdict(list)
    for tid, name, st, a, b in (await db.execute(
        select(AiCandidate.task_id, AiCandidate.label_name, AiCandidate.status, AiCandidate.start_time_ms,
               AiCandidate.end_time_ms)
        .join(Task, Task.id == AiCandidate.task_id)
        .where(AiCandidate.task_id.in_(tids), AiCandidate.round_no == Task.round_no))).all():
        cands[tid].append((name, getattr(st, "value", str(st)), int(a), int(b)))

    out: list[dict] = []
    for it in items:
        t, s = tasks.get(it.task_id), samples.get(it.sample_id)
        full_ms = int((s.video_duration_sec or 0) * 1000) if s else 0
        ws = it.start_ms if it.start_ms is not None else (t.segment_start_ms if t and t.segment_start_ms is not None else 0)
        we = it.end_ms if it.end_ms is not None else (t.segment_end_ms if t and t.segment_end_ms is not None else full_ms)
        dur = max(0, we - ws) / 1000
        dog_id = None
        site_key = None
        if s:
            dog_id = await DN.sample_dog_id(db, s.sample_code, s.dog_id, s.video_cam1_path, idx=idx, profiles=prof)
            site_key = SL.site_of(s.sample_code, s.imu_csv_path, s.video_cam1_path)
        d = dogs.get(dog_id) if dog_id else None
        labels: dict[str, dict] = {}
        n_uncertain = 0
        spans: list[tuple[int, int]] = []
        for k, a, b, unc in segs.get(it.task_id, []):
            ov = min(b, we) - max(a, ws)
            if ov <= 0:
                continue
            spans.append((max(a, ws), min(b, we)))   # 待定也算「有人看过」
            if unc:
                n_uncertain += 1
                continue
            x = labels.setdefault(k, {"n": 0, "sec": 0.0})
            x["n"] += 1
            x["sec"] = round(x["sec"] + ov / 1000, 1)
        covered, end = 0, None
        for a, b in sorted(spans):
            if end is None or a > end:
                covered += b - a
                end = b
            elif b > end:
                covered += b - end
                end = b
        out.append({
            # 窗口里有多少时间标了东西。测试数据要「窗口内全标」：没标的时间模型报了算误报，
            # 漏标多了精确率就被冤枉（上次 822 段补标就是这么来的）
            "label_cover": round(covered / (we - ws), 3) if we > ws else 0.0,
            "id": it.id, "task_id": it.task_id, "sample_id": it.sample_id,
            "sample_code": s.sample_code if s else None,
            "project_id": t.project_id if t else None, "project_name": projects.get(t.project_id) if t else None,
            "task_status": (t.status.value if hasattr(t.status, "value") else str(t.status)) if t else None,
            "date": s.session_date.isoformat() if s and s.session_date else None,
            "site": (d.site if d else None) or SL.SITES.get(site_key or "", {}).get("name"),
            "dog_id": dog_id, "dog_name": d.name if d else None, "size": d.size if d else None,
            # 人工关联的最准；推断的在带场地的数据上跟人工核对 100% 一致，
            # 但 9 月中以前文件名不带场地的老影棚数据常常对不上，标出来
            "dog_source": "人工" if (s and s.dog_id) else ("推断" if dog_id else None),
            "dog_unsure": bool(s and not s.dog_id and dog_id and site_key is None),
            "start_ms": ws, "end_ms": we, "dur_sec": round(dur, 1),
            "kind": "短片段" if dur <= SHORT_MAX_SEC else "长片段",
            "labels": labels, "n_uncertain": n_uncertain, "note": it.note,
            # 窗口里的疑似片段：{类别: {状态: 条数}}
            "cands": {k: dict(v) for k, v in _cand_count(cands.get(it.task_id, []), ws, we).items()},
            "leaf": dict(Counter(n for n, a, b in leaf_segs.get(it.task_id, []) if a < we and b > ws)),
            # 人工核对过这一段（看过窗口里的片段、该调的调了）。打分可以只用核对过的
            "checked": it.checked_at is not None,
            "checked_at": it.checked_at.isoformat(timespec="minutes") if it.checked_at else None,
        })
    return out


def _cand_count(cs: list[tuple[str, str, int, int]], ws: int, we: int) -> dict[str, Counter]:
    out: dict[str, Counter] = defaultdict(Counter)
    for name, st, a, b in cs:
        if a < we and b > ws:
            out[name][st] += 1
    return out


def coverage(rows: list[dict]) -> dict:
    """配额表：体型 × 四类 的段数 / 事件数 / 秒数，加上长短、狗、场地、日期的分布和多样性提醒。"""
    matrix = {sz: {tp: {"items": 0, "n": 0, "sec": 0.0} for tp in TOPS} for sz in SIZES + ("未知",)}
    dog_sec: Counter = Counter()
    total = 0.0
    kinds, sites, dates = Counter(), Counter(), Counter()
    for r in rows:
        sz = r["size"] if r["size"] in SIZES else "未知"
        for tp in TOPS:
            x = r["labels"].get(tp)
            if x:
                c = matrix[sz][tp]
                c["items"] += 1
                c["n"] += x["n"]
                c["sec"] = round(c["sec"] + x["sec"], 1)
        dog_sec[(r["site"], r["dog_name"])] += r["dur_sec"]
        total += r["dur_sec"]
        kinds[r["kind"]] += 1
        sites[r["site"] or "未知"] += 1
        if r["date"]:
            dates[r["date"]] += 1
    if not any(matrix["未知"][tp]["items"] for tp in TOPS):
        matrix.pop("未知")
    dogs = [{"site": k[0], "dog": k[1], "sec": round(v, 1), "share": round(v / total, 3) if total else 0}
            for k, v in dog_sec.most_common()]
    warns = [f"{x['site'] or ''}{x['dog'] or '未知狗'} 占总时长 {x['share']:.0%}，超过 {DOG_SHARE_WARN:.0%}"
             for x in dogs if x["share"] > DOG_SHARE_WARN and len(dogs) > 1]
    n_low = sum(1 for r in rows if r["label_cover"] < LABEL_COVER_MIN)
    if n_low:
        warns.append(f"{n_low} 段窗口里标注覆盖不到 {LABEL_COVER_MIN:.0%}：测试数据要窗口内全标（休息、活动也标上），"
                     "否则模型在没标的时间里报的都算误报，精确率被冤枉")
    n_unsure = sum(1 for r in rows if r["dog_unsure"])
    if n_unsure:
        warns.append(f"{n_unsure} 段的狗是按设备号推断、而且是老影棚数据（常对不上），按狗/体型统计时不可靠")
    leaf: Counter = Counter()
    for r in rows:
        leaf.update(r.get("leaf") or {})
    return {"n_items": len(rows), "total_sec": round(total, 1), "matrix": matrix, "kinds": dict(kinds),
            "dogs": dogs, "n_dogs": len(dogs), "sites": dict(sites), "dates": dict(sorted(dates.items())),
            "leaf": dict(leaf.most_common()), "n_checked": sum(1 for r in rows if r.get("checked")),
            "warnings": warns}


# ───────────── 按条件挑：从已有的标注片段（人工标过的 / AI 预标的）里挑，凑窗口，加进测试集 ─────────────

async def label_tree_names(db: AsyncSession) -> list[dict]:
    """各项目同名的标签合成一个：[{name, parent}]，给「按条件挑」的类别树用"""
    rows = (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name, LabelDefinition.parent_id))).all()
    name = {i: n for i, n, _ in rows}
    seen: dict[str, str | None] = {}
    for i, n, p in rows:
        if n not in seen or (seen[n] is None and p is not None):
            seen[n] = name.get(p) if p is not None else None
    return [{"name": n, "parent": p} for n, p in sorted(seen.items(), key=lambda x: ((x[1] or x[0]), x[1] is not None, x[0]))]


async def seen_codes_of(model_ids: list[int], db: AsyncSession) -> set[str]:
    from app.models.model_version import ModelVersion
    import asyncio
    codes: set[str] = set()
    for mid in model_ids:
        mv = await db.get(ModelVersion, mid)
        if mv is None:
            continue
        for n in datasets_of_spec(mv.dataset_spec):
            c = await asyncio.to_thread(dataset_sample_codes, n)
            if c:
                codes |= c
    return codes


COMPOSE_ROW_CAP = 400_000


async def compose(db: AsyncSession, *, label_names: list[str], sites: list[str] | None = None,
                  dog_ids: list[int] | None = None, date_from=None, date_to=None, source: str = "any",
                  seen_mode: str = "any", model_ids: list[int] | None = None, per_group: int = 10,
                  max_total: int = 200, pad_sec: float = 60, min_sec: float = 0, set_id: int | None = None,
                  seed: int = 1) -> dict:
    """按条件从已有片段里挑。返回 {picks: [...], stats, warnings}；不写库（写库见 compose_apply）。

    source：human = 人工标过的（任务已提交/通过，或片段是人加 / 人确认 / 人改过的）；ai = 只要 AI 预标的；any = 都要。
    seen_mode：unseen / seen / any，相对 model_ids 的训练数据集（样本级）。
    每组（狗 × 细类）最多 per_group 段，按日期轮着挑；总数最多 max_total（各组轮着取）。
    窗口 = 片段前后延长凑够 pad_sec（碰头尾往另一边补），同一个样本里窗口不重叠，也不跟这个测试集里已有的重叠。"""
    import random
    from app.models.annotation import LabelItemSource
    from app.models.task import TaskStatus
    from app.services import label_tree

    warnings: list[str] = []
    ids = set((await db.execute(select(LabelDefinition.id).where(LabelDefinition.display_name.in_(label_names)))).scalars().all())
    ids = await label_tree.expand_ids(db, ids) if ids else set()
    if not ids:
        return {"picks": [], "stats": {}, "warnings": ["没选类别，或者选的类别没有对应的标签"]}
    lrows = (await db.execute(select(LabelDefinition.id, LabelDefinition.display_name, LabelDefinition.parent_id))).all()
    lname = {i: n for i, n, _ in lrows}

    it = AnnotationLabelItem
    q = (select(it.label_id, it.start_time_ms, it.end_time_ms, it.source_type, it.ai_confirmed, it.is_modified,
                Task.id, Task.status, Sample.id, Sample.sample_code, Sample.video_cam1_path, Sample.imu_csv_path,
                Sample.dog_id, Sample.video_duration_sec, Sample.session_date)
         .join(AnnotationRecord, it.annotation_record_id == AnnotationRecord.id)
         .join(Task, Task.id == AnnotationRecord.task_id)
         .join(Sample, Sample.id == Task.sample_id)
         .where(it.label_id.in_(ids), AnnotationRecord.round_no == Task.round_no, it.uncertain.is_(False),
                Task.segment_start_ms.is_(None),
                Task.project_id.in_(select(Project.id).where(Project.is_active.is_(True)))))
    if date_from is not None:
        q = q.where(Sample.session_date >= date_from)
    if date_to is not None:
        q = q.where(Sample.session_date <= date_to)
    if min_sec:
        q = q.where(it.end_time_ms - it.start_time_ms >= int(min_sec * 1000))
    rows = (await db.execute(q.limit(COMPOSE_ROW_CAP))).all()
    if len(rows) >= COMPOSE_ROW_CAP:
        warnings.append(f"符合的片段超过 {COMPOSE_ROW_CAP} 条，只看了前 {COMPOSE_ROW_CAP} 条：缩小日期范围更准")

    codes = await seen_codes_of(model_ids or [], db) if seen_mode != "any" and model_ids else None
    if seen_mode != "any" and not model_ids:
        warnings.append("选了「见过 / 没见过」但没选模型，这一条没生效")
    idx = await DN.dog_index(db)
    prof = await DN.dog_profiles(db)
    dogs = {d.id: d for d in (await db.execute(select(Dog))).scalars().all()}
    want_sites = set(sites or [])
    want_dogs = set(dog_ids or [])
    dog_cache: dict[int, tuple[int | None, str | None]] = {}

    taken: dict[int, list[tuple[int, int]]] = defaultdict(list)
    if set_id is not None:
        for sid, s, e, ts, te in (await db.execute(
            select(ModelTestItem.sample_id, ModelTestItem.start_ms, ModelTestItem.end_ms, Task.segment_start_ms,
                   Task.segment_end_ms).join(Task, Task.id == ModelTestItem.task_id)
            .where(ModelTestItem.set_id == set_id))).all():
            a, b = (s, e) if s is not None else (ts, te)
            taken[sid].append((a if a is not None else 0, b if b is not None else 10 ** 12))

    groups: dict[tuple, list[dict]] = defaultdict(list)
    n_in = Counter()
    for lid, a, b, src, conf, mod, tid, tst, sid, code, cam, csv, sdog, dur, sday in rows:
        human = tst in (TaskStatus.SUBMITTED, TaskStatus.APPROVED) or src != LabelItemSource.ai_generated or conf or mod
        if (source == "human" and not human) or (source == "ai" and human):
            continue
        if codes is not None and ((code in codes) != (seen_mode == "seen")):
            continue
        if sid not in dog_cache:
            site_key = SL.site_of(code, csv, cam)
            did = await DN.sample_dog_id(db, code, sdog, cam, idx=idx, profiles=prof)
            site_name = (dogs[did].site if did in dogs else None) or SL.SITES.get(site_key or "", {}).get("name")
            # 9 月中以前文件名不带场地的老影棚数据：按设备号认狗常认错，不参与按狗挑
            if site_key is None and not sdog:
                did = None
            dog_cache[sid] = (did, site_name)
        did, site_name = dog_cache[sid]
        if want_sites and site_name not in want_sites:
            continue
        if want_dogs and did not in want_dogs:
            continue
        if did is None and (want_dogs or want_sites):
            continue
        leaf = lname.get(lid, "?")
        n_in[(did, leaf)] += 1
        groups[(did, leaf)].append({"task_id": tid, "sample_id": sid, "a": int(a), "b": int(b), "human": bool(human),
                                    "dur_ms": int((dur or 0) * 1000), "date": sday, "label": leaf,
                                    "dog_id": did, "site": site_name})

    rng = random.Random(seed)
    pad_ms = int(pad_sec * 1000)
    picked_by_group: dict[tuple, list[dict]] = {}
    for key, segs in groups.items():
        rng.shuffle(segs)
        segs.sort(key=lambda x: not x["human"])           # 人工标过的优先
        per_day: dict = defaultdict(list)
        for x in segs:
            per_day[x["date"]].append(x)
        days = sorted(per_day, key=lambda d: str(d))
        for d in days:
            per_day[d].reverse()
        got: list[dict] = []
        while len(got) < per_group and any(per_day.values()):
            for d in days:
                if len(got) >= per_group or not per_day[d]:
                    continue
                x = per_day[d].pop()
                s, e = pad_window(x["a"], x["b"], pad_ms, 0, x["dur_ms"] or None)
                if all(e <= p or s >= q2 for p, q2 in taken[x["sample_id"]]):
                    taken[x["sample_id"]].append((s, e))
                    got.append({**x, "start_ms": s, "end_ms": e})
        picked_by_group[key] = got

    # 总数上限：各组轮着取，谁都不独占
    picks: list[dict] = []
    order = sorted(picked_by_group, key=lambda k: (dogs[k[0]].name if k[0] in dogs else "~", k[1]))
    i = 0
    while len(picks) < max_total and any(picked_by_group[k] for k in order):
        k = order[i % len(order)]
        if picked_by_group[k]:
            picks.append(picked_by_group[k].pop(0))
        i += 1

    mat: dict[str, Counter] = defaultdict(Counter)
    avail: dict[str, Counter] = defaultdict(Counter)
    for (did, leaf), n in n_in.items():
        avail[dogs[did].name if did in dogs else "未知狗"][leaf] += n
    for p in picks:
        mat[dogs[p["dog_id"]].name if p["dog_id"] in dogs else "未知狗"][p["label"]] += 1
    dog_meta = {(dogs[d].name if d in dogs else "未知狗"): {"site": dogs[d].site if d in dogs else None,
                                                          "size": dogs[d].size if d in dogs else None}
                for d, _l in n_in}
    stats = {
        "n_found": sum(n_in.values()), "n_picked": len(picks),
        "video_hours": round(sum(p["end_ms"] - p["start_ms"] for p in picks) / 3600_000, 2),
        "by_dog_label": {k: dict(v) for k, v in mat.items()},
        "available": {k: dict(v) for k, v in avail.items()},
        "dogs": dog_meta,
        "by_site": dict(Counter(p["site"] or "未知" for p in picks)),
        "by_source": dict(Counter("人工标过" if p["human"] else "AI 预标" for p in picks)),
        "by_date": dict(sorted(Counter(str(p["date"]) for p in picks).items())),
    }
    for p in picks:
        p["date"] = str(p["date"])
    return {"picks": picks, "stats": stats, "warnings": warnings}
