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
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.inference_run import SampleInferenceRun
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task
from app.services.ai_prelabel_service import PrelabelError, _csv_start_of, parse_ts

_logger = logging.getLogger("smart-label.model_eval")

# 阈值曲线按这个步长扫：0.05 够细了，再细图上也看不出差别
_THRESHOLDS = [round(x / 20, 2) for x in range(0, 20)]


@dataclass
class Seg:
    start_ms: int
    end_ms: int
    conf: float | None = None

    @property
    def dur(self) -> int:
        return max(0, self.end_ms - self.start_ms)


def _iou(a: Seg, b: Seg) -> float:
    inter = min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms)
    if inter <= 0:
        return 0.0
    union = a.dur + b.dur - inter
    return inter / union if union > 0 else 0.0


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


async def _human_by_sample(
    db: AsyncSession, sample_ids: list[int], label_names: list[str]
) -> tuple[dict[int, list[Seg]], dict[int, list[tuple[int, int]]]]:
    """
    人工标注（当前轮）按样本取。返回 (正确答案, 不算数的区间)。

    「待定」的片段进第二个返回值：那是人看了也拿不准的，模型标不标都不该扣分。
    """
    label_ids = set(
        (
            await db.execute(
                select(LabelDefinition.id).where(
                    LabelDefinition.display_name.in_(label_names) | LabelDefinition.code.in_(label_names)
                )
            )
        ).scalars().all()
    )
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
        )
    )
    truths: dict[int, list[Seg]] = defaultdict(list)
    holes: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for sid, s_ms, e_ms, uncertain in rows.all():
        if uncertain:
            holes[sid].append((int(s_ms), int(e_ms)))
        else:
            truths[sid].append(Seg(int(s_ms), int(e_ms)))
    for v in truths.values():
        v.sort(key=lambda x: x.start_ms)
    return truths, holes


async def _run_segments(
    samples: list[Sample], runs: dict[int, SampleInferenceRun], label_names: list[str]
) -> tuple[dict[int, list[Seg]], dict[int, list[tuple[int, int]]], list[str]]:
    """把一次跑的结果 JSON 读出来，换算成相对 CSV 起点的毫秒。"""
    preds: dict[int, list[Seg]] = {}
    missing: dict[int, list[tuple[int, int]]] = {}
    warnings: list[str] = []

    sem = asyncio.Semaphore(16)

    async def _one(s: Sample) -> None:
        run = runs.get(s.id)
        if run is None:
            return
        async with sem:
            data = await asyncio.to_thread(_read_json, run.json_path)
        if not data:
            warnings.append(f"样本 {s.sample_code} 的结果文件读不到：{run.json_path}")
            return
        try:
            csv_start = await _csv_start_of(s)
        except PrelabelError as e:
            warnings.append(f"样本 {s.sample_code}：{e}")
            return
        segs: list[Seg] = []
        for name in label_names:
            for seg in (data.get("segments") or {}).get(name) or []:
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


async def list_runs(db: AsyncSession, sample_ids: list[int] | None = None) -> list[dict]:
    """有哪些 (模型, 版本) 可选，各跑了多少个样本——对比页的下拉靠它。"""
    q = select(SampleInferenceRun)
    if sample_ids:
        q = q.where(SampleInferenceRun.sample_id.in_(sample_ids))
    rows = (await db.execute(q)).scalars().all()
    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        key = (r.model_tag, r.mode)
        cur = agg.setdefault(
            key,
            {"model_tag": r.model_tag, "mode": r.mode, "model_path": r.model_path, "n_samples": 0,
             "n_segments": 0, "last_run_at": None},
        )
        cur["n_samples"] += 1
        cur["n_segments"] += r.n_segments or 0
        ts = r.updated_at or r.created_at
        if ts and (cur["last_run_at"] is None or ts.isoformat() > cur["last_run_at"]):
            cur["last_run_at"] = ts.isoformat(sep=" ", timespec="seconds")
    return sorted(agg.values(), key=lambda x: (x["model_tag"], x["mode"]))


async def evaluate(
    db: AsyncSession,
    sample_ids: list[int],
    versions: list[dict],
    label: str = "抓挠",
    iou_min: float = 0.3,
    conf_min: float = 0.0,
) -> dict:
    """
    一批样本、若干个 (模型, 版本)，各跟人工标注比一遍。

    versions: [{"model_tag": ..., "mode": ...}, ...]
    返回每个版本的 P/R/F1、阈值曲线，以及两两之间的回归对照。
    """
    label_names = [label]
    samples = (await db.execute(select(Sample).where(Sample.id.in_(sample_ids)))).scalars().all()
    if not samples:
        return {"versions": [], "warnings": ["没有选中任何样本"]}
    truths, uncertain_holes = await _human_by_sample(db, [s.id for s in samples], label_names)
    if not truths:
        return {"versions": [], "warnings": ["这批样本还没有人工标注，没法评测——先审几条出来"]}

    warnings: list[str] = []
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
        warnings.extend(warn)
        pred_cache[key] = preds

        tp = fp = fn = 0
        ious: list[float] = []
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
                if p_list[pi].conf is not None:
                    hit_confs.append(p_list[pi].conf)
            for pi in fps:
                if p_list[pi].conf is not None:
                    fp_confs.append(p_list[pi].conf)
            # 阈值曲线：按每个阈值过滤预测后重新配对
            for k, th in enumerate(_THRESHOLDS):
                p_th = [p for p in p_list if p.conf is None or p.conf >= th]
                pr, fpi, fni = match(p_th, t_list, iou_min)
                curve_tp[k] += len(pr)
                curve_fp[k] += len(fpi)
                curve_fn[k] += len(fni)

        hit_sets[key] = hits
        out_versions.append(
            {
                "model_tag": model_tag,
                "mode": mode,
                "key": key,
                "n_samples_with_result": len(runs),
                **_prf(tp, fp, fn),
                "mean_iou": round(sum(ious) / len(ious), 4) if ious else None,
                # 命中的和误报的置信度分布：误报的整体往上漂，说明"靠阈值过滤误报"
                # 这条路变难了，阈值得重新定
                "hit_conf_mean": round(sum(hit_confs) / len(hit_confs), 4) if hit_confs else None,
                "fp_conf_mean": round(sum(fp_confs) / len(fp_confs), 4) if fp_confs else None,
                "curve": [
                    {"threshold": th, **_prf(curve_tp[k], curve_fp[k], curve_fn[k])}
                    for k, th in enumerate(_THRESHOLDS)
                ],
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
        "warnings": warnings[:50],
    }


# ── 评测跑批：几个版本对同一批样本各跑一遍，只存结果不写草稿 ──────────────

_eval_progress: dict = {"status": "idle", "total": 0, "done": 0, "failed": 0, "current": None, "detail": []}
_eval_running = False


def eval_run_progress() -> dict:
    return dict(_eval_progress)


async def start_eval_run(sample_ids: list[int], modes: list[str]) -> bool:
    """
    后台把这批样本按每个版本各跑一遍。返回 False = 已经有一批在跑。

    跟项目页那个「批量 AI 预标注」的区别：那个是为了给标注员铺草稿，一个任务
    只能有一份；这个纯粹是为了攒对比数据，几个版本的结果并存，谁也不写草稿。
    """
    global _eval_running
    if _eval_running:
        return False
    _eval_running = True
    asyncio.create_task(_run_eval(sample_ids, modes))
    return True


async def _run_eval(sample_ids: list[int], modes: list[str]) -> None:
    global _eval_running
    from app.db.session import SessionLocal
    from app.services import algo_client
    from app.services.ai_prelabel_service import store_run_only

    _eval_progress.update(
        {"status": "running", "total": len(sample_ids) * len(modes), "done": 0, "failed": 0,
         "current": None, "detail": []}
    )
    try:
        async with SessionLocal() as db:
            samples = (await db.execute(select(Sample).where(Sample.id.in_(sample_ids)))).scalars().all()
        samples = [s for s in samples if s.imu_csv_path]
        chunk = max(1, settings.algo_infer_batch_size)
        for mode in modes:
            for i in range(0, len(samples), chunk):
                part = samples[i : i + chunk]
                _eval_progress["current"] = f"{mode} · {i + 1}~{i + len(part)} / {len(samples)}"
                try:
                    results = await algo_client.infer_batch(
                        [{"path": s.imu_csv_path, "sample_id": s.id} for s in part], mode=mode
                    )
                except algo_client.AlgoServiceError as e:
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
                        await store_run_only(s, payload)
                        _eval_progress["done"] += 1
                    except Exception as e:  # noqa: BLE001 单个样本存不下不该中断整批
                        _eval_progress["failed"] += 1
                        _eval_progress["detail"].append(f"{s.sample_code}［{mode}］存不下：{type(e).__name__}: {e}")
                    del _eval_progress["detail"][:-60]
        _eval_progress["status"] = "done"
    except Exception as e:  # noqa: BLE001
        _logger.exception("评测跑批失败")
        _eval_progress.update({"status": "error", "current": f"{type(e).__name__}: {e}"})
    finally:
        _eval_progress["current"] = None
        _eval_running = False
