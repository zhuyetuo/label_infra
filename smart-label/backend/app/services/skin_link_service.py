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
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.skin_daily import SkinDailyStat
from app.models.task import Task, TaskStatus
from app.services.ai_prelabel_service import PrelabelError, _csv_start_of, ai_label_relpath, parse_ts

_logger = logging.getLogger(__name__)
_IMU_RE = re.compile(r"_imu(\d+)$", re.IGNORECASE)
_TS_FMT = "%Y-%m-%d %H:%M:%S.%f"
HUMAN_STATUSES = (TaskStatus.SUBMITTED, TaskStatus.APPROVED)
# 预读 NAS 上的 AI JSON / CSV 头时同时开几个：太少还是慢，太多会把 NAS 和默认
# 线程池（默认就 40 个槽）占满，反过来卡住别的请求
_IO_CONCURRENCY = 16


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
    include_drafts: bool = False,
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

    # 人工片段算哪些任务：
    #  - 已提交/已通过：走完了流程，肯定算
    #  - 「抓挠已确认」：从皮肤评估复看时只确认抓挠、不整份通过，任务还停在
    #    待认领。人明明看过了，人工版却当没这回事——这正是"确认了半天数字不动"
    #    的原因。所以只要这个任务当前轮的抓挠被人碰过（确认过 / 改过 / 标了
    #    待定），就算它有人工介入
    #  - include_drafts=True 时更宽：这天所有任务都算，自己一个人玩不走审核流程时用
    reviewed_task_ids: set[int] = set()
    if tasks and scratch_label_ids:
        rows = await db.execute(
            select(AnnotationRecord.task_id)
            .join(AnnotationLabelItem, AnnotationLabelItem.annotation_record_id == AnnotationRecord.id)
            .join(Task, Task.id == AnnotationRecord.task_id)
            .where(
                AnnotationRecord.task_id.in_([t.id for t in tasks]),
                AnnotationRecord.round_no == Task.round_no,
                AnnotationLabelItem.label_id.in_(scratch_label_ids),
                (AnnotationLabelItem.ai_confirmed.is_(True))
                | (AnnotationLabelItem.is_modified.is_(True))
                | (AnnotationLabelItem.uncertain.is_(True))
                | (AnnotationLabelItem.source_type == LabelItemSource.human_added),
            )
            .distinct()
        )
        reviewed_task_ids = {tid for (tid,) in rows.all()}
    human_tasks = (
        tasks if include_drafts
        else [t for t in tasks if t.status in HUMAN_STATUSES or t.id in reviewed_task_ids]
    )
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
                # 「待定」是"人看了但拿不准"，不算人已经定下来的抓挠
                AnnotationLabelItem.uncertain.is_(False),
            )
        )
        for task_id, s_ms, e_ms in rows.all():
            items_by_task[task_id].append((int(s_ms), int(e_ms)))

    # 按 (date, imu) 聚合
    key_of = lambda s: (s.session_date.isoformat(), imu_of(s.sample_code))  # noqa: E731
    ai_events: dict[tuple, list] = defaultdict(list)
    human_events: dict[tuple, list] = defaultdict(list)
    wear_spans: dict[tuple, list] = defaultdict(list)
    # 掉数据的时间段：算有效佩戴时从佩戴时段里扣掉
    missing_spans: dict[tuple, list] = defaultdict(list)
    counts: dict[tuple, dict] = defaultdict(lambda: {"total": 0, "approved": 0, "submitted": 0, "in_progress": 0, "pending": 0, "rejected": 0, "no_ai": 0, "reviewed": 0})
    ai_modes: dict[tuple, set] = defaultdict(set)

    # 两趟并发预读，别在主循环里一个样本一个样本地 await 磁盘。选两周就是一百多个
    # 样本，串行读 NAS 时每份都要等一个网络往返，「重新拉取」要跑好几分钟；这里
    # 并发起来（限流是怕把 NAS 打满，也怕线程池被占光），主循环变成纯内存聚合。
    # 空 CSV 的样本（采集时文件建出来了但一行数据都没写）在这里就要排掉。
    # 这一页读的是**样本表**，不是任务表——项目里把「无 CSV 任务」删掉只是删了任务，
    # 样本还在，所以以前每次拉取都还会撞上它们，然后为每一个报一条"AI 结果读不出来 /
    # 读时间戳失败"。它们本来就没有数据，算不出任何东西，跳过就是了。
    # row_count 为 None 是导入时没统计到，不能当成空，照常处理。
    empty = [s for s in samples if s.imu_row_count == 0]
    valid = [s for s in samples if key_of(s)[1] is not None and s.imu_row_count != 0]
    for s in samples:
        if key_of(s)[1] is None:
            warnings.append(f"样本 {s.sample_code} 编号里没有 _imu 后缀，跳过")
    if empty:
        # 汇总成一条：几十个空文件刷几十条警告，真正要看的问题会被淹掉
        warnings.append(
            f"跳过 {len(empty)} 个空 CSV 样本（文件在但没有数据行，算不出任何指标）："
            + "、".join(s.sample_code for s in empty[:5])
            + ("…" if len(empty) > 5 else "")
        )

    sem = asyncio.Semaphore(_IO_CONCURRENCY)

    async def _guarded(fn, *a):
        async with sem:
            return await asyncio.to_thread(fn, *a)

    ai_data: dict[int, dict | None] = {}
    # 没登记 CSV 路径的样本连 AI JSON 的路径都拼不出来，直接当没有
    with_csv = [s for s in valid if s.imu_csv_path]
    for s, res in zip(
        with_csv,
        await asyncio.gather(
            *(_guarded(_read_ai_json, ai_label_relpath(s.imu_csv_path)) for s in with_csv), return_exceptions=True
        ),
    ):
        if isinstance(res, BaseException):
            warnings.append(f"样本 {s.sample_code} 的 AI 结果读不出来：{type(res).__name__}: {res}")
            ai_data[s.id] = None
        else:
            ai_data[s.id] = res

    # 第二趟：哪些样本还需要 CSV 起点（有人工片段要换算，或者没 AI JSON 拿不到佩戴时段）
    def _span_of(data: dict | None) -> tuple[datetime, datetime] | None:
        if not data:
            return None
        ts = [t for t in (parse_ts(w.get("ts")) for w in data.get("windows") or []) if t is not None]
        return (min(ts), max(ts)) if ts else None

    def _missing_of(data: dict | None) -> list[tuple[datetime, datetime]]:
        """AI 结果里记的掉数据时间段（六轴全 0 / MISSING）。这段没有真实数据，
        算有效佩戴时要扣掉——不扣的话每天都是 23.9 小时，这个指标就没意义了。"""
        out = []
        for m in (data or {}).get("missing") or []:
            a, b = parse_ts(m.get("start_ts")), parse_ts(m.get("end_ts"))
            if a and b and b > a:
                out.append((a, b))
        return out

    spans_by_sample = {s.id: _span_of(ai_data.get(s.id)) for s in valid}
    missing_by_sample = {s.id: _missing_of(ai_data.get(s.id)) for s in valid}
    need_start = [
        s
        for s in valid
        if spans_by_sample[s.id] is None
        or any(items_by_task.get(t.id) for t in tasks_by_sample.get(s.id, []))
    ]

    async def _start_of(s: Sample):
        async with sem:
            return await _csv_start_of(s)

    csv_starts: dict[int, datetime | None] = {}
    for s, res in zip(need_start, await asyncio.gather(*(_start_of(s) for s in need_start), return_exceptions=True)):
        if isinstance(res, PrelabelError):
            warnings.append(f"样本 {s.sample_code}：{res}")
            csv_starts[s.id] = None
        elif isinstance(res, BaseException):
            warnings.append(f"样本 {s.sample_code} 读时间戳失败：{type(res).__name__}: {res}")
            csv_starts[s.id] = None
        else:
            csv_starts[s.id] = res

    for s in valid:
        key = key_of(s)
        s_tasks = tasks_by_sample.get(s.id, [])
        c = counts[key]
        c["total"] += len(s_tasks)
        for t in s_tasks:
            if t.id in reviewed_task_ids:
                c["reviewed"] += 1
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

        data = ai_data.get(s.id)
        span = spans_by_sample.get(s.id)
        if data:
            ai_modes[key].add(str(data.get("mode") or "raw"))
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
        csv_start = csv_starts.get(s.id)
        if span is None and csv_start is not None and s.video_duration_sec:
            span = (csv_start, csv_start + timedelta(seconds=int(s.video_duration_sec)))
        if span is not None:
            wear_spans[key].append(span)
        missing_spans[key].extend(missing_by_sample.get(s.id) or [])
        if csv_start is not None:
            for t in s_tasks:
                for s_ms, e_ms in items_by_task.get(t.id, []):
                    human_events[key].append(
                        (csv_start + timedelta(milliseconds=s_ms), csv_start + timedelta(milliseconds=e_ms))
                    )

    def _merge_events(spans):
        """把真正压在一起的事件并成一条。返回排好序的 [(起, 止), ...]。

        为什么必须并：这些事件是原样送给 algo_service 去算「今天抓了几次、共多久」
        的，中间没有任何去重。而重复的抓挠片段是会产生的——从「疑似抓挠」里确认
        一条候选时，代码是无条件新增一条片段，不看同类别是不是已经有一条压在同一
        段时间上。于是同一次抓挠被算成两次，时长也被重复计入，C 值跟着虚高。
        皮肤评估是拿来判断要不要干预的，数字虚高比没有数字更糟。

        只并**真正重叠**的（后一条的起点严格早于前一条的终点），紧挨着的不并——
        22:00:05 结束、22:00:05 开始的两条，很可能就是分开的两次，并了反而少算。
        """
        out: list[list] = []
        for st, en in sorted(spans):
            if out and st < out[-1][1]:
                out[-1][1] = max(out[-1][1], en)
            else:
                out.append([st, en])
        return [(a, b) for a, b in out]

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
        # 有效佩戴 = CSV 覆盖的时间 − 掉数据的时间。不扣的话每天都是 23.9 小时，
        # 这一列就没意义了：蓝牙断了几个小时也照样显示"戴满一天"
        wear = max(0.0, _union_seconds(wear_spans.get(k, [])) - _union_seconds(missing_spans.get(k, [])))
        # AI 版：这天只要有 AI JSON 就出一行（没抓挠也是"0 次"，不是"没数据"）
        if counts[k]["total"] - counts[k]["no_ai"] > 0 or ai_events.get(k):
            ai_rows.append({"date": k[0], "imu": k[1],
                            "events": [[_fmt(a), _fmt(b)] for a, b in _merge_events(ai_events.get(k, []))],
                            "wear_seconds": wear})
        # 人工版：默认要有任务提交/通过；include_drafts 时只要这天有任务就出一行
        has_human = (
            counts[k]["total"] > 0
            if include_drafts
            else counts[k]["approved"] + counts[k]["submitted"] + counts[k]["reviewed"] > 0
        )
        if has_human:
            human_rows.append({"date": k[0], "imu": k[1],
                               "events": [[_fmt(a), _fmt(b)] for a, b in _merge_events(human_events.get(k, []))],
                               "wear_seconds": wear})

    # 这一趟算出来的事件先落库（同 日期+IMU+来源 覆盖），再连同库里其它天一起
    # 送去算——基线是"这只狗别的日子的中位数"，只拿本次选的范围算会偏，范围里
    # 只有一天时干脆没有基线（C 值上限只有 70）
    await _upsert_events(db, "ai", ai_rows, counts, ai_modes)
    await _upsert_events(db, "human", human_rows, counts, ai_modes)
    await db.flush()

    ai_stats, human_stats = await _stats_with_full_baseline(db, scratch_label, warnings)

    if not keys:
        warnings.append(f"这段日期里有 {len(samples)} 个样本，但样本编号都取不到 _imu 后缀，没法按狗归类")

    out_rows = []
    for k in keys:
        c = counts[k]
        human_done = c["total"] if include_drafts else c["approved"] + c["submitted"]
        human_all = c["total"] if include_drafts else c["approved"]
        out_rows.append({
            "date": k[0],
            "imu": k[1],
            "tasks": c,
            "ai_mode": sorted(ai_modes.get(k, [])),
            "ai": ai_stats.get(k),
            "human": human_stats.get(k),
            # 人工完整 = 这天所有任务都已通过；部分 = 有提交/通过但没全通过
            "human_status": "complete" if c["total"] and human_all == c["total"] else ("partial" if human_done else "none"),
        })
    # 这一趟是刚算的，界面上要显示"上次拉取时间"
    return {"rows": out_rows, "warnings": warnings, "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


# ── 落库 & 用全部历史天数算基线 ──────────────────────────────────────────

async def _upsert_events(db: AsyncSession, source: str, rows: list[dict], counts: dict, ai_modes: dict) -> None:
    """把这一趟算出来的事件写进 skin_daily_stats，同 (日期, IMU, 来源) 覆盖。"""
    for r in rows:
        key = (r["date"], r["imu"])
        stat_date = date.fromisoformat(r["date"])
        existing = (
            await db.execute(
                select(SkinDailyStat).where(
                    SkinDailyStat.stat_date == stat_date,
                    SkinDailyStat.imu == r["imu"],
                    SkinDailyStat.source == source,
                )
            )
        ).scalar_one_or_none()
        row = existing or SkinDailyStat(stat_date=stat_date, imu=r["imu"], source=source)
        row.events = json.dumps(r["events"], ensure_ascii=False)
        row.wear_seconds = float(r.get("wear_seconds") or 0.0)
        row.tasks = json.dumps(counts.get(key, {}), ensure_ascii=False)
        row.ai_mode = ",".join(sorted(ai_modes.get(key, []))) or None
        if existing is None:
            db.add(row)


async def _stats_with_full_baseline(
    db: AsyncSession, scratch_label: str, warnings: list[str]
) -> tuple[dict[tuple, dict], dict[tuple, dict]]:
    """
    库里所有天（不只是这次选的范围）一起送去算日统计，基线才准；算完把结果写回
    对应行，之后直接读库不用再调 AI 服务。返回 (ai, human) 两个 {(date, imu): {...}}。
    """
    stored = (await db.execute(select(SkinDailyStat))).scalars().all()
    by_source: dict[str, list[SkinDailyStat]] = defaultdict(list)
    for r in stored:
        by_source[r.source].append(r)

    # C 值每行要两次 HTTP，天数多了别一个个串着等
    sem = asyncio.Semaphore(8)

    async def _c_of(stat_row: dict) -> dict | None:
        async with sem:
            try:
                cin = await _algo_post("stats/to-c-inputs", stat_row)
                payload = {k: v for k, v in cin.items() if k not in ("fill_date", "dog_name", "warnings")}
                c = await _algo_post("c-score", payload)
                return {
                    "c_inputs": cin,
                    "c": {"total": c.get("total"), "tier": c.get("tier"), "red_flags": c.get("red_flags")},
                    # 各项得分原样留着，前端 tooltip 要展示"这 85 分怎么来的"
                    "c_detail": c,
                }
            except SkinLinkError:
                return None

    async def _one_source(source: str, which: str) -> dict[tuple, dict]:
        rows = by_source.get(source) or []
        if not rows:
            return {}
        payload = [
            {"date": r.stat_date.isoformat(), "imu": r.imu, "events": json.loads(r.events), "wear_seconds": r.wear_seconds}
            for r in rows
        ]
        try:
            res = await _algo_post("stats/from-events", {"rows": payload, "target_label": scratch_label})
        except SkinLinkError as e:
            warnings.append(f"{which}的统计没算成：{e}")
            return {}
        stat_rows = res.get("rows") or []
        cs = await asyncio.gather(*(_c_of(sr) for sr in stat_rows))
        by_key = {(r.stat_date.isoformat(), r.imu): r for r in rows}
        out: dict[tuple, dict] = {}
        for sr, cres in zip(stat_rows, cs):
            key = (sr["date"], sr["imu"])
            item = {
                "stats": sr,
                "c_inputs": (cres or {}).get("c_inputs"),
                "c": (cres or {}).get("c") or {"total": None, "tier": None, "red_flags": []},
                "c_detail": (cres or {}).get("c_detail"),
            }
            out[key] = item
            db_row = by_key.get(key)
            if db_row is not None:
                db_row.stats = json.dumps(sr, ensure_ascii=False)
                db_row.c_inputs = json.dumps(item["c_inputs"], ensure_ascii=False) if item["c_inputs"] else None
                db_row.c_detail = json.dumps(item["c_detail"], ensure_ascii=False) if item["c_detail"] else None
                db_row.c_value = item["c"].get("total")
                db_row.c_tier = item["c"].get("tier")
        return out

    ai = await _one_source("ai", "AI 版")
    human = await _one_source("human", "人工版")
    await db.commit()
    return ai, human


async def read_stored_link_stats(db: AsyncSession, date_from: date, date_to: date) -> dict:
    """直接读库里存好的结果，不调 AI 服务、不扫 NAS——打开页面默认走这条路。"""
    rows = (
        await db.execute(
            select(SkinDailyStat)
            .where(SkinDailyStat.stat_date >= date_from, SkinDailyStat.stat_date <= date_to)
            .order_by(SkinDailyStat.stat_date, SkinDailyStat.imu)
        )
    ).scalars().all()
    by_key: dict[tuple, dict] = {}
    for r in rows:
        key = (r.stat_date.isoformat(), r.imu)
        entry = by_key.setdefault(
            key,
            {"date": key[0], "imu": key[1], "tasks": {}, "ai_mode": [], "ai": None, "human": None, "human_status": "none"},
        )
        if r.stats:
            entry[r.source] = {
                "stats": json.loads(r.stats),
                "c_inputs": json.loads(r.c_inputs) if r.c_inputs else None,
                "c_detail": json.loads(r.c_detail) if r.c_detail else None,
                "c": {"total": r.c_value, "tier": r.c_tier, "red_flags": []},
            }
        if r.tasks:
            try:
                t = json.loads(r.tasks)
                if t:
                    entry["tasks"] = t
            except ValueError:
                pass
        if r.ai_mode:
            entry["ai_mode"] = sorted(set(entry["ai_mode"]) | set(r.ai_mode.split(",")))
    for entry in by_key.values():
        c = entry["tasks"] or {}
        total, approved = c.get("total", 0), c.get("approved", 0)
        done = approved + c.get("submitted", 0)
        entry["human_status"] = "complete" if total and approved == total else ("partial" if done else "none")
    out = [by_key[k] for k in sorted(by_key)]
    msg = [] if out else [f"{date_from} ~ {date_to} 还没算过，点「重新拉取」算一次（之后就一直存着，不用再算）"]
    # 这批数字是什么时候拉的——过了几天再看这张表，得知道它是不是还反映当前的标注
    last = max((r.updated_at for r in rows if r.updated_at), default=None)
    return {"rows": out, "warnings": msg, "from_cache": True, "computed_at": last.isoformat(sep=" ", timespec="seconds") if last else None}
