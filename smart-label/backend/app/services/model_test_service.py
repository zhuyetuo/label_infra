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
    for tid, lid, s, e, unc in (await db.execute(
        select(AnnotationRecord.task_id, AnnotationLabelItem.label_id, AnnotationLabelItem.start_time_ms,
               AnnotationLabelItem.end_time_ms, AnnotationLabelItem.uncertain)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(Task, Task.id == AnnotationRecord.task_id)
        .where(AnnotationRecord.task_id.in_(tids), AnnotationRecord.round_no == Task.round_no)
    )).all():
        segs[tid].append((top(lid), int(s), int(e), bool(unc)))

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
        for k, a, b, unc in segs.get(it.task_id, []):
            ov = min(b, we) - max(a, ws)
            if ov <= 0:
                continue
            if unc:
                n_uncertain += 1
                continue
            x = labels.setdefault(k, {"n": 0, "sec": 0.0})
            x["n"] += 1
            x["sec"] = round(x["sec"] + ov / 1000, 1)
        out.append({
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
        })
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
    n_unsure = sum(1 for r in rows if r["dog_unsure"])
    if n_unsure:
        warns.append(f"{n_unsure} 段的狗是按设备号推断、而且是老影棚数据（常对不上），按狗/体型统计时不可靠")
    return {"n_items": len(rows), "total_sec": round(total, 1), "matrix": matrix, "kinds": dict(kinds),
            "dogs": dogs, "n_dogs": len(dogs), "sites": dict(sites), "dates": dict(sorted(dates.items())),
            "warnings": warns}
