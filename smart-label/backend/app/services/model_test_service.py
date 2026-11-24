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
from app.services.model_label_alias import ALIASES
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
        return ALIASES.get(n, n)

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


def _dur_key(label: str) -> float:
    n = float(label.split()[0])
    return n * 60 if "分钟" in label else n


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
    by_dur: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        leaf.update(r.get("leaf") or {})
        # 按实际时长（1 分钟 / 5 分钟 / 10 分钟…）× 有没有抓挠（已有片段或待判的疑似片段都算有）
        d = r["dur_sec"]
        dl = f"{round(d / 60)} 分钟" if d >= 50 else f"{int(d)} 秒"
        has = bool(r["labels"].get("抓挠")) or any((v.get("pending") or 0) for k, v in (r.get("cands") or {}).items() if k.startswith("抓挠"))
        by_dur[dl]["有抓挠" if has else "无抓挠"] += 1
    return {"n_items": len(rows), "total_sec": round(total, 1), "matrix": matrix, "kinds": dict(kinds),
            "dogs": dogs, "n_dogs": len(dogs), "sites": dict(sites), "dates": dict(sorted(dates.items())),
            "leaf": dict(leaf.most_common()), "n_checked": sum(1 for r in rows if r.get("checked")),
            "by_dur": {k: dict(v) for k, v in sorted(by_dur.items(), key=lambda kv: _dur_key(kv[0]))},
            "warnings": warns}


# ───────────── 按条件挑：从已有的标注片段（人工标过的 / AI 预标的）里挑，凑窗口，加进测试集 ─────────────

async def label_colors(db: AsyncSession) -> dict[str, str]:
    """标签名 → 颜色（跟工作台一样那套，各项目同名取第一个有颜色的）。列表上「标了什么」按它上色"""
    out: dict[str, str] = {}
    for n, c in (await db.execute(select(LabelDefinition.display_name, LabelDefinition.color)
                                  .order_by(LabelDefinition.id))).all():
        if c and n not in out:
            out[n] = c
    return out


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
                  seed: int = 1, mode: str = "positive", anchor_names: list[str] | None = None,
                  per_dog: int | None = None, extra_taken: dict[int, list[tuple[int, int]]] | None = None,
                  _cache: dict | None = None) -> dict:
    """按条件从已有片段里挑。返回 {picks: [...], stats, warnings}；不写库（写库见 compose_apply）。

    source：human = 人工标过的（任务已提交/通过，或片段是人加 / 人确认 / 人改过的）；ai = 只要 AI 预标的；any = 都要。
    seen_mode：unseen / seen / any，相对 model_ids 的训练数据集（样本级）。
    每组（狗 × 细类）最多 per_group 段，按日期轮着挑；每只狗最多 per_dog 段；总数最多 max_total（各组轮着取）。
    窗口 = 片段前后延长凑够 pad_sec（碰头尾往另一边补），同一个样本里窗口不重叠，也不跟这个测试集里已有的重叠。
    mode=positive：以选的类别的片段为中心（事件比窗口长不截，留完整过程）；
    mode=negative：「无这类」窗口——以别的片段（anchor_names，比如相似动作舔 / 甩头，或活动 / 休息；不给 = 任何别的类别）
    为中心，窗口里这个样本所有任务都不能有选的类别（待定的也不行）；中心片段比窗口长就在里面截。"""
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
    negative = mode == "negative"
    neg_name = "无" + "/".join(label_names)
    anchor_ids: set[int] | None = None
    if negative and anchor_names:
        anchor_ids = set((await db.execute(select(LabelDefinition.id).where(LabelDefinition.display_name.in_(anchor_names)))).scalars().all())
        anchor_ids = (await label_tree.expand_ids(db, anchor_ids)) - ids if anchor_ids else set()
        if not anchor_ids:
            return {"picks": [], "stats": {}, "warnings": ["选的「以哪类片段为中心」没有对应的标签"]}

    it = AnnotationLabelItem
    # 有这类：以这类片段为中心；没有这类：以别的类别的片段为中心（窗口里一次这类都不能有，下面再查）
    if not negative:
        label_cond = it.label_id.in_(ids)
    elif anchor_ids is not None:
        label_cond = it.label_id.in_(anchor_ids)
    else:
        label_cond = it.label_id.notin_(ids)
    q = (select(it.label_id, it.start_time_ms, it.end_time_ms, it.source_type, it.ai_confirmed, it.is_modified,
                Task.id, Task.status, Sample.id, Sample.sample_code, Sample.video_cam1_path, Sample.imu_csv_path,
                Sample.dog_id, Sample.video_duration_sec, Sample.session_date)
         .join(AnnotationRecord, it.annotation_record_id == AnnotationRecord.id)
         .join(Task, Task.id == AnnotationRecord.task_id)
         .join(Sample, Sample.id == Task.sample_id)
         .where(label_cond, AnnotationRecord.round_no == Task.round_no, it.uncertain.is_(False),
                Task.segment_start_ms.is_(None),
                Task.project_id.in_(select(Project.id).where(Project.is_active.is_(True)))))
    if date_from is not None:
        q = q.where(Sample.session_date >= date_from)
    if date_to is not None:
        q = q.where(Sample.session_date <= date_to)
    if min_sec:
        q = q.where(it.end_time_ms - it.start_time_ms >= int(min_sec * 1000))
    # _cache：选样计划一次要挑很多格（每只狗 × 时长 × 有无 × 部位），同样的查询只查一遍
    cache = _cache if _cache is not None else {}
    ck = ("rows", mode, tuple(sorted(ids)), tuple(sorted(anchor_ids or [])), str(date_from), str(date_to), min_sec)
    if ck not in cache:
        cache[ck] = (await db.execute(q.limit(COMPOSE_ROW_CAP))).all()
    rows = cache[ck]
    if len(rows) >= COMPOSE_ROW_CAP:
        warnings.append(f"符合的片段超过 {COMPOSE_ROW_CAP} 条，只看了前 {COMPOSE_ROW_CAP} 条：缩小日期范围更准")

    codes = None
    if seen_mode != "any" and model_ids:
        kc = ("codes", tuple(sorted(model_ids)))
        if kc not in cache:
            cache[kc] = await seen_codes_of(model_ids, db)
        codes = cache[kc]
    if seen_mode != "any" and not model_ids:
        warnings.append("选了「见过 / 没见过」但没选模型，这一条没生效")
    if "dogidx" not in cache:
        cache["dogidx"] = (await DN.dog_index(db), await DN.dog_profiles(db),
                           {d.id: d for d in (await db.execute(select(Dog))).scalars().all()})
    idx, prof, dogs = cache["dogidx"]
    want_sites = set(sites or [])
    want_dogs = set(dog_ids or [])
    dog_cache: dict[int, tuple[int | None, str | None]] = cache.setdefault("dog_cache", {})

    taken: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for sid, spans in (extra_taken or {}).items():
        taken[sid].extend(spans)
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
        leaf = neg_name if negative else lname.get(lid, "?")
        n_in[(did, leaf)] += 1
        groups[(did, leaf)].append({"task_id": tid, "sample_id": sid, "a": int(a), "b": int(b), "human": bool(human),
                                    "dur_ms": int((dur or 0) * 1000), "date": sday, "label": leaf,
                                    "anchor": lname.get(lid, "?") if negative else None,
                                    "dog_id": did, "site": site_name})

    # 没有这类：这些样本里（任何任务、待定的也算）这类片段的时间，窗口一点都不能碰
    avoid: dict[int, list[tuple[int, int]]] = cache.setdefault(("avoid", tuple(sorted(ids))), defaultdict(list))
    avoid_done: set[int] = cache.setdefault(("avoid_done", tuple(sorted(ids))), set())
    if negative and groups:
        sids = list({x["sample_id"] for g in groups.values() for x in g} - avoid_done)
        avoid_done.update(sids)
        for i in range(0, len(sids), 2000):
            for sid, a, b in (await db.execute(
                select(Task.sample_id, it.start_time_ms, it.end_time_ms)
                .join(AnnotationRecord, it.annotation_record_id == AnnotationRecord.id)
                .join(Task, Task.id == AnnotationRecord.task_id)
                .where(Task.sample_id.in_(sids[i:i + 2000]), it.label_id.in_(ids),
                       AnnotationRecord.round_no == Task.round_no))).all():
                avoid[sid].append((int(a), int(b)))

    rng = random.Random(seed)
    pad_ms = int(pad_sec * 1000)

    def window_of(x: dict) -> tuple[int, int]:
        hi = x["dur_ms"] or None
        if negative and pad_ms and x["b"] - x["a"] > pad_ms:
            # 没有这类：中心片段比窗口长（比如半小时的休息）就在里面随机截一段，窗口就是设定的长度
            s = rng.randrange(x["a"], x["b"] - pad_ms + 1, 1000)
            return s, s + pad_ms
        # 有这类：事件比窗口长（长时间抓挠）不截，留完整过程
        return pad_window(x["a"], x["b"], pad_ms, 0, hi)
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
                s, e = window_of(x)
                if negative and any(a < e and b > s for a, b in avoid.get(x["sample_id"], [])):
                    continue
                if all(e <= p or s >= q2 for p, q2 in taken[x["sample_id"]]):
                    taken[x["sample_id"]].append((s, e))
                    got.append({**x, "start_ms": s, "end_ms": e})
        picked_by_group[key] = got

    # 总数上限 / 每只狗上限：各组轮着取，谁都不独占
    picks: list[dict] = []
    order = sorted(picked_by_group, key=lambda k: (dogs[k[0]].name if k[0] in dogs else "~", k[1]))
    per_dog_n: Counter = Counter()
    i = 0
    while len(picks) < max_total and any(picked_by_group[k] for k in order):
        k = order[i % len(order)]
        if picked_by_group[k]:
            if per_dog and per_dog_n[k[0]] >= per_dog:
                picked_by_group[k].clear()
            else:
                picks.append(picked_by_group[k].pop(0))
                per_dog_n[k[0]] += 1
        i += 1

    mat: dict[str, Counter] = defaultdict(Counter)
    avail: dict[str, Counter] = defaultdict(Counter)
    for (did, leaf), n in n_in.items():
        avail[dogs[did].name if did in dogs else "未知狗"][leaf] += n
    for p in picks:
        mat[dogs[p["dog_id"]].name if p["dog_id"] in dogs else "未知狗"][p["label"]] += 1
    dog_meta = {(dogs[d].name if d in dogs else "未知狗"): {"site": dogs[d].site if d in dogs else None,
                                                          "size": dogs[d].size if d in dogs else None, "id": d}
                for d, _l in n_in}
    avail_by_id: dict[int, dict[str, int]] = defaultdict(dict)
    for (did, leaf), n in n_in.items():
        if did is not None:
            avail_by_id[did][leaf] = n
    stats = {
        "n_found": sum(n_in.values()), "n_picked": len(picks),
        "video_hours": round(sum(p["end_ms"] - p["start_ms"] for p in picks) / 3600_000, 2),
        "by_dog_label": {k: dict(v) for k, v in mat.items()},
        "available": {k: dict(v) for k, v in avail.items()},
        "available_by_id": {str(k): v for k, v in avail_by_id.items()},
        "dogs": dog_meta,
        "by_site": dict(Counter(p["site"] or "未知" for p in picks)),
        "by_source": dict(Counter("人工标过" if p["human"] else "AI 预标" for p in picks)),
        "by_date": dict(sorted(Counter(str(p["date"]) for p in picks).items())),
    }
    for p in picks:
        p["date"] = str(p["date"])
    if _cache is not None:
        _cache.setdefault("_warn", []).extend(warnings)
    return {"picks": picks, "stats": stats, "warnings": warnings}


# ───────────── 选样计划：每只狗 × 时长 × 有/无 × 部位 的配额，一次挑完 ─────────────

async def plan_availability(db: AsyncSession, plan: dict) -> dict:
    """每只狗在条件范围里有多少这类片段（按细类），给选样页显示「可用」"""
    r = await compose(db, label_names=[plan["target"]], date_from=plan.get("date_from"), date_to=plan.get("date_to"),
                      source=plan.get("source", "any"), seen_mode=plan.get("seen_mode", "any"),
                      model_ids=plan.get("model_ids"), per_group=1, max_total=1)
    return {"by_dog": r["stats"].get("available_by_id", {}), "warnings": r["warnings"]}


def split_by_ratio(n: int, ratios: list[float]) -> list[int]:
    """n 段按比例摊（最大余数法，跟前端显示的同一套），加起来正好是 n"""
    tot = sum(ratios)
    if n <= 0 or tot <= 0:
        return [0] * len(ratios)
    raw = [n * r / tot for r in ratios]
    base = [int(x) for x in raw]
    left = n - sum(base)
    for j in sorted(range(len(raw)), key=lambda j: (-(raw[j] - base[j]), j))[:left]:
        base[j] += 1
    return base


def split_grid(row_totals: list[int], col_targets: list[int]) -> list[list[int]]:
    """整批摊：行 = 每只狗这一版的「无」段数，列 = 整批各类目标数（split_by_ratio 出来的）。
    先按比例取整，再按余数大小补，补的时候行、列都不超；万一补不满（目标冲突）再按行补齐，保证每只狗段数不变。"""
    import math
    total = sum(row_totals)
    if total <= 0 or not col_targets:
        return [[0] * len(col_targets) for _ in row_totals]
    grid = [[math.floor(r * c / total) for c in col_targets] for r in row_totals]
    used_r = [sum(g) for g in grid]
    used_c = [sum(grid[i][j] for i in range(len(row_totals))) for j in range(len(col_targets))]
    extra = sorted(((r * c / total - math.floor(r * c / total), i, j)
                    for i, r in enumerate(row_totals) for j, c in enumerate(col_targets)),
                   key=lambda x: (-x[0], x[1], x[2]))
    left = total - sum(used_r)
    for _ in range(20):
        moved = False
        for _p, i, j in extra:
            if left <= 0:
                break
            if used_r[i] < row_totals[i] and used_c[j] < col_targets[j]:
                grid[i][j] += 1
                used_r[i] += 1
                used_c[j] += 1
                left -= 1
                moved = True
        if not moved or left <= 0:
            break
    for i, r in enumerate(row_totals):
        while used_r[i] < r:
            j = max(range(len(col_targets)), key=lambda j: (col_targets[j] - used_c[j], -j))
            grid[i][j] += 1
            used_r[i] += 1
            used_c[j] += 1
    return grid


async def plan_run(db: AsyncSession, set_id: int, plan: dict) -> dict:
    """按计划挑。plan：
      target 类别（如 抓挠）；durations [秒]；parts [细类]；anchor_names（无这类时以哪类为中心，可空）；
      dogs [{dog_id, q: {"60": [有, 无], "600": [有, 无]}, p: {部位: 段数}}]；
      date_from / date_to / source / seen_mode / model_ids / seed
    部位数是这只狗「有这类」各时长合计的分配；部位加起来不够的那几段不限部位。
    返回 picks（每条带 cell：时长 / 有无 / 部位）和每只狗每格「计划 / 挑到」。"""
    import random
    cache: dict = {}
    taken: dict[int, list[tuple[int, int]]] = defaultdict(list)
    target = plan["target"]
    seed = int(plan.get("seed") or 1)
    common = dict(date_from=plan.get("date_from"), date_to=plan.get("date_to"), source=plan.get("source", "any"),
                  seen_mode=plan.get("seen_mode", "any"), model_ids=plan.get("model_ids"), set_id=set_id,
                  _cache=cache, extra_taken=taken)
    picks: list[dict] = []
    report: dict[str, dict] = {}
    warnings: list[str] = []
    # 「无」的分类按整批摊：每种时长先按比例定各类总数（50 段 → 20/10/15/5），再分到每只狗
    neg_cats = [c for c in (plan.get("neg_cats") or []) if float(c.get("ratio") or 0) > 0 and c.get("anchors")]
    dogs_in = plan.get("dogs", [])
    neg_grid: dict[int, dict[int, list[int]]] = defaultdict(dict)    # 时长 → 狗 → 各类段数
    if neg_cats:
        durs = {int(k) for dg in dogs_in for k in (dg.get("q") or {})}
        for d in durs:
            rows = [int(((dg.get("q") or {}).get(str(d)) or [0, 0])[1] or 0) for dg in dogs_in]
            grid = split_grid(rows, split_by_ratio(sum(rows), [float(c["ratio"]) for c in neg_cats]))
            for dg, g in zip(dogs_in, grid):
                neg_grid[d][int(dg["dog_id"])] = g
    for dg in dogs_in:
        did = int(dg["dog_id"])
        q = {int(k): v for k, v in (dg.get("q") or {}).items()}
        pq = {k: int(v) for k, v in (dg.get("p") or {}).items() if int(v) > 0}
        rep = {"q": {str(d): [0, 0] for d in q}, "p": {k: 0 for k in pq}}
        rng = random.Random(seed * 1000 + did)
        # 有这类：时长槽位 × 部位槽位配对
        pos_slots = [d for d in sorted(q) for _ in range(int(q[d][0] or 0))]
        part_slots = [p for p in pq for _ in range(pq[p])][:len(pos_slots)]
        part_slots += [target] * (len(pos_slots) - len(part_slots))
        rng.shuffle(part_slots)
        cells = Counter(zip(pos_slots, part_slots))
        for (d, part), n in sorted(cells.items(), key=lambda kv: (kv[0][0], kv[0][1])):
            r = await compose(db, label_names=[part], dog_ids=[did], pad_sec=d, per_group=n, max_total=n,
                              mode="positive", seed=seed, **common)
            for p in r["picks"]:
                p["cell"] = {"dur": d, "kind": "有", "part": part if part != target else None}
                taken[p["sample_id"]].append((p["start_ms"], p["end_ms"]))
                rep["q"][str(d)][0] += 1
                if part in rep["p"]:
                    rep["p"][part] += 1
            picks += r["picks"]
        # 无这类：有分类（像抓挠的动作 / 活动 / 休息 / 未佩戴…）就用整批摊好的数，逐类以那类片段为中心挑
        rep["n"] = {}
        for d in sorted(q):
            n = int(q[d][1] or 0)
            if not n:
                continue
            if neg_cats:
                parts = neg_grid[d].get(did) or split_by_ratio(n, [float(c["ratio"]) for c in neg_cats])
                jobs = [(c["name"], c["anchors"], k, c.get("anchor_ratios")) for c, k in zip(neg_cats, parts) if k > 0]
            else:
                jobs = [(None, plan.get("anchor_names") or None, n, None)]
            rep["n"][str(d)] = {}

            async def _neg(cat, anchors, k):
                r = await compose(db, label_names=[target], dog_ids=[did], pad_sec=d, per_group=k, max_total=k,
                                  mode="negative", anchor_names=anchors, seed=seed, **common)
                for p in r["picks"]:
                    p["cell"] = {"dur": d, "kind": "无", "part": None, "cat": cat}
                    taken[p["sample_id"]].append((p["start_ms"], p["end_ms"]))
                    rep["q"][str(d)][1] += 1
                    if cat:
                        rep["n"][str(d)][cat] = rep["n"][str(d)].get(cat, 0) + 1
                picks.extend(r["picks"])
                return len(r["picks"])

            for cat, anchors, k, ar in jobs:
                # 分类内按各中心动作的比例再摊（舔 / 啃 / 蹭 / 甩头 各多少）；某个动作不够的，用这类里别的动作补上
                ws = [float((ar or {}).get(a, 0) or 0) for a in (anchors or [])]
                if anchors and len(anchors) > 1 and sum(ws) > 0:
                    got = 0
                    for a, ka in zip(anchors, split_by_ratio(k, ws)):
                        if ka > 0:
                            got += await _neg(cat, [a], ka)
                    if got < k:
                        await _neg(cat, anchors, k - got)
                else:
                    await _neg(cat, anchors, k)
        report[str(did)] = rep
    for w in cache.get("_warn", []):
        if w not in warnings:
            warnings.append(w)
    return {"picks": picks, "report": report, "n_picked": len(picks),
            "video_hours": round(sum(p["end_ms"] - p["start_ms"] for p in picks) / 3600_000, 2),
            "by_source": dict(Counter("人工标过" if p["human"] else "AI 预标" for p in picks)),
            "warnings": warnings}
