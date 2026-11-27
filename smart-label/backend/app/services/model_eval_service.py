"""
模型评测与对比：拿同一批数据，把不同模型/不同版本的结果跟人工标注比一比。

要回答的是这几个问题（都是训练完新模型必然会问的）：
  - 以前漏掉的，现在识别出来了吗？
  - 以前能识别对的，现在还对吗（回归）？
  - 起止位置比以前准还是差了？
  - 置信度整体漂了吗——以前设的过滤阈值还管用吗？

做法是「按时间重叠配对」：预测片段和人工片段谁跟谁 IoU 最高就算一对，配上了
算命中（TP），预测有、人工没有算误报（FP），人工有、预测没有算漏检（FN）。
两个模型各跟人工比一遍，再把两边的命中集合一对照，就得出「新增命中 / 新增漏检」
这种回归视角。

两类时间段在评测里一律不算数（既不算命中也不算误报）：
  - 人工标了「待定」的（看了拿不准，本来就没有正确答案）
  - 采集时掉数据的（AI 结果 JSON 的 missing 段）
不排除这两种，指标会被一堆"本来就说不清"的段带偏。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.audit_log import AuditLog
from app.models.inference_run import SampleInferenceRun
from app.models.label import LabelDefinition
from app.services import label_tracks, label_tree
from app.services.model_label_alias import ALIASES
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services.ai_prelabel_service import PrelabelError, _csv_start_of, parse_ts

_logger = logging.getLogger("smart-label.model_eval")

# 阈值曲线按这个步长扫：0.05 够细了，再细图上也看不出差别
_THRESHOLDS = [round(x / 20, 2) for x in range(0, 20)]

# 人工审过的任务才拿来当正确答案：还在标的草稿可能只标了一半，
# 拿它当答案的话没标到的地方模型标对了也算误报
_REVIEWED = (TaskStatus.SUBMITTED, TaskStatus.APPROVED)


@dataclass
class Seg:
    start_ms: int
    end_ms: int
    conf: float | None = None
    # 模型把这一段判成什么类别。两版互比时用来回答"同一段两边认的类别一样吗"；
    # 跟人工比时人工的 Seg 不带类别（外面按类别分组了）
    label: str | None = None

    @property
    def dur(self) -> int:
        return max(0, self.end_ms - self.start_ms)


def clip_to_windows(segs: list[Seg], wins: list[tuple[int, int]]) -> list[Seg]:
    """只留窗口里的部分：跨窗口边的段在边上切开，跨两个窗口的切成两段。
    模型测试集挑的是样本里的一段（比如 1 分钟），窗口外的标注和预测都不该算分"""
    import dataclasses
    out: list[Seg] = []
    for s in segs:
        for a, b in wins:
            lo, hi = max(s.start_ms, a), min(s.end_ms, b)
            if hi > lo:
                out.append(dataclasses.replace(s, start_ms=lo, end_ms=hi))
    out.sort(key=lambda x: x.start_ms)
    return out


def _iou(a: Seg, b: Seg) -> float:
    inter = min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms)
    if inter <= 0:
        return 0.0
    union = a.dur + b.dur - inter
    return inter / union if union > 0 else 0.0


def _best_overlap(s: Seg, candidates: list[Seg], iou_min: float) -> tuple[Seg, float] | None:
    """在候选片段里找跟 s 重叠最多的一个（IoU 达到门槛才算）。"""
    best: tuple[Seg, float] | None = None
    for c in candidates:
        v = _iou(s, c)
        if v >= iou_min and (best is None or v > best[1]):
            best = (c, v)
    return best


def _overlaps_any(s: Seg, holes: list[tuple[int, int]], ratio: float = 0.5) -> bool:
    """这一段有超过一半时间落在"不算数"的区间里就整段跳过。"""
    if not holes:
        return False
    covered = 0
    for h0, h1 in holes:
        covered += max(0, min(s.end_ms, h1) - max(s.start_ms, h0))
    return s.dur > 0 and covered / s.dur >= ratio


def match(preds: list[Seg], truths: list[Seg], iou_min: float) -> tuple[list[tuple[int, int, float]], list[int], list[int]]:
    """
    贪心配对：所有 (预测, 人工) 组合按 IoU 从高到低取，一个只能配一次。

    贪心而不是匈牙利算法：片段本来就少有一对多的情况（真重叠成那样说明标注
    有问题），贪心结果一样，代码少一半。

    返回 (配对好的 [(pi, ti, iou)], 没配上的预测下标, 没配上的人工下标)
    """
    pairs: list[tuple[int, int, float]] = []
    cand = []
    for pi, p in enumerate(preds):
        for ti, t in enumerate(truths):
            v = _iou(p, t)
            if v >= iou_min:
                cand.append((v, pi, ti))
    cand.sort(reverse=True)
    used_p: set[int] = set()
    used_t: set[int] = set()
    for v, pi, ti in cand:
        if pi in used_p or ti in used_t:
            continue
        used_p.add(pi)
        used_t.add(ti)
        pairs.append((pi, ti, v))
    fp = [i for i in range(len(preds)) if i not in used_p]
    fn = [i for i in range(len(truths)) if i not in used_t]
    return pairs, fp, fn


def _prf(tp: int, fp: int, fn: int) -> dict:
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": round(prec, 4), "recall": round(rec, 4), "f1": round(f1, 4)}


def _read_json(relpath: str) -> dict | None:
    full = os.path.join(settings.nas_root, relpath)
    if not os.path.isfile(full):
        return None
    try:
        with open(full, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# 评测只需 segments 和 missing（约几 KB），丢弃约 1.8MB 的逐秒 windows/candidates，并缓存到内存避免反复读 NAS
_JSON_CACHE: OrderedDict[tuple[str, str], dict] = OrderedDict()
_JSON_CACHE_MAX = 3000
_JSON_INFLIGHT: dict[tuple[str, str], asyncio.Task] = {}

_CSV_START_CACHE: OrderedDict[str, datetime] = OrderedDict()
_CSV_START_CACHE_MAX = 10000
_CSV_INFLIGHT: dict[str, asyncio.Task] = {}


async def _read_json_cached(relpath: str, ver_tag: str, sem: asyncio.Semaphore) -> dict | None:
    key = (relpath, ver_tag)
    cached = _JSON_CACHE.get(key)
    if cached is not None:
        _JSON_CACHE.move_to_end(key)
        return cached
    task = _JSON_INFLIGHT.get(key)
    if task is None:
        async def _load() -> dict | None:
            async with sem:
                raw = await asyncio.to_thread(_read_json, relpath)
            if raw is None:
                return None
            slim = {"segments": raw.get("segments") or {}, "missing": raw.get("missing") or []}
            _JSON_CACHE[key] = slim
            _JSON_CACHE.move_to_end(key)
            while len(_JSON_CACHE) > _JSON_CACHE_MAX:
                _JSON_CACHE.popitem(last=False)
            return slim

        task = asyncio.create_task(_load())
        _JSON_INFLIGHT[key] = task
        task.add_done_callback(lambda t: _JSON_INFLIGHT.pop(key, None) if _JSON_INFLIGHT.get(key) is t else None)
    return await asyncio.shield(task)


async def _csv_start_cached(s: Sample, sem: asyncio.Semaphore) -> datetime:
    if not s.imu_csv_path:
        raise PrelabelError("该样本没有 IMU CSV，无法做 AI 预标注")
    ckey = s.imu_csv_path
    cached = _CSV_START_CACHE.get(ckey)
    if cached is not None:
        _CSV_START_CACHE.move_to_end(ckey)
        return cached
    task = _CSV_INFLIGHT.get(ckey)
    if task is None:
        async def _load_csv() -> datetime:
            async with sem:
                dt = await _csv_start_of(s)
            _CSV_START_CACHE[ckey] = dt
            _CSV_START_CACHE.move_to_end(ckey)
            while len(_CSV_START_CACHE) > _CSV_START_CACHE_MAX:
                _CSV_START_CACHE.popitem(last=False)
            return dt

        task = asyncio.create_task(_load_csv())
        _CSV_INFLIGHT[ckey] = task
        task.add_done_callback(lambda t: _CSV_INFLIGHT.pop(ckey, None) if _CSV_INFLIGHT.get(ckey) is t else None)
    return await asyncio.shield(task)


def _subtract_segs(segs: list[Seg], cutouts: list[tuple[int, int]], min_ms: int = 200) -> list[Seg]:
    """从一组片段中挖掉 cutouts 覆盖的时间区间（与训练导出折叠口径一致），丢弃 < min_ms 的极短碎片。"""
    if not cutouts or not segs:
        return segs
    merged: list[list[int]] = []
    for a, b in sorted(cutouts):
        if b <= a:
            continue
        if merged and a <= merged[-1][1]:
            if b > merged[-1][1]:
                merged[-1][1] = b
        else:
            merged.append([a, b])
    out: list[Seg] = []
    for seg in segs:
        cur = seg.start_ms
        for ca, cb in merged:
            if cb <= cur:
                continue
            if ca >= seg.end_ms:
                break
            if ca > cur and ca - cur >= min_ms:
                out.append(Seg(cur, ca, seg.conf, seg.label))
            cur = max(cur, cb)
            if cur >= seg.end_ms:
                break
        if seg.end_ms - cur >= min_ms:
            out.append(Seg(cur, seg.end_ms, seg.conf, seg.label))
    return out


async def _human_by_sample(
    db: AsyncSession, sample_ids: list[int], label_names: list[str], task_ids: list[int] | None = None
) -> tuple[dict[int, list[Seg]], dict[int, list[tuple[int, int]]]]:
    """
    人工标注（当前轮）按样本取。返回 (正确答案, 不算数的区间)。

    「待定」的片段进第二个返回值：那是人看了也拿不准的，模型标不标都不该扣分。
    评测运动背景态（活动 / 静止/休息）时，与训练导出保持同一口径：自动挖掉嵌套其中的具体行为（抓挠/舔/啃/甩头…）时段。
    """
    # 加上子标签：人标了「抓挠-头颈耳」，模型标「抓挠」也算对
    label_ids = await label_tree.expand_ids(db, set(
        (
            await db.execute(
                select(LabelDefinition.id).where(
                    LabelDefinition.display_name.in_(label_names) | LabelDefinition.code.in_(label_names)
                )
            )
        ).scalars().all()
    ))
    if not label_ids or not sample_ids:
        return {}, {}
    rows = await db.execute(
        select(
            Task.sample_id,
            AnnotationLabelItem.start_time_ms,
            AnnotationLabelItem.end_time_ms,
            AnnotationLabelItem.uncertain,
        )
        .join(AnnotationRecord, AnnotationRecord.task_id == Task.id)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .where(
            Task.sample_id.in_(sample_ids),
            AnnotationRecord.round_no == Task.round_no,
            AnnotationLabelItem.label_id.in_(label_ids),
            # 给了任务就只认这些任务的标注（模型测试集：同一个样本在别的项目里还有预标 / 别人标的），不要求已审
            *([Task.id.in_(task_ids)] if task_ids is not None else [Task.status.in_(_REVIEWED)]),
        )
    )
    truths: dict[int, list[Seg]] = defaultdict(list)
    holes: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for sid, s_ms, e_ms, uncertain in rows.all():
        if uncertain:
            holes[sid].append((int(s_ms), int(e_ms)))
        else:
            truths[sid].append(Seg(int(s_ms), int(e_ms)))
    if truths and any(label_tracks.is_motion_bg(n) for n in label_names):
        # 查同批任务里的所有具体行为（behavior / 未分轨非背景态），从活动/静止真值中自动挖掉重叠时段
        all_labs = (await db.execute(
            select(LabelDefinition.id, LabelDefinition.parent_id, LabelDefinition.track, LabelDefinition.display_name)
        )).all()
        parent_of = {i: p for i, p, _t, _n in all_labs}
        own_track = {i: t for i, _p, t, _n in all_labs}
        names_map = {i: n for i, _p, _t, n in all_labs}
        higher_ids = {
            i for i, _p, _t, _n in all_labs
            if i not in label_ids and label_tracks.track_of(parent_of, own_track, i, names_map) in ("behavior", "")
        }
        if higher_ids:
            ov_rows = await db.execute(
                select(Task.sample_id, AnnotationLabelItem.start_time_ms, AnnotationLabelItem.end_time_ms)
                .join(AnnotationRecord, AnnotationRecord.task_id == Task.id)
                .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
                .where(
                    Task.sample_id.in_(list(truths.keys())),
                    AnnotationRecord.round_no == Task.round_no,
                    AnnotationLabelItem.label_id.in_(higher_ids),
                    AnnotationLabelItem.uncertain.is_(False),
                    *([Task.id.in_(task_ids)] if task_ids is not None else [Task.status.in_(_REVIEWED)]),
                )
            )
            cutouts: dict[int, list[tuple[int, int]]] = defaultdict(list)
            for sid, s_ms, e_ms in ov_rows.all():
                cutouts[sid].append((int(s_ms), int(e_ms)))
            for sid, cs in cutouts.items():
                truths[sid] = _subtract_segs(truths[sid], cs)
    for v in truths.values():
        v.sort(key=lambda x: x.start_ms)
    return truths, holes


async def _run_segments(
    samples: list[Sample], runs: dict[int, SampleInferenceRun], label_names: list[str] | None
) -> tuple[dict[int, list[Seg]], dict[int, list[tuple[int, int]]], list[str]]:
    """把一次跑的结果 JSON 读出来，换算成相对 CSV 起点的毫秒。

    label_names=None 表示读全部类别——两版互比要判断"类别一致不一致"，
    只读一个类别的话永远比不出类别差异。
    """
    preds: dict[int, list[Seg]] = {}
    missing: dict[int, list[tuple[int, int]]] = {}
    warnings: list[str] = []

    sem = asyncio.Semaphore(16)

    async def _one(s: Sample) -> None:
        run = runs.get(s.id)
        if run is None:
            return
        ver_tag = str(run.updated_at or run.created_at or "")
        data = await _read_json_cached(run.json_path, ver_tag, sem)
        if not data:
            warnings.append(f"样本 {s.sample_code} 的结果文件读不到：{run.json_path}")
            return
        try:
            csv_start = await _csv_start_cached(s, sem)
        except PrelabelError as e:
            warnings.append(f"样本 {s.sample_code}：{e}")
            return
        by_label = data.get("segments") or {}
        classes = (
            list(by_label.items()) if label_names is None
            else [(name, by_label.get(name) or []) for name in label_names]
        )
        segs: list[Seg] = []
        for name, items in classes:
            for seg in items:
                a, b = parse_ts(seg.get("start_ts")), parse_ts(seg.get("end_ts"))
                if a is None or b is None or b <= a:
                    continue
                conf = seg.get("conf_mean")
                if conf is None:
                    conf = seg.get("conf_max")
                segs.append(
                    Seg(
                        int(round((a - csv_start).total_seconds() * 1000)),
                        int(round((b - csv_start).total_seconds() * 1000)),
                        float(conf) if conf is not None else None,
                        label=name,
                    )
                )
        segs.sort(key=lambda x: x.start_ms)
        preds[s.id] = segs
        hs: list[tuple[int, int]] = []
        for m in data.get("missing") or []:
            a, b = parse_ts(m.get("start_ts")), parse_ts(m.get("end_ts"))
            if a and b and b > a:
                hs.append(
                    (
                        int(round((a - csv_start).total_seconds() * 1000)),
                        int(round((b - csv_start).total_seconds() * 1000)),
                    )
                )
        missing[s.id] = hs

    await asyncio.gather(*(_one(s) for s in samples))
    return preds, missing, warnings


def _merge_sub_segs(segs: list[Seg]) -> list[Seg]:
    """同一父类别下，不同细类紧贴段（如抓挠-头颈耳 + 抓挠-躯干）或重叠段合并为一段再配对。"""
    if len(segs) < 2:
        return segs
    ordered = sorted(segs, key=lambda x: (x.start_ms, x.end_ms))
    out: list[Seg] = [ordered[0]]
    for s in ordered[1:]:
        prev = out[-1]
        same_label = prev.label is not None and prev.label == s.label
        if s.start_ms < prev.end_ms or (not same_label and s.start_ms <= prev.end_ms):
            confs = [c for c in (prev.conf, s.conf) if c is not None]
            out[-1] = Seg(
                prev.start_ms,
                max(prev.end_ms, s.end_ms),
                max(confs) if confs else None,
                prev.label,
            )
        else:
            out.append(s)
    return out


async def _expand_eval_names(db: AsyncSession, label: str) -> list[str]:
    """把目标类别展开为「自身 + 老模板/模型别名 + 标签树子类别名 + 子类别别名」。"""
    canon = ALIASES.get(label, label)
    seed = {label, canon, *(k for k, v in ALIASES.items() if v in (label, canon))}
    base_ids = set(
        (
            await db.execute(
                select(LabelDefinition.id).where(
                    LabelDefinition.display_name.in_(seed) | LabelDefinition.code.in_(seed)
                )
            )
        ).scalars().all()
    )
    if base_ids:
        all_ids = await label_tree.expand_ids(db, base_ids)
        child_names = set(
            (
                await db.execute(
                    select(LabelDefinition.display_name).where(LabelDefinition.id.in_(all_ids))
                )
            ).scalars().all()
        )
        seed |= child_names
        seed |= {k for k, v in ALIASES.items() if v in child_names}
    return sorted(seed)


TEST_SET_RUN_ACTION = "model_test.eval_run"


async def get_test_set_recorded_runs(db: AsyncSession, test_set_ids: list[int]) -> dict[str, str]:
    """查询用户在这些测试集上明确点击跑过的模型版本集合：{ 'model_tag::mode': 'YYYY-MM-DD HH:MM:SS' }。"""
    if not test_set_ids:
        return {}
    rows = (
        await db.execute(
            select(AuditLog)
            .where(
                AuditLog.action == TEST_SET_RUN_ACTION,
                AuditLog.target_type == "model_test_set",
                AuditLog.target_id.in_(test_set_ids),
            )
            .order_by(AuditLog.id)
        )
    ).scalars().all()
    merged: dict[str, str] = {}
    for r in rows:
        try:
            d = json.loads(r.detail or "{}")
        except ValueError:
            continue
        for k, ts in (d.get("runs") or {}).items():
            if isinstance(k, str):
                s_ts = str(ts or "")
                if k not in merged or s_ts > merged[k]:
                    merged[k] = s_ts
    return merged


async def record_test_set_runs(
    db: AsyncSession,
    test_set_id: int,
    version_keys: list[str],
    user_id: int | None = None,
    ran_at: str | None = None,
) -> dict[str, str]:
    """记录某测试集跑过的模型版本（同测试集只维护一条记录，反复跑更新时间戳）。"""
    if not version_keys:
        return await get_test_set_recorded_runs(db, [test_set_id])
    rows = (
        await db.execute(
            select(AuditLog)
            .where(
                AuditLog.action == TEST_SET_RUN_ACTION,
                AuditLog.target_type == "model_test_set",
                AuditLog.target_id == test_set_id,
            )
            .order_by(AuditLog.id)
        )
    ).scalars().all()
    runs: dict[str, str] = {}
    for r in rows:
        try:
            runs.update((json.loads(r.detail or "{}") or {}).get("runs") or {})
        except ValueError:
            pass
    stamp = ran_at or datetime.now().isoformat(sep=" ", timespec="seconds")
    for vk in version_keys:
        if vk:
            runs[vk] = stamp
    if rows:
        rows[0].detail = json.dumps({"runs": runs}, ensure_ascii=False)
        if user_id is not None:
            rows[0].user_id = user_id
        for extra in rows[1:]:
            await db.delete(extra)
    else:
        db.add(
            AuditLog(
                user_id=user_id,
                action=TEST_SET_RUN_ACTION,
                target_type="model_test_set",
                target_id=test_set_id,
                detail=json.dumps({"runs": runs}, ensure_ascii=False),
            )
        )
    await db.commit()
    return runs


async def remove_test_set_run(
    db: AsyncSession, test_set_id: int, version_key: str | None = None
) -> dict[str, str]:
    """从测试集已跑记录中移除某个（或全部）模型版本记录（不动底层推理 JSON）。"""
    rows = (
        await db.execute(
            select(AuditLog)
            .where(
                AuditLog.action == TEST_SET_RUN_ACTION,
                AuditLog.target_type == "model_test_set",
                AuditLog.target_id == test_set_id,
            )
            .order_by(AuditLog.id)
        )
    ).scalars().all()
    if not rows:
        return {}
    if version_key is None:
        for r in rows:
            await db.delete(r)
        await db.commit()
        return {}
    runs: dict[str, str] = {}
    for r in rows:
        try:
            runs.update((json.loads(r.detail or "{}") or {}).get("runs") or {})
        except ValueError:
            pass
    runs.pop(version_key, None)
    if not runs:
        for r in rows:
            await db.delete(r)
    else:
        rows[0].detail = json.dumps({"runs": runs}, ensure_ascii=False)
        for extra in rows[1:]:
            await db.delete(extra)
    await db.commit()
    return runs


async def list_runs(
    db: AsyncSession,
    sample_ids: list[int] | None = None,
    allowed_keys: dict[str, str] | None = None,
) -> list[dict]:
    """有哪些 (模型, 版本) 可选，各跑了多少个样本，以及 JSON 输出里实际有哪些类别。
    allowed_keys 传入时只保留该字典里登记过的 'model_tag::mode'（测试集严格只看本集跑过的模型）。"""
    if allowed_keys is not None and not allowed_keys:
        return []
    q = select(SampleInferenceRun)
    if sample_ids:
        q = q.where(SampleInferenceRun.sample_id.in_(sample_ids))
    if allowed_keys is not None:
        tags = {vk.split("::", 1)[0] for vk in allowed_keys if "::" in vk}
        if tags:
            q = q.where(SampleInferenceRun.model_tag.in_(tags))
    rows = (await db.execute(q)).scalars().all()
    agg: dict[tuple[str, str], dict] = {}
    sample_run: dict[tuple[str, str], SampleInferenceRun] = {}
    for r in rows:
        vkey = f"{r.model_tag}::{r.mode}"
        if allowed_keys is not None and vkey not in allowed_keys:
            continue
        key = (r.model_tag, r.mode)
        cur = agg.setdefault(
            key,
            {"model_tag": r.model_tag, "mode": r.mode, "model_path": r.model_path, "n_samples": 0,
             "n_segments": 0, "last_run_at": None, "classes": []},
        )
        cur["n_samples"] += 1
        cur["n_segments"] += r.n_segments or 0
        ts = r.updated_at or r.created_at
        if ts and (cur["last_run_at"] is None or ts.isoformat() > cur["last_run_at"]):
            cur["last_run_at"] = ts.isoformat(sep=" ", timespec="seconds")
            sample_run[key] = r
        elif key not in sample_run:
            sample_run[key] = r
    if allowed_keys is not None:
        for (mtag, mode), cur in agg.items():
            rec_ts = allowed_keys.get(f"{mtag}::{mode}")
            if rec_ts:
                cur["last_run_at"] = rec_ts

    sem = asyncio.Semaphore(16)

    async def _fill_classes(key: tuple[str, str], r: SampleInferenceRun) -> None:
        if not r.json_path:
            return
        ver_tag = str(r.updated_at or r.created_at or "")
        data = await _read_json_cached(r.json_path, ver_tag, sem)
        if not data:
            return
        seen: list[str] = []
        for raw_name in (data.get("segments") or {}).keys():
            cname = ALIASES.get(raw_name, raw_name)
            if cname not in seen:
                seen.append(cname)
        agg[key]["classes"] = seen

    if sample_run:
        await asyncio.gather(*(_fill_classes(k, r) for k, r in sample_run.items()))
    return sorted(agg.values(), key=lambda x: (x["model_tag"], x["mode"]))


_BG_LABELS = {"活动", "静止/休息", "未佩戴"}


async def _diagnose_window_errors(
    db: AsyncSession,
    samples_by_id: dict[int, Sample],
    runs: dict[int, SampleInferenceRun],
    label: str,
    label_names: list[str],
    mode: str,
    w_details: list[dict],
    truth_task_ids: list[int] | None,
) -> None:
    """为误报（FP）/ 漏报（FN）窗口自动补充归因诊断（窗口类别识别错 / 置信度不足 / 后处理拦截 / 疑似人工漏标 / 相似动作混淆）。
    只读取有错误窗口的那几个样本 JSON（上限 40 个文件），不把逐秒 windows 常驻内存缓存，兼顾速度与内存。"""
    err_items = [d for d in w_details if d.get("verdict") in ("fp", "fn")]
    if not err_items:
        return
    err_sids = sorted({d["sample_id"] for d in err_items})
    target_set = set(label_names)

    # 1) 一次 SQL 拉出错误样本上的全部非待定人工标注，用于精确核对 FP 时段人工实际标了什么
    h_rows = await db.execute(
        select(
            Task.sample_id,
            LabelDefinition.display_name,
            AnnotationLabelItem.start_time_ms,
            AnnotationLabelItem.end_time_ms,
        )
        .join(AnnotationRecord, AnnotationRecord.task_id == Task.id)
        .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
        .join(LabelDefinition, LabelDefinition.id == AnnotationLabelItem.label_id)
        .where(
            Task.sample_id.in_(err_sids),
            AnnotationRecord.round_no == Task.round_no,
            AnnotationLabelItem.uncertain.is_(False),
            *([Task.id.in_(truth_task_ids)] if truth_task_ids is not None else [Task.status.in_(_REVIEWED)]),
        )
    )
    human_all: dict[int, list[tuple[int, int, str]]] = defaultdict(list)
    for sid, lname, s_ms, e_ms in h_rows.all():
        human_all[sid].append((int(s_ms), int(e_ms), ALIASES.get(lname, lname)))

    # 2) 仅对有错误窗口的样本按需并发读原始 JSON 的 windows 与 candidates（上限 40 个文件）
    err_spans_by_sid: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for d in err_items:
        segs = d["truth_segs"] if d["verdict"] == "fn" else d["pred_segs"]
        if segs:
            s0 = d["start_ms"] + segs[0][0]
            e0 = d["start_ms"] + segs[0][1]
            err_spans_by_sid[d["sample_id"]].append((s0 - 2500, e0 + 2500))

    raw_by_sid: dict[int, tuple[list[tuple[int, str, float, str | None, float]], list[tuple[int, int, str]]]] = {}
    sem = asyncio.Semaphore(16)

    async def _load_one(sid: int) -> None:
        s = samples_by_id.get(sid)
        run = runs.get(sid)
        spans = err_spans_by_sid.get(sid)
        if not s or not run or not run.json_path or not spans:
            return
        try:
            csv_start = await _csv_start_cached(s, sem)
        except PrelabelError:
            return
        async with sem:
            raw = await asyncio.to_thread(_read_json, run.json_path)
        if not raw:
            return
        win_list: list[tuple[int, str, float, str | None, float]] = []
        for w in raw.get("windows") or []:
            ts = parse_ts(w.get("ts") or w.get("start_ts"))
            if ts is None:
                continue
            ms = int(round((ts - csv_start).total_seconds() * 1000))
            if not any(lo <= ms <= hi for lo, hi in spans):
                continue
            probs = w.get("probs") or {}
            t_p = max((float(probs.get(nm, 0.0)) for nm in target_set), default=0.0)
            other_lbl: str | None = None
            other_p = 0.0
            for k, v in probs.items():
                if k in target_set:
                    continue
                fv = float(v)
                if fv > other_p:
                    other_p = fv
                    other_lbl = ALIASES.get(k, k)
            pred_lbl = str(w.get("label") or "")
            win_list.append((ms, pred_lbl, t_p, other_lbl, other_p))
        cand_list: list[tuple[int, int, str]] = []
        for c in raw.get("candidates") or []:
            a, b = parse_ts(c.get("start_ts")), parse_ts(c.get("end_ts"))
            if a and b and b > a:
                ca = int(round((a - csv_start).total_seconds() * 1000))
                cb = int(round((b - csv_start).total_seconds() * 1000))
                if any(ca <= hi and cb >= lo for lo, hi in spans):
                    cand_list.append((ca, cb, str(c.get("reason") or "")))
        raw_by_sid[sid] = (win_list, cand_list)

    await asyncio.gather(*(_load_one(sid) for sid in err_sids[:40]))

    is_strict = "strict" in (mode or "")
    strict_thr = 0.70 if is_strict else 0.45

    for d in err_items:
        sid = d["sample_id"]
        verdict = d["verdict"]
        segs = d["truth_segs"] if verdict == "fn" else d["pred_segs"]
        if not segs:
            continue
        span_s = d["start_ms"] + segs[0][0]
        span_e = d["start_ms"] + segs[0][1]
        dur_s = max(0.0, (span_e - span_s) / 1000.0)
        win_list, cand_list = raw_by_sid.get(sid, ([], []))
        near_w = [w for w in win_list if span_s - 1500 <= w[0] <= span_e + 1500]
        raw_max_p = max((w[2] for w in near_w), default=0.0)
        hi_ps = [w[2] for w in near_w if w[2] >= 0.30]
        raw_mean_p = (sum(hi_ps) / len(hi_ps)) if hi_ps else 0.0
        n_pred_target = sum(1 for w in near_w if w[1] in target_set)

        if verdict == "fn":
            in_low_cand = any(r == "low_conf" and a <= span_e + 2000 and b >= span_s - 2000 for a, b, r in cand_list)
            # 找最强的非目标预测类别
            top_other_lbl: str | None = None
            top_other_p = 0.0
            for _, pred_lbl, _, o_lbl, o_p in near_w:
                if o_lbl and o_p > top_other_p:
                    top_other_p = o_p
                    top_other_lbl = o_lbl
                elif pred_lbl and pred_lbl not in target_set and top_other_lbl is None:
                    top_other_lbl = ALIASES.get(pred_lbl, pred_lbl)

            if n_pred_target >= 2 and raw_max_p >= 0.70 and raw_mean_p >= strict_thr:
                d["diag"] = {
                    "code": "post_filter",
                    "title": "后处理拦截",
                    "detail": f"模型已高置信识别（峰值 {raw_max_p:.0%} / 均值 {raw_mean_p:.0%}，{n_pred_target} 窗），但被后处理规则过滤",
                    "tip": "调优方向：模型本身已认出，检查后处理物理门限（节律/陀螺仪/最短时长）或平滑参数",
                }
            elif raw_max_p >= 0.30 or in_low_cand:
                short_note = f"（动作仅 {dur_s:.1f}s，易被滑窗稀释）" if dur_s < 2.5 else ""
                d["diag"] = {
                    "code": "low_conf",
                    "title": "置信度不足 / 门槛偏严",
                    "detail": f"模型有响应（峰值 {raw_max_p:.0%} / 均值 {raw_mean_p:.0%}，{len(hi_ps)} 窗），未达输出门槛{short_note}",
                    "tip": "调优方向：可对比普通「稳定版v2」门槛，或扩充短/弱样本训练提升置信度",
                }
            elif near_w:
                other_s = f"主要判成了「{top_other_lbl}」（峰值 {top_other_p:.0%}），" if top_other_lbl else ""
                d["diag"] = {
                    "code": "misclass",
                    "title": "窗口类别识别错",
                    "detail": f"{other_s}目标类「{label}」最高仅 {raw_max_p:.0%}",
                    "tip": f"调优方向：模型特征区分度不足，需补充此类正样本与「{top_other_lbl or '干扰类'}」对比训练",
                }
            else:
                d["diag"] = {
                    "code": "low_conf",
                    "title": "窗口未检出",
                    "detail": f"该段（{dur_s:.1f}s）无逐窗口原始概率明细（端侧或精简输出）",
                    "tip": "调优方向：看视频核对动作强弱与起止，必要时补充此类训练样本",
                }
        else:  # verdict == "fp"
            seg_conf = float(segs[0][2]) if len(segs[0]) > 2 and segs[0][2] is not None else 0.0
            peak_p = max(float(d.get("max_conf") or 0.0), seg_conf, raw_max_p)
            ov_labels: list[str] = []
            for hs, he, hname in human_all.get(sid, []):
                if hs < span_e and he > span_s and hname not in target_set and hname not in ov_labels:
                    ov_labels.append(hname)
            specific_ov = [x for x in ov_labels if x not in _BG_LABELS]

            if specific_ov:
                ov_s = "、".join(specific_ov[:3])
                d["diag"] = {
                    "code": "confuse_similar",
                    "title": "相似动作混淆",
                    "detail": f"模型误报（峰值 {peak_p:.0%} / {dur_s:.1f}s），该时段人工实际标的是「{ov_s}」",
                    "tip": f"调优方向：把「{ov_s}」作为困难负样本加入训练或负例挖掘",
                }
            elif peak_p >= 0.85 and dur_s >= 3.0 and (not ov_labels or all(x == "活动" for x in ov_labels)):
                bg_s = "仅粗标「活动」" if ov_labels else "未标任何动作"
                d["diag"] = {
                    "code": "suspect_human_miss",
                    "title": "疑似人工漏标",
                    "detail": f"模型极高置信（峰值 {peak_p:.0%} / 持续 {dur_s:.1f}s），且该时段{bg_s}，建议优先看视频核对",
                    "tip": "调优方向：先看视频确认；若确为人工漏标，可在工作台一键补标并「审核入池剥离测试集」",
                }
            elif peak_p < 0.75 or dur_s < 2.5:
                ov_s = "、".join(ov_labels[:2]) if ov_labels else "无标注"
                d["diag"] = {
                    "code": "low_conf_fp",
                    "title": "低置信 / 边界误报",
                    "detail": f"置信度偏低或偏短（峰值 {peak_p:.0%} / {dur_s:.1f}s，原标注：{ov_s}），可由后处理阈值滤除",
                    "tip": "调优方向：可提高段均值置信度或最短时长门槛（如使用「抓挠严格」版本）",
                }
            else:
                ov_s = "、".join(ov_labels[:2]) if ov_labels else "无标注"
                d["diag"] = {
                    "code": "model_fp",
                    "title": "窗口误判",
                    "detail": f"模型高置信误判为「{label}」（峰值 {peak_p:.0%} / {dur_s:.1f}s），原标注为「{ov_s}」",
                    "tip": "调优方向：看视频确认非目标动作后，将该类干扰动作纳入负样本训练",
                }


async def evaluate(
    db: AsyncSession,
    sample_ids: list[int],
    versions: list[dict],
    label: str = "抓挠",
    iou_min: float = 0.3,
    conf_min: float = 0.0,
    windows: dict[int, list[tuple[int, int]]] | None = None,
    truth_task_ids: list[int] | None = None,
    include_curve: bool = True,
) -> dict:
    """
    一批样本、若干个 (模型, 版本)，各跟人工标注比一遍。
    windows：{样本 id: [(开始毫秒, 结束毫秒), …]}，给了就只算窗口里的（模型测试集用）。

    versions: [{"model_tag": ..., "mode": ...}, ...]
    返回每个版本的 P/R/F1、阈值曲线，以及两两之间的回归对照。
    """
    label_names = await _expand_eval_names(db, label)
    warnings: list[str] = []

    def _empty(msg: str, n_samples: int = 0) -> dict:
        # 形状跟正常结果一样：前端不用对"没结果"另写一套判断
        return {"versions": [], "diffs": [], "n_samples": n_samples, "n_truth": 0,
                "iou_min": iou_min, "warnings": [*warnings, msg]}

    # 只评人工审过的样本：没审过的没有正确答案，模型在上面标的每一段都会算成误报
    # truth_task_ids：只拿这些任务当正确答案（模型测试集）；它们审过了，样本才算审过
    # 给了测试集任务：不要求任务已审——测试集片段的「核对」状态由测试集自己管（前端可选只用核对过的）
    rq = select(Task.sample_id).where(Task.sample_id.in_(sample_ids))
    rq = rq.where(Task.id.in_(truth_task_ids)) if truth_task_ids is not None else rq.where(Task.status.in_(_REVIEWED))
    reviewed = set((await db.execute(rq)).scalars().all())
    if len(reviewed) < len(set(sample_ids)):
        warnings.append(f"{len(set(sample_ids)) - len(reviewed)} 个样本还没人工审过，不计分")
    if not reviewed:
        return _empty("这批样本都还没人工审过，没法评测——先审几条出来")

    # 几个版本只在**都跑过**的样本上比。某个版本没跑的样本如果也算进去，
    # 那里的人工片段全成了它的漏检，召回低的原因是"没跑"而不是"没认出来"
    covered = reviewed
    for v in versions:
        has = set(
            (
                await db.execute(
                    select(SampleInferenceRun.sample_id).where(
                        SampleInferenceRun.sample_id.in_(reviewed),
                        SampleInferenceRun.model_tag == v.get("model_tag"),
                        SampleInferenceRun.mode == v.get("mode"),
                    )
                )
            ).scalars().all()
        )
        if len(has) < len(reviewed):
            warnings.append(
                f"{v.get('model_tag')} · {v.get('mode')} 在这批里只跑了 {len(has)}/{len(reviewed)} 个样本"
            )
        covered = covered & has
    if not covered:
        return _empty("选的版本在这批样本上没有共同跑过的——先点「跑这几个版本」", len(reviewed))
    if len(covered) < len(reviewed):
        warnings.append(f"只在 {len(covered)} 个所有版本都跑过的样本上比，其余不计分")

    samples = (await db.execute(select(Sample).where(Sample.id.in_(covered)))).scalars().all()
    truths, uncertain_holes = await _human_by_sample(db, [s.id for s in samples], label_names, truth_task_ids)
    if windows is not None:
        truths = {sid: clip_to_windows(v, windows.get(sid, [])) for sid, v in truths.items()}
        truths = {sid: v for sid, v in truths.items() if v}
    if not truths:
        warnings.append(f"这批样本里没有人工标的「{label}」，只能看误报")

    out_versions: list[dict] = []
    # 每个版本命中了哪些人工片段：(sample_id, 人工片段下标)。两两对照时用它算
    # 「这一版命中、那一版没命中」，也就是回归/改进
    hit_sets: dict[str, set[tuple[int, int]]] = {}
    pred_cache: dict[str, dict[int, list[Seg]]] = {}

    for v in versions:
        model_tag, mode = v.get("model_tag"), v.get("mode")
        key = f"{model_tag}::{mode}"
        runs = {
            r.sample_id: r
            for r in (
                await db.execute(
                    select(SampleInferenceRun).where(
                        SampleInferenceRun.sample_id.in_([s.id for s in samples]),
                        SampleInferenceRun.model_tag == model_tag,
                        SampleInferenceRun.mode == mode,
                    )
                )
            ).scalars().all()
        }
        preds, missing, warn = await _run_segments(samples, runs, label_names)
        preds = {sid: _merge_sub_segs(v) for sid, v in preds.items()}
        if windows is not None:
            preds = {sid: clip_to_windows(v, windows.get(sid, [])) for sid, v in preds.items()}
        warnings.extend(warn)
        pred_cache[key] = preds

        tp = fp = fn = 0
        wtp = wfp = wfn = wtn = 0
        w_details: list[dict] = []
        ious: list[float] = []
        d_start_abs: list[int] = []
        d_end_abs: list[int] = []
        within_2s = 0
        hits: set[tuple[int, int]] = set()
        # 阈值曲线：每个阈值下重新数一遍 TP/FP（漏检数随阈值升高而增加）
        curve_tp = [0] * len(_THRESHOLDS)
        curve_fp = [0] * len(_THRESHOLDS)
        curve_fn = [0] * len(_THRESHOLDS)
        hit_confs: list[float] = []
        fp_confs: list[float] = []

        for s in samples:
            holes = (missing.get(s.id) or []) + (uncertain_holes.get(s.id) or [])
            t_all = truths.get(s.id) or []
            t_list = [t for t in t_all if not _overlaps_any(t, holes)]
            p_all = preds.get(s.id) or []
            p_list = [
                p
                for p in p_all
                if not _overlaps_any(p, holes) and (conf_min <= 0 or (p.conf is not None and p.conf >= conf_min))
            ]
            pairs, fps, fns = match(p_list, t_list, iou_min)
            tp += len(pairs)
            fp += len(fps)
            fn += len(fns)
            for pi, ti, v_iou in pairs:
                ious.append(v_iou)
                hits.add((s.id, ti))
                ds = abs(p_list[pi].start_ms - t_list[ti].start_ms)
                de = abs(p_list[pi].end_ms - t_list[ti].end_ms)
                d_start_abs.append(ds)
                d_end_abs.append(de)
                if ds <= 2000 and de <= 2000:
                    within_2s += 1
                if p_list[pi].conf is not None:
                    hit_confs.append(p_list[pi].conf)
            for pi in fps:
                if p_list[pi].conf is not None:
                    fp_confs.append(p_list[pi].conf)
            # 窗口级：每个测试窗口看「有/无」该类别（标注有 vs 预测有），并记录逐窗口明细供前端可视化分析
            if windows is not None:
                for ws, we in windows.get(s.id, []):
                    wt = [t for t in t_list if t.start_ms < we and t.end_ms > ws]
                    wp = [p for p in p_list if p.start_ms < we and p.end_ms > ws]
                    if wt and wp:
                        wtp += 1
                        verdict = "tp"
                    elif wp:
                        wfp += 1
                        verdict = "fp"
                    elif wt:
                        wfn += 1
                        verdict = "fn"
                    else:
                        wtn += 1
                        verdict = "tn"
                    w_pairs, w_fps, w_fns = match(wp, wt, iou_min)
                    confs = [p.conf for p in wp if p.conf is not None]
                    w_ious = [v for _, _, v in w_pairs]
                    w_errs = [
                        max(abs(wp[pi].start_ms - wt[ti].start_ms), abs(wp[pi].end_ms - wt[ti].end_ms))
                        for pi, ti, _ in w_pairs
                    ]
                    w_details.append({
                        "sample_id": s.id,
                        "start_ms": ws,
                        "end_ms": we,
                        "verdict": verdict,
                        "truth_n": len(wt),
                        "pred_n": len(wp),
                        "event_tp": len(w_pairs),
                        "event_fp": len(w_fps),
                        "event_fn": len(w_fns),
                        "max_conf": round(max(confs), 3) if confs else None,
                        "mean_iou": round(sum(w_ious) / len(w_ious), 3) if w_ious else None,
                        "max_edge_err_ms": max(w_errs) if w_errs else None,
                        "edge_aligned": (max(w_errs) <= 2000) if w_errs else None,
                        "truth_segs": [[max(ws, t.start_ms) - ws, min(we, t.end_ms) - ws] for t in wt],
                        "pred_segs": [
                            [max(ws, p.start_ms) - ws, min(we, p.end_ms) - ws, round(p.conf, 2) if p.conf is not None else None]
                            for p in wp
                        ],
                    })
            # 阈值曲线：按每个阈值过滤预测后重新配对
            if include_curve:
                for k, th in enumerate(_THRESHOLDS):
                    p_th = [p for p in p_list if p.conf is None or p.conf >= th]
                    pr, fpi, fni = match(p_th, t_list, iou_min)
                    curve_tp[k] += len(pr)
                    curve_fp[k] += len(fpi)
                    curve_fn[k] += len(fni)

        if windows is not None and w_details:
            await _diagnose_window_errors(
                db, {s.id: s for s in samples}, runs, label, label_names, mode or "", w_details, truth_task_ids,
            )

        hit_sets[key] = hits
        w_total = wtp + wfp + wfn + wtn
        out_versions.append(
            {
                "model_tag": model_tag,
                "mode": mode,
                "key": key,
                "n_samples_with_result": len(runs),
                **_prf(tp, fp, fn),
                "window": (
                    {
                        "n_windows": w_total,
                        "tn": wtn,
                        "accuracy": round((wtp + wtn) / w_total, 4) if w_total else 0.0,
                        **_prf(wtp, wfp, wfn),
                    }
                    if windows is not None
                    else None
                ),
                "window_details": w_details if windows is not None else None,
                "mean_iou": round(sum(ious) / len(ious), 4) if ious else None,
                "d_start_abs_mean_ms": round(sum(d_start_abs) / len(d_start_abs)) if d_start_abs else None,
                "d_end_abs_mean_ms": round(sum(d_end_abs) / len(d_end_abs)) if d_end_abs else None,
                "within_2s_ratio": round(within_2s / len(d_start_abs), 4) if d_start_abs else None,
                # 命中的和误报的置信度分布：误报的整体往上漂，说明"靠阈值过滤误报"
                # 这条路变难了，阈值得重新定
                "hit_conf_mean": round(sum(hit_confs) / len(hit_confs), 4) if hit_confs else None,
                "fp_conf_mean": round(sum(fp_confs) / len(fp_confs), 4) if fp_confs else None,
                "curve": [
                    {"threshold": th, **_prf(curve_tp[k], curve_fp[k], curve_fn[k])}
                    for k, th in enumerate(_THRESHOLDS)
                ] if include_curve else [],
            }
        )

    # 两两对照：以第一个版本为基准，看别的版本相对它改进/回归了多少
    diffs: list[dict] = []
    if len(out_versions) >= 2:
        base = out_versions[0]["key"]
        for other in out_versions[1:]:
            k = other["key"]
            gained = hit_sets[k] - hit_sets[base]  # 基准漏了、这一版找到了
            lost = hit_sets[base] - hit_sets[k]  # 基准找到了、这一版漏了 = 回归
            diffs.append(
                {
                    "base": base,
                    "other": k,
                    "gained": len(gained),
                    "lost": len(lost),
                    "both": len(hit_sets[base] & hit_sets[k]),
                    # 回归的具体位置，方便直接跳过去看
                    "lost_samples": sorted({sid for sid, _ in lost})[:50],
                }
            )

    return {
        "versions": out_versions,
        "diffs": diffs,
        "n_samples": len(samples),
        "n_truth": sum(len(v) for v in truths.values()),
        "iou_min": iou_min,
        "windowed": windows is not None,
        "warnings": warnings[:50],
    }


async def diff_versions(
    db: AsyncSession,
    sample_ids: list[int],
    a: dict,
    b: dict,
    label: str | None = None,
    iou_min: float = 0.3,
    max_samples: int = 30,
    edge_2s_ms: int = 2000,
) -> dict:
    """
    两版互比：同一批样本，A/B 各跑一遍，看两边答得一样不一样。

    跟 evaluate 的区别是**不需要人工标注**——A 和 B 互相就是参照物。
    回答的是"换了模型之后，哪些地方它俩吵起来了"：A 有 B 没有、B 有 A 没有、
    两边都有的**类别是不是一样**、以及同类别时起止差了多少。
    分歧样本可以按分歧数排序，直接跳过去看。

    label=None 比全部类别（默认）；给了类别就只看这一类，此时类别不可能不同。
    a/b: {"model_tag": ..., "mode": ...}
    """
    warnings: list[str] = []
    ids = sorted(set(sample_ids))
    key_a = f"{a.get('model_tag')}::{a.get('mode')}"
    key_b = f"{b.get('model_tag')}::{b.get('mode')}"
    if key_a == key_b:
        warnings.append("选的 A 和 B 是同一个版本，结果只会是两边完全一致")

    async def _runs_of(ref: dict) -> dict[int, SampleInferenceRun]:
        rows = (
            await db.execute(
                select(SampleInferenceRun).where(
                    SampleInferenceRun.sample_id.in_(ids),
                    SampleInferenceRun.model_tag == ref.get("model_tag"),
                    SampleInferenceRun.mode == ref.get("mode"),
                )
            )
        ).scalars().all()
        return {r.sample_id: r for r in rows}

    runs_a = await _runs_of(a)
    runs_b = await _runs_of(b)
    if len(runs_a) < len(ids):
        warnings.append(f"A（{key_a}）在这批里只跑了 {len(runs_a)}/{len(ids)} 个样本")
    if len(runs_b) < len(ids):
        warnings.append(f"B（{key_b}）在这批里只跑了 {len(runs_b)}/{len(ids)} 个样本")
    covered = set(runs_a) & set(runs_b)
    if not covered:
        return {
            "a": {**a, "key": key_a, "n_runs": len(runs_a)},
            "b": {**b, "key": key_b, "n_runs": len(runs_b)},
            "n_scope": len(ids),
            "n_covered": 0,
            "totals": {},
            "diverged_samples": [],
            "n_diverged": 0,
            "iou_min": iou_min,
            "edge_2s_ms": edge_2s_ms,
            "warnings": [*warnings, "两个版本没有共同跑过的样本——先点「跑这两个版本」"],
        }

    samples = (
        await db.execute(
            select(Sample).where(Sample.id.in_(covered)).order_by(Sample.id)
        )
    ).scalars().all()
    # 两边都读全部类别：选了某个类别时，它只决定"哪些片段算事件"，
    # 另一边读全类别才能回答"同一段它认成了什么"（A 说抓挠、B 说活动）
    pa, missing_a, warn_a = await _run_segments(samples, runs_a, None)
    pb, missing_b, warn_b = await _run_segments(samples, runs_b, None)
    warnings.extend(warn_a)
    warnings.extend(warn_b)

    n_seg_a = n_seg_b = 0
    n_matched = n_only_a = n_only_b = n_boundary_bad = 0
    n_label_diff = 0
    # 配对里就已经类别不同的（不选类别、全量比时会出现）
    n_pair_label_diff = 0
    n_time_compared = 0
    ious: list[float] = []
    d_start: list[int] = []
    d_end: list[int] = []
    within_2s = 0
    per_sample: list[dict] = []

    for s in samples:
        # 有一边读不出来（CSV 对不上之类）就没法比，跳过而不是算成"那边全漏"
        if s.id not in pa or s.id not in pb:
            continue
        # 采集掉数据的时段两边都不算：那是没采到，不是模型没认出来
        holes = (missing_a.get(s.id) or []) + (missing_b.get(s.id) or [])
        all_a = [x for x in (pa.get(s.id) or []) if not _overlaps_any(x, holes)]
        all_b = [x for x in (pb.get(s.id) or []) if not _overlaps_any(x, holes)]
        # 事件 = 选中的类别；不选类别时就是全部片段
        seg_a = [x for x in all_a if label is None or x.label == label]
        seg_b = [x for x in all_b if label is None or x.label == label]
        pairs, only_a, only_b = match(seg_a, seg_b, iou_min)

        n_seg_a += len(seg_a)
        n_seg_b += len(seg_b)
        n_matched += len(pairs)

        seg_rows: list[dict] = []
        sample_ds: list[int] = []
        sample_de: list[int] = []
        bad = 0
        label_diff = 0
        pair_label_diff = 0
        for ia, ib, v in pairs:
            sa, sb = seg_a[ia], seg_b[ib]
            same_label = sa.label == sb.label
            ious.append(v)
            if not same_label:
                # 同一时段两边认成了不同类别：这本身就是最大的分歧，起止差不用再算
                label_diff += 1
                pair_label_diff += 1
                ds = de = None
            else:
                ds = sb.start_ms - sa.start_ms
                de = sb.end_ms - sa.end_ms
                # 平均 Δ 要有个正负概念（整体偏早还是偏晚），±2s 占比看的是边界稳不稳
                n_time_compared += 1
                d_start.append(ds)
                d_end.append(de)
                sample_ds.append(ds)
                sample_de.append(de)
                if abs(ds) <= edge_2s_ms and abs(de) <= edge_2s_ms:
                    within_2s += 1
                else:
                    bad += 1
            seg_rows.append(
                {
                    "kind": "both",
                    "iou": round(v, 3),
                    "label_a": sa.label,
                    "label_b": sb.label,
                    "same_label": same_label,
                    "a": {"start_ms": sa.start_ms, "end_ms": sa.end_ms},
                    "b": {"start_ms": sb.start_ms, "end_ms": sb.end_ms},
                    "d_start_ms": ds,
                    "d_end_ms": de,
                }
            )
        # A 的事件在 B 那边没配到同类：先看 B 有没有把它认成**别的类别**。
        # 有 = 类别不一致（"A 说抓挠、B 说活动"），没有才是 B 真的漏了
        for ia in only_a:
            sa = seg_a[ia]
            hit = _best_overlap(sa, all_b, iou_min)
            if hit is None:
                n_only_a += 1
                seg_rows.append(
                    {
                        "kind": "only_a",
                        "label": sa.label,
                        "a": {"start_ms": sa.start_ms, "end_ms": sa.end_ms},
                    }
                )
                continue
            sb, v = hit
            label_diff += 1
            ious.append(v)
            seg_rows.append(
                {
                    "kind": "both",
                    "iou": round(v, 3),
                    "label_a": sa.label,
                    "label_b": sb.label,
                    "same_label": False,
                    "a": {"start_ms": sa.start_ms, "end_ms": sa.end_ms},
                    "b": {"start_ms": sb.start_ms, "end_ms": sb.end_ms},
                    "d_start_ms": None,
                    "d_end_ms": None,
                }
            )
        for ib in only_b:
            sb = seg_b[ib]
            hit = _best_overlap(sb, all_a, iou_min)
            if hit is None:
                n_only_b += 1
                seg_rows.append(
                    {
                        "kind": "only_b",
                        "label": sb.label,
                        "b": {"start_ms": sb.start_ms, "end_ms": sb.end_ms},
                    }
                )
                continue
            sa, v = hit
            label_diff += 1
            ious.append(v)
            seg_rows.append(
                {
                    "kind": "both",
                    "iou": round(v, 3),
                    "label_a": sa.label,
                    "label_b": sb.label,
                    "same_label": False,
                    "a": {"start_ms": sa.start_ms, "end_ms": sa.end_ms},
                    "b": {"start_ms": sb.start_ms, "end_ms": sb.end_ms},
                    "d_start_ms": None,
                    "d_end_ms": None,
                }
            )
        n_boundary_bad += bad
        n_label_diff += label_diff
        n_pair_label_diff += pair_label_diff
        seg_rows.sort(key=lambda r: (r.get("a") or r.get("b"))["start_ms"])
        per_sample.append(
            {
                "sample_id": s.id,
                "sample_code": s.sample_code,
                "n_a": len(seg_a),
                "n_b": len(seg_b),
                "matched": len(pairs),
                "only_a": len(only_a),
                "only_b": len(only_b),
                "label_diff": label_diff,
                "boundary_bad": bad,
                # 样本内的平均偏移：正数 = B 比 A 晚（只算类别相同的配对）
                "d_start_mean_ms": round(sum(sample_ds) / len(sample_ds)) if sample_ds else None,
                "d_end_mean_ms": round(sum(sample_de) / len(sample_de)) if sample_de else None,
                "diff_count": len(only_a) + len(only_b) + label_diff + bad,
                "segments": seg_rows[:80],
            }
        )

    diverged = [p for p in per_sample if p["diff_count"] > 0]
    diverged.sort(key=lambda p: (-p["diff_count"], p["sample_id"]))
    top = diverged[:max_samples]

    # 只要分歧样本的任务号：全部样本都查一遍在这批三万条时太贵
    if top:
        rows = await db.execute(
            select(Task.sample_id, Task.project_id, Task.id)
            .where(Task.sample_id.in_([p["sample_id"] for p in top]))
            .order_by(Task.id)
        )
        where: dict[int, tuple[int, int]] = {}
        for sid, pid, tid in rows.all():
            where.setdefault(sid, (pid, tid))
        for p in top:
            pid, tid = where.get(p["sample_id"], (None, None))
            p["project_id"] = pid
            p["task_id"] = tid

    return {
        "a": {**a, "key": key_a, "n_runs": len(runs_a)},
        "b": {**b, "key": key_b, "n_runs": len(runs_b)},
        "n_scope": len(ids),
        "n_covered": len(covered),
        "totals": {
            "n_seg_a": n_seg_a,
            "n_seg_b": n_seg_b,
            "matched": n_matched,
            "only_a": n_only_a,
            "only_b": n_only_b,
            # 同一时段两边认的类别不一样：换了模型之后最容易出问题的地方
            "label_diff": n_label_diff,
            # 分母 = 类别相同的配对 + 类别不同的配对（包括"一边有事件、另一边认成别的类别"）
            "label_same_ratio": round(
                (n_matched - n_pair_label_diff)
                / (n_matched - n_pair_label_diff + n_label_diff),
                4,
            )
            if (n_matched - n_pair_label_diff + n_label_diff)
            else None,
            "boundary_bad": n_boundary_bad,
            "mean_iou": round(sum(ious) / len(ious), 4) if ious else None,
            "d_start_mean_ms": round(sum(d_start) / len(d_start)) if d_start else None,
            "d_end_mean_ms": round(sum(d_end) / len(d_end)) if d_end else None,
            "d_start_abs_mean_ms": round(sum(abs(x) for x in d_start) / len(d_start)) if d_start else None,
            "d_end_abs_mean_ms": round(sum(abs(x) for x in d_end) / len(d_end)) if d_end else None,
            # 分母是类别相同、能比较起止的配对，不是全部配对
            "within_2s_ratio": round(within_2s / n_time_compared, 4) if n_time_compared else None,
        },
        "n_diverged": len(diverged),
        "diverged_samples": top,
        "iou_min": iou_min,
        "edge_2s_ms": edge_2s_ms,
        "warnings": warnings[:50],
    }


# ── 评测跑批：几个版本对同一批样本各跑一遍，只存结果不写草稿 ──────────────

_eval_progress: dict = {"status": "idle", "total": 0, "done": 0, "failed": 0, "current": None, "detail": [], "produced": []}
_eval_running = False


def eval_run_progress() -> dict:
    return dict(_eval_progress)


async def start_eval_run(
    sample_ids: list[int],
    modes: list[str],
    test_set_id: int | None = None,
    user_id: int | None = None,
    force: bool = False,
) -> bool:
    """
    后台把这批样本按每个版本各跑一遍。返回 False = 已经有一批在跑。
    默认开启断点续跑（force=False）：自动跳过库里已跑过且 JSON 存在的样本。
    若传了 test_set_id，跑出结果后会自动登记到该测试集的已跑记录中。
    """
    global _eval_running
    if _eval_running:
        return False
    _eval_running = True
    asyncio.create_task(_run_eval(sample_ids, modes, test_set_id=test_set_id, user_id=user_id, force=force))
    return True


async def _existing_run_sample_ids(
    db: AsyncSession,
    sample_ids: list[int],
    mode: str,
) -> tuple[set[int], str | None]:
    """查询这批样本中该 mode 已落库且 NAS JSON 存在的 sample_id 集合，返回 (done_ids, produced_key)。"""
    from app.services import algo_client, edge_client
    from app.services.ai_prelabel_service import model_tag_of

    if not sample_ids:
        return set(), None
    if edge_client.is_edge(mode):
        tag = model_tag_of(f"edge://{edge_client.model_of(mode)}.edge")
        post = edge_client.post_mode_of(mode)
        q = select(SampleInferenceRun).where(
            SampleInferenceRun.sample_id.in_(sample_ids),
            SampleInferenceRun.model_tag == tag,
            SampleInferenceRun.mode == post,
        )
    elif algo_client.is_srv(mode):
        q = select(SampleInferenceRun).where(
            SampleInferenceRun.sample_id.in_(sample_ids),
            SampleInferenceRun.mode == mode,
        )
    else:
        return set(), None

    rows = (await db.execute(q)).scalars().all()
    done_ids: set[int] = set()
    pkey: str | None = None
    for r in rows:
        if r.json_path and os.path.isfile(os.path.join(settings.nas_root, r.json_path)):
            done_ids.add(r.sample_id)
            if pkey is None:
                pkey = f"{r.model_tag}::{r.mode}"
    return done_ids, pkey


async def _run_eval(
    sample_ids: list[int],
    modes: list[str],
    test_set_id: int | None = None,
    user_id: int | None = None,
    force: bool = False,
) -> None:
    global _eval_running
    from app.db.session import SessionLocal
    from app.services import algo_client, edge_client
    from app.services.ai_prelabel_service import model_tag_of, store_run_only

    _eval_progress.update(
        {"status": "running", "total": len(sample_ids) * len(modes), "done": 0, "failed": 0,
         "current": None, "detail": [], "produced": []}
    )
    try:
        async with SessionLocal() as db:
            samples = (await db.execute(select(Sample).where(Sample.id.in_(sample_ids)))).scalars().all()
        no_csv = [s for s in samples if not s.imu_csv_path]
        samples = [s for s in samples if s.imu_csv_path]
        # 总数按真正要跑的算，不然没有 IMU 的样本会让进度条永远到不了 100%
        _eval_progress["total"] = len(samples) * len(modes)
        if no_csv:
            _eval_progress["detail"].append(f"{len(no_csv)} 个样本没有 IMU 数据，跳过")
        chunk = max(1, settings.algo_infer_batch_size)
        all_ids = [s.id for s in samples]
        for mode in modes:
            todo = samples
            if not force:
                async with SessionLocal() as db:
                    done_ids, existing_pkey = await _existing_run_sample_ids(db, all_ids, mode)
                if done_ids:
                    todo = [s for s in samples if s.id not in done_ids]
                    _eval_progress["done"] += len(done_ids)
                    if existing_pkey and existing_pkey not in _eval_progress["produced"]:
                        _eval_progress["produced"].append(existing_pkey)
                        if test_set_id is not None:
                            async with SessionLocal() as rdb:
                                await record_test_set_runs(rdb, test_set_id, [existing_pkey], user_id=user_id)
                    if todo:
                        _eval_progress["detail"].append(f"{mode}：跳过 {len(done_ids)} 个已跑样本，补跑剩余 {len(todo)} 个")
                    else:
                        _eval_progress["detail"].append(f"{mode}：全部 {len(done_ids)} 个样本已存在，直接复用")
                        continue
            for i in range(0, len(todo), chunk):
                part = todo[i : i + chunk]
                _eval_progress["current"] = f"{mode} · 补跑 {i + 1}~{i + len(part)} / {len(todo)}" if len(todo) < len(samples) else f"{mode} · {i + 1}~{i + len(part)} / {len(samples)}"
                batch = [{"path": s.imu_csv_path, "sample_id": s.id} for s in part]
                try:
                    results = await edge_client.dispatch_batch(batch, mode)
                except (algo_client.AlgoServiceError, edge_client.EdgeServiceError) as e:
                    _eval_progress["failed"] += len(part)
                    _eval_progress["detail"].append(f"{mode}：这一批失败 {e}")
                    continue
                by_id = {int(r["sample_id"]): r for r in results if isinstance(r, dict) and r.get("sample_id")}
                for s in part:
                    r = by_id.get(s.id)
                    payload = (r or {}).get("result") if isinstance(r, dict) else None
                    if not r or not r.get("ok") or not payload:
                        _eval_progress["failed"] += 1
                        _eval_progress["detail"].append(f"{s.sample_code}［{mode}］失败：{(r or {}).get('error')}")
                        continue
                    try:
                        await store_run_only(s, payload, strict=True)
                        _eval_progress["done"] += 1
                        pkey = f"{model_tag_of(payload.get('model_path'))}::{payload.get('mode') or 'raw'}"
                        if pkey not in _eval_progress["produced"]:
                            _eval_progress["produced"].append(pkey)
                            if test_set_id is not None:
                                async with SessionLocal() as rdb:
                                    await record_test_set_runs(rdb, test_set_id, [pkey], user_id=user_id)
                    except Exception as e:  # noqa: BLE001 单个样本存不下不该中断整批
                        _eval_progress["failed"] += 1
                        _eval_progress["detail"].append(f"{s.sample_code}［{mode}］存不下：{type(e).__name__}: {e}")
                    del _eval_progress["detail"][:-60]
        if test_set_id is not None and _eval_progress["produced"]:
            async with SessionLocal() as rdb:
                await record_test_set_runs(rdb, test_set_id, list(_eval_progress["produced"]), user_id=user_id)
        _eval_progress["status"] = "done"
    except Exception as e:  # noqa: BLE001
        _logger.exception("评测跑批失败")
        _eval_progress.update({"status": "error", "current": f"{type(e).__name__}: {e}"})
    finally:
        _eval_progress["current"] = None
        _eval_running = False
