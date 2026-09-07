"""
皮肤评估 PM 版 ↔ 标注平台任务的联动：把某段日期里各样本上的「抓挠」片段按
(日期, IMU) 聚合成事件列表，分两个来源各出一份：

- AI 版：data_labeled_ai/ 下稳定版预标注的原始 JSON（segments 里的绝对时间），
  不受后续人工改动影响，代表"模型说了什么"；
- 人工版：任务当前轮的片段（已提交 / 已通过的任务才算有人工介入），代表
  "人最后定了什么"。

事件列表发给 imu_train/label_service 的 /skin/stats/from-events 算成跟
imu_daily_scratch_stats.csv 同口径的日统计，再算 C 值输入和 C 值。狗的对应
关系走 IMU 编号（样本编号 _imu{N} → IMU{N} → PM 那边的 IMU_DOG_DEFAULT_MAP），
不依赖 dogs 表。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.annotation import AnnotationLabelItem, AnnotationRecord
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services.ai_prelabel_service import PrelabelError, _csv_start_of, ai_label_relpath, parse_ts

_logger = logging.getLogger(__name__)
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)
_TS_FMT = "%Y-%m-%d %H:%M:%S.%f"
HUMAN_STATUSES = (TaskStatus.SUBMITTED, TaskStatus.APPROVED)


class SkinLinkError(Exception):
    pass


def imu_of(sample_code: str) -> str | None:
    m = _IMU_RE.search(sample_code or "")
    return f"IMU{m.group(1)}" if m else None


def _fmt(t: datetime) -> str:
    return t.strftime(_TS_FMT)[:-3]


async def _algo_post(path: str, payload: dict) -> dict:
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/skin/{path}"
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise SkinLinkError(f"无法连接 AI 服务 ({url}): {e}") from e
    if resp.status_code != 200:
        raise SkinLinkError(f"AI 服务返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _read_ai_json(relpath: str) -> dict | None:
    full = os.path.join(settings.nas_root, relpath)
    if not os.path.isfile(full):
        return None
    try:
        with open(full, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


async def collect_link_stats(
    db: AsyncSession,
    date_from: date,
    date_to: date,
    project_id: int | None = None,
    scratch_label: str = "抓挠",
    ai_min_conf: float = 0.0,
) -> dict:
    """返回 {rows: [...], warnings: [...]}，rows 每行一个 (日期, IMU)。"""
    warnings: list[str] = []

    samples = (
        await db.execute(
            select(Sample).where(Sample.session_date >= date_from, Sample.session_date <= date_to).order_by(Sample.id)
        )
    ).scalars().all()
    if not samples:
        return {"rows": [], "warnings": [f"{date_from} ~ {date_to} 这段日期里没有样本（样本按 session_date 算，"
                                         f"就是文件名里的采集日期，不是项目名）"]}
    sample_ids = [s.id for s in samples]

    tq = select(Task).where(Task.sample_id.in_(sample_ids))
    if project_id is not None:
        tq = tq.where(Task.project_id == project_id)
    tasks = (await db.execute(tq)).scalars().all()
    tasks_by_sample: dict[int, list[Task]] = defaultdict(list)
    for t in tasks:
        tasks_by_sample[t.sample_id].append(t)

    # 「抓挠」标签在各项目里的 id（按显示名，退一步按 code）
    label_rows = (
        await db.execute(
            select(LabelDefinition.id).where(
                (LabelDefinition.display_name == scratch_label) | (LabelDefinition.code == scratch_label)
            )
        )
    ).scalars().all()
    scratch_label_ids = set(label_rows)

    # 人工片段：已提交/已通过任务当前轮的记录
    human_tasks = [t for t in tasks if t.status in HUMAN_STATUSES]
    items_by_task: dict[int, list[tuple[int, int]]] = defaultdict(list)
    if human_tasks and scratch_label_ids:
        rows = await db.execute(
            select(AnnotationRecord.task_id, AnnotationLabelItem.start_time_ms, AnnotationLabelItem.end_time_ms)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .join(Task, Task.id == AnnotationRecord.task_id)
            .where(
                AnnotationRecord.task_id.in_([t.id for t in human_tasks]),
                AnnotationRecord.round_no == Task.round_no,
                AnnotationLabelItem.label_id.in_(scratch_label_ids),
            )
        )
        for task_id, s_ms, e_ms in rows.all():
            items_by_task[task_id].append((int(s_ms), int(e_ms)))

    # 按 (date, imu) 聚合
    key_of = lambda s: (s.session_date.isoformat(), imu_of(s.sample_code))  # noqa: E731
    ai_events: dict[tuple, list] = defaultdict(list)
    human_events: dict[tuple, list] = defaultdict(list)
    wear_spans: dict[tuple, list] = defaultdict(list)
    counts: dict[tuple, dict] = defaultdict(lambda: {"total": 0, "approved": 0, "submitted": 0, "in_progress": 0, "pending": 0, "rejected": 0, "no_ai": 0})
    ai_modes: dict[tuple, set] = defaultdict(set)

    for s in samples:
        key = key_of(s)
        if key[1] is None:
            warnings.append(f"样本 {s.sample_code} 编号里没有 _imu 后缀，跳过")
            continue
        s_tasks = tasks_by_sample.get(s.id, [])
        c = counts[key]
        c["total"] += len(s_tasks)
        for t in s_tasks:
            if t.status == TaskStatus.APPROVED:
                c["approved"] += 1
            elif t.status == TaskStatus.SUBMITTED:
                c["submitted"] += 1
            elif t.status == TaskStatus.IN_PROGRESS:
                c["in_progress"] += 1
            elif t.status == TaskStatus.REJECTED:
                c["rejected"] += 1
            else:
                c["pending"] += 1

        data = await asyncio.to_thread(_read_ai_json, ai_label_relpath(s.imu_csv_path))
        span: tuple[datetime, datetime] | None = None
        if data:
            ai_modes[key].add(str(data.get("mode") or "raw"))
            ts = [parse_ts(w.get("ts")) for w in data.get("windows") or []]
            ts = [t for t in ts if t is not None]
            if ts:
                span = (min(ts), max(ts))
            for seg in (data.get("segments") or {}).get(scratch_label) or []:
                st, en = parse_ts(seg.get("start_ts")), parse_ts(seg.get("end_ts"))
                if st is None or en is None or en <= st:
                    continue
                conf = seg.get("conf_mean")
                if ai_min_conf and conf is not None and float(conf) < ai_min_conf:
                    continue
                ai_events[key].append((st, en))
        else:
            c["no_ai"] += 1

        # 人工片段要 CSV 起点换算绝对时间；没有 AI JSON 时佩戴时段也靠它
        need_csv_start = any(items_by_task.get(t.id) for t in s_tasks) or span is None
        csv_start: datetime | None = None
        if need_csv_start:
            try:
                csv_start = await _csv_start_of(s)
            except PrelabelError as e:
                warnings.append(f"样本 {s.sample_code}：{e}")
        if span is None and csv_start is not None and s.video_duration_sec:
            span = (csv_start, csv_start + timedelta(seconds=int(s.video_duration_sec)))
        if span is not None:
            wear_spans[key].append(span)
        if csv_start is not None:
            for t in s_tasks:
                for s_ms, e_ms in items_by_task.get(t.id, []):
                    human_events[key].append(
                        (csv_start + timedelta(milliseconds=s_ms), csv_start + timedelta(milliseconds=e_ms))
                    )

    def _union_seconds(spans) -> float:
        merged: list[list[datetime]] = []
        for st, en in sorted(spans):
            if merged and st <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], en)
            else:
                merged.append([st, en])
        return sum((en - st).total_seconds() for st, en in merged)

    keys = sorted(k for k in counts if k[1] is not None)
    ai_rows, human_rows = [], []
    for k in keys:
        wear = _union_seconds(wear_spans.get(k, []))
        # AI 版：这天只要有 AI JSON 就出一行（没抓挠也是"0 次"，不是"没数据"）
        if counts[k]["total"] - counts[k]["no_ai"] > 0 or ai_events.get(k):
            ai_rows.append({"date": k[0], "imu": k[1], "events": [[_fmt(a), _fmt(b)] for a, b in ai_events.get(k, [])], "wear_seconds": wear})
        # 人工版：至少有一个任务提交/通过才算有人工数据
        if counts[k]["approved"] + counts[k]["submitted"] > 0:
            human_rows.append({"date": k[0], "imu": k[1], "events": [[_fmt(a), _fmt(b)] for a, b in human_events.get(k, [])], "wear_seconds": wear})

    async def _stats(rows: list[dict], which: str) -> dict[tuple, dict]:
        if not rows:
            return {}
        try:
            res = await _algo_post("stats/from-events", {"rows": rows, "target_label": scratch_label})
            out = {}
            for r in res.get("rows") or []:
                cin = await _algo_post("stats/to-c-inputs", r)
                c_payload = {kk: vv for kk, vv in cin.items() if kk not in ("fill_date", "dog_name", "warnings")}
                c = await _algo_post("c-score", c_payload)
                out[(r["date"], r["imu"])] = {
                    "stats": r, "c_inputs": cin,
                    "c": {"total": c.get("total"), "tier": c.get("tier"), "red_flags": c.get("red_flags")},
                }
            return out
        except SkinLinkError as e:
            # AI 服务连不上/接口不存在（比如 label_service 没重启）时，别把整张表打空——
            # 任务进度这些本地算出来的照样有用，把原因写进 warnings 让人一眼看到
            warnings.append(f"{which}的统计没算成：{e}")
            return {}

    ai_stats, human_stats = await asyncio.gather(_stats(ai_rows, "AI 版"), _stats(human_rows, "人工版"))

    if not keys:
        warnings.append(f"这段日期里有 {len(samples)} 个样本，但样本编号都取不到 _imu 后缀，没法按狗归类")

    out_rows = []
    for k in keys:
        c = counts[k]
        human_done = c["approved"] + c["submitted"]
        out_rows.append({
            "date": k[0],
            "imu": k[1],
            "tasks": c,
            "ai_mode": sorted(ai_modes.get(k, [])),
            "ai": ai_stats.get(k),
            "human": human_stats.get(k),
            # 人工完整 = 这天所有任务都已通过；部分 = 有提交/通过但没全通过
            "human_status": "complete" if c["total"] and c["approved"] == c["total"] else ("partial" if human_done else "none"),
        })
    return {"rows": out_rows, "warnings": warnings}
