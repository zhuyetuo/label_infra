"""
AI 预标注：调 imu_train/label_service，把结果换算成标注工作台用的
"相对 CSV 起点毫秒"片段。

两个入口共用同一套换算：
- 单个样本（标注工作台里点"AI预标注"按钮）：infer_sample()，走 /infer，结果直接返回给前端
- 整个项目批量（项目页"AI预标注"按钮 / 建"AI预标注+人工修改"类型任务时自动）：
  start_project_prelabel() 后台跑，一批任务一次发给 /infer_batch（AI 服务那边用
  进程池按文件并行，一个请求就能把 CPU 吃满），拿到结果逐个写进任务当前轮的草稿，
  标注员打开任务就已经有 AI 框了；前端轮询 get_progress() 画进度条

批量分块发（每块 algo_infer_batch_size 个）：块太小并行度上不去，太大进度条半天不动。
"""

import asyncio
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.audit_log import AuditLog

_logger = logging.getLogger("smart-label.ai_prelabel")
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.schemas.model_version import PrelabelItem
from app.services import algo_client
from app.services.imu_service import ImuReadError, get_meta
from app.services.media_resolver import PathTraversalError, resolve_nas_path


class PrelabelError(Exception):
    """推理/换算失败，带一句能直接给用户看的中文。"""


# ---------------------------------------------------------------- 时间换算 ----

_TS_FORMATS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S")


def parse_ts(value: object) -> datetime | None:
    """
    解析 AI 服务/IMU meta 里的时间字符串。imu_train 用 strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    输出（毫秒精度），get_meta 给的是 isoformat。两边都是从同一个 CSV 的时间戳列来的，
    统一按 naive 时间比较；带时区的先把时区剥掉，避免 aware/naive 相减报错。
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        dt = None
        for fmt in _TS_FORMATS:
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
    if dt is None:
        return None
    return dt.replace(tzinfo=None)


def flatten_segments(segments: dict, csv_start: datetime) -> tuple[list[PrelabelItem], int]:
    """
    {类别: [{start_ts, end_ts, conf_max, ...}]} -> 按开始时间排好序的扁平列表，时间换成
    相对 CSV 起点的毫秒。时间戳缺失或换算后时长非正的片段跳过，只计数返回给前端提示。
    """
    items: list[PrelabelItem] = []
    skipped = 0
    for label_name, segs in segments.items():
        for seg in segs or []:
            start = parse_ts(seg.get("start_ts"))
            end = parse_ts(seg.get("end_ts"))
            if start is None or end is None:
                skipped += 1
                continue
            start_ms = int(round((start - csv_start).total_seconds() * 1000))
            end_ms = int(round((end - csv_start).total_seconds() * 1000))
            if end_ms <= start_ms or end_ms <= 0:
                skipped += 1
                continue
            conf = seg.get("conf_max")
            if conf is None:
                conf = seg.get("conf_mean")
            items.append(
                PrelabelItem(
                    label_name=str(label_name),
                    start_time_ms=max(0, start_ms),
                    end_time_ms=end_ms,
                    confidence=float(conf) if conf is not None else 0.0,
                )
            )
    items.sort(key=lambda it: (it.start_time_ms, it.end_time_ms))
    return items, skipped


@dataclass
class CandidateItem:
    """疑似抓挠候选：不进草稿，单独存 ai_candidates 给人工确认/排除。"""

    label_name: str
    start_time_ms: int
    end_time_ms: int
    confidence: float | None
    spec: float | None
    reason: str


@dataclass
class SampleInference:
    items: list[PrelabelItem]
    skipped: int
    n_windows: int
    ai_label_path: str
    candidates: list[CandidateItem] = field(default_factory=list)


def flatten_candidates(raw: list[dict], csv_start: datetime, scratch_label: str = "抓挠") -> list[CandidateItem]:
    out: list[CandidateItem] = []
    for c in raw or []:
        start, end = parse_ts(c.get("start_ts")), parse_ts(c.get("end_ts"))
        if start is None or end is None:
            continue
        s_ms = int(round((start - csv_start).total_seconds() * 1000))
        e_ms = int(round((end - csv_start).total_seconds() * 1000))
        if e_ms <= s_ms or e_ms <= 0:
            continue
        out.append(
            CandidateItem(
                label_name=scratch_label,
                start_time_ms=max(0, s_ms),
                end_time_ms=e_ms,
                confidence=float(c["conf_mean"]) if c.get("conf_mean") is not None else None,
                spec=float(c["spec"]) if c.get("spec") is not None else None,
                reason=str(c.get("reason") or "low_conf"),
            )
        )
    out.sort(key=lambda c: c.start_time_ms)
    return out


async def replace_candidates(db: AsyncSession, task: Task, cands: list[CandidateItem]) -> int:
    """整批换掉这个任务当前轮的候选；已经被人工决定过的（confirmed/rejected）留着不动。"""
    old = (
        await db.execute(
            select(AiCandidate).where(
                AiCandidate.task_id == task.id,
                AiCandidate.round_no == task.round_no,
                AiCandidate.status == CandidateStatus.pending,
            )
        )
    ).scalars().all()
    for o in old:
        await db.delete(o)
    for c in cands:
        db.add(
            AiCandidate(
                task_id=task.id, round_no=task.round_no, label_name=c.label_name,
                start_time_ms=c.start_time_ms, end_time_ms=c.end_time_ms,
                confidence=c.confidence, spec=c.spec, reason=c.reason,
            )
        )
    return len(cands)


async def _csv_start_of(sample: Sample) -> datetime:
    """读 CSV 第一行的时间，AI 片段的绝对时间要减掉它才是工作台用的相对毫秒。"""
    if not sample.imu_csv_path:
        raise PrelabelError("该样本没有 IMU CSV，无法做 AI 预标注")
    try:
        csv_abs = resolve_nas_path(sample.imu_csv_path)
        meta = await asyncio.to_thread(get_meta, csv_abs)
    except PathTraversalError as e:
        raise PrelabelError("IMU 文件路径非法") from e
    except ImuReadError as e:
        raise PrelabelError(str(e)) from e
    csv_start = parse_ts(meta.get("start_timestamp"))
    if csv_start is None:
        raise PrelabelError("IMU CSV 没有可用的时间戳列，无法换算 AI 片段时间")
    return csv_start


def ai_label_relpath(imu_csv_path: str) -> str:
    """AI 预标注 JSON 的 NAS 相对路径：放 data_labeled_ai/ 下，目录结构照搬
    data_raw/ 下面的层级（去掉 data_raw/ 前缀），文件名 = CSV 名 + _ai_label.json。
    不跟原始数据混在一个目录——原始数据只读，标注产物另起一棵树，误删/清理
    标注结果不会碰到原始文件。跟 docs/architecture-proposal.md 里
    ai_label_path 的约定一致。"""
    rel = imu_csv_path.replace("\\", "/")
    if rel.startswith(settings.data_raw_dir + "/"):
        rel = rel[len(settings.data_raw_dir) + 1:]
    return os.path.join(settings.ai_label_dir, os.path.splitext(rel)[0] + "_ai_label.json")


async def _store_and_normalize(sample: Sample, result: dict, csv_start: datetime) -> SampleInference:
    """原始 JSON 落盘 NAS（data_labeled_ai/ 下，见 ai_label_relpath），再摊平换算。"""
    relpath = ai_label_relpath(sample.imu_csv_path)
    full_path = os.path.join(settings.nas_root, relpath)

    def _write() -> None:
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    await asyncio.to_thread(_write)
    items, skipped = flatten_segments(result.get("segments") or {}, csv_start)
    cands = flatten_candidates(result.get("candidates") or [], csv_start)
    return SampleInference(items=items, skipped=skipped, n_windows=int(result.get("n_windows") or 0),
                           ai_label_path=relpath, candidates=cands)


async def infer_sample(sample: Sample, mode: str | None = None) -> SampleInference:
    """单个样本：工作台按钮用。不碰数据库；调用方自己决定怎么存。"""
    csv_start = await _csv_start_of(sample)
    try:
        result = await algo_client.infer(sample.imu_csv_path, sample_id=sample.id, mode=mode)
    except algo_client.AlgoServiceError as e:
        raise PrelabelError(str(e)) from e
    return await _store_and_normalize(sample, result, csv_start)


# ---------------------------------------------------------------- 项目批量 ----


@dataclass
class PrelabelProgress:
    status: str = "idle"  # idle | running | done | error
    project_id: int = 0
    total: int = 0
    processed: int = 0
    succeeded: int = 0
    skipped: int = 0
    failed: int = 0
    current_task_id: int | None = None
    current_sample_code: str | None = None
    # 最近的处理记录（每个任务一行），前端展示最后几十条就够
    detail: list[str] = field(default_factory=list)
    # AI 类别名在项目标签里找不到对应的，整个批次汇总一次，提示去标签管理里补
    unmatched_labels: list[str] = field(default_factory=list)
    error_message: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    elapsed_sec: float = 0.0
    estimated_remaining_sec: float | None = None
    # 光等 AI 服务回结果花了多久（不含资格检查/落盘/写库），慢了好判断是哪边的问题
    ai_wait_sec: float = 0.0
    batches_done: int = 0

    def tick(self) -> None:
        if self.started_at is None:
            return
        self.elapsed_sec = time.time() - self.started_at
        if self.processed > 0 and self.elapsed_sec > 0:
            rate = self.processed / self.elapsed_sec
            remaining = max(self.total - self.processed, 0)
            self.estimated_remaining_sec = remaining / rate if rate > 0 else None

    def log(self, line: str) -> None:
        self.detail.append(line)
        if len(self.detail) > 60:
            del self.detail[: len(self.detail) - 60]

    def to_dict(self) -> dict:
        # 前端轮询时刷新一下已用时长——tick() 只在一个任务处理完才调，批量走
        # /infer_batch 一次几十个、一分钟才回一批，中间读到的 elapsed_sec 会卡住不动
        if self.status == "running" and self.started_at is not None:
            self.elapsed_sec = time.time() - self.started_at
        return asdict(self)


_progress: dict[int, PrelabelProgress] = {}
_running: set[int] = set()
# 正在跑的时候又来了新任务（比如批量导入又导了一批"AI预标注+人工修改"），先记下来，
# 这一轮跑完接着跑，不丢
_queued: dict[int, dict] = {}


def get_progress(project_id: int) -> PrelabelProgress:
    return _progress.get(project_id) or PrelabelProgress(project_id=project_id)


def is_running(project_id: int) -> bool:
    return project_id in _running


async def start_project_prelabel(
    project_id: int, task_ids: list[int] | None = None, overwrite_ai: bool = False, mode: str | None = None
) -> bool:
    """
    后台开始给项目里的任务做 AI 预标注。task_ids 为空 = 项目下所有符合条件的任务。
    已经在跑则把这批请求排到后面（返回 False 表示"已在跑，已排队"）。
    """
    if project_id in _running:
        q = _queued.setdefault(project_id, {"task_ids": set(), "all": False, "overwrite_ai": False, "mode": None})
        if task_ids is None:
            q["all"] = True
        else:
            q["task_ids"].update(task_ids)
        q["overwrite_ai"] = q["overwrite_ai"] or overwrite_ai
        q["mode"] = mode or q["mode"]
        return False
    _running.add(project_id)
    asyncio.create_task(_run(project_id, task_ids, overwrite_ai, mode))
    return True


async def _run(project_id: int, task_ids: list[int] | None, overwrite_ai: bool, mode: str | None = None) -> None:
    progress = PrelabelProgress(status="running", project_id=project_id, started_at=time.time())
    _progress[project_id] = progress
    try:
        while True:
            async with SessionLocal() as db:
                await _run_project(db, project_id, task_ids, overwrite_ai, progress, mode)
            nxt = _queued.pop(project_id, None)
            if not nxt:
                break
            task_ids = None if nxt["all"] else sorted(nxt["task_ids"])
            overwrite_ai = nxt["overwrite_ai"]
            mode = nxt.get("mode")
        progress.status = "done"
    except Exception as exc:  # noqa: BLE001 后台任务异常不能让进程崩
        progress.status = "error"
        progress.error_message = f"{type(exc).__name__}: {exc}"
    finally:
        progress.tick()
        progress.finished_at = time.time()
        progress.current_task_id = None
        progress.current_sample_code = None
        _running.discard(project_id)
        await _record_run(progress)


async def _record_run(progress: PrelabelProgress) -> None:
    """
    跑完把这一次的总耗时/数量记进 audit_logs（重启也不丢），项目页能查历史，
    以后觉得慢了可以拿着具体数字去看是 AI 服务慢还是这边写库慢。
    """
    summary = {
        "status": progress.status,
        "total": progress.total,
        "succeeded": progress.succeeded,
        "skipped": progress.skipped,
        "failed": progress.failed,
        "elapsed_sec": round(progress.elapsed_sec, 1),
        "ai_wait_sec": round(progress.ai_wait_sec, 1),
        "batches": progress.batches_done,
        "batch_size": settings.algo_infer_batch_size,
        "avg_sec_per_task": round(progress.elapsed_sec / progress.succeeded, 2) if progress.succeeded else None,
        "unmatched_labels": progress.unmatched_labels,
        "error_message": progress.error_message,
    }
    _logger.info("project %s ai_prelabel finished: %s", progress.project_id, json.dumps(summary, ensure_ascii=False))
    try:
        async with SessionLocal() as db:
            db.add(
                AuditLog(
                    user_id=None,
                    action="project.ai_prelabel",
                    target_type="project",
                    target_id=progress.project_id,
                    detail=json.dumps(summary, ensure_ascii=False),
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001 记录失败不影响主流程
        _logger.exception("failed to record ai_prelabel run for project %s", progress.project_id)


async def list_run_history(db: AsyncSession, project_id: int, limit: int = 10) -> list[dict]:
    rows = (
        await db.execute(
            select(AuditLog)
            .where(AuditLog.action == "project.ai_prelabel", AuditLog.target_id == project_id)
            .order_by(AuditLog.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    out: list[dict] = []
    for r in rows:
        try:
            detail = json.loads(r.detail or "{}")
        except ValueError:
            detail = {}
        out.append({"id": r.id, "finished_at": r.created_at.isoformat() if r.created_at else None, **detail})
    return out


@dataclass
class _Prepared:
    """通过了资格检查、等着发给 AI 的一个任务。"""

    task: Task
    sample: Sample
    record: AnnotationRecord | None
    old_ai_items: list[AnnotationLabelItem]
    csv_start: datetime


async def _run_project(
    db: AsyncSession,
    project_id: int,
    task_ids: list[int] | None,
    overwrite_ai: bool,
    progress: PrelabelProgress,
    mode: str | None = None,
) -> None:
    # 只处理还在标注员手里之前的任务：待认领 / 标注中。已提交、已通过、被驳回的
    # 都是有人工介入过的成品或半成品，批量覆盖会把人家的活儿冲掉。
    query = select(Task).where(
        Task.project_id == project_id, Task.status.in_([TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS])
    )
    if task_ids is not None:
        query = query.where(Task.id.in_(task_ids))
    tasks = (await db.execute(query.order_by(Task.id))).scalars().all()

    labels = (
        (
            await db.execute(
                select(LabelDefinition).where(
                    LabelDefinition.project_id == project_id, LabelDefinition.is_active.is_(True)
                )
            )
        )
        .scalars()
        .all()
    )
    # AI 的类别名按显示名匹配，退一步按 code
    by_name: dict[str, int] = {}
    for l in labels:
        by_name.setdefault(l.display_name, l.id)
    for l in labels:
        by_name.setdefault(l.code, l.id)

    progress.total += len(tasks)
    unmatched: set[str] = set(progress.unmatched_labels)

    size = max(1, settings.algo_infer_batch_size)
    chunks = [tasks[i : i + size] for i in range(0, len(tasks), size)]
    for ci, chunk in enumerate(chunks):
        progress.current_task_id = None
        progress.current_sample_code = f"第 {ci + 1}/{len(chunks)} 批（{len(chunk)} 个并行）"

        # 1) 资格检查 + 读 CSV 起点时间（本地磁盘 IO，几个一起读）
        prepared: list[_Prepared] = []
        for task in chunk:
            sample = await db.get(Sample, task.sample_id)
            code = sample.sample_code if sample else f"sample#{task.sample_id}"
            try:
                p = await _prepare(db, task, sample, overwrite_ai)
            except PrelabelError as e:
                progress.failed += 1
                progress.processed += 1
                progress.log(f"任务 #{task.id} {code}：失败 {e}")
                continue
            if isinstance(p, str):
                progress.skipped += 1
                progress.processed += 1
                progress.log(f"任务 #{task.id} {code}：跳过（{p}）")
                continue
            prepared.append(p)
        progress.tick()
        if not prepared:
            continue

        # 2) 一整批发给 AI 服务并行跑
        try:
            t0 = time.time()
            results = await algo_client.infer_batch(
                [{"path": p.sample.imu_csv_path, "sample_id": p.sample.id} for p in prepared], mode=mode
            )
            progress.ai_wait_sec += time.time() - t0
            progress.batches_done += 1
        except algo_client.AlgoServiceError as e:
            progress.ai_wait_sec += time.time() - t0
            for p in prepared:
                progress.failed += 1
                progress.processed += 1
                progress.log(f"任务 #{p.task.id} {p.sample.sample_code}：失败 {e}")
            progress.tick()
            continue
        by_sample: dict[int, dict] = {}
        for r in results:
            if isinstance(r, dict) and r.get("sample_id") is not None:
                by_sample[int(r["sample_id"])] = r

        # 3) 逐个写库
        for p in prepared:
            code = p.sample.sample_code
            r = by_sample.get(p.sample.id)
            try:
                if r is None:
                    raise PrelabelError("AI 服务没有返回这个样本的结果")
                if not r.get("ok"):
                    raise PrelabelError(str(r.get("error") or "AI 服务处理失败"))
                inf = await _store_and_normalize(p.sample, r.get("result") or {}, p.csv_start)
                outcome = await _apply(db, p, inf, by_name, unmatched)
                if outcome is None:
                    progress.succeeded += 1
                else:
                    progress.skipped += 1
                    progress.log(f"任务 #{p.task.id} {code}：跳过（{outcome}）")
            except PrelabelError as e:
                await db.rollback()
                progress.failed += 1
                progress.log(f"任务 #{p.task.id} {code}：失败 {e}")
            except Exception as e:  # noqa: BLE001 单个任务出错不影响后面的
                await db.rollback()
                progress.failed += 1
                progress.log(f"任务 #{p.task.id} {code}：失败 {type(e).__name__}: {e}")
            progress.processed += 1
            progress.unmatched_labels = sorted(unmatched)
            progress.tick()


async def _prepare(db: AsyncSession, task: Task, sample: Sample | None, overwrite_ai: bool) -> _Prepared | str:
    """资格检查。返回 _Prepared = 可以跑；返回字符串 = 跳过原因。"""
    if sample is None:
        raise PrelabelError("样本不存在")

    record = (
        await db.execute(
            select(AnnotationRecord).where(AnnotationRecord.task_id == task.id, AnnotationRecord.round_no == task.round_no)
        )
    ).scalar_one_or_none()
    existing: list[AnnotationLabelItem] = []
    if record is not None:
        existing = list(
            (await db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.annotation_record_id == record.id)))
            .scalars()
            .all()
        )
    if any(i.source_type == LabelItemSource.human_added or i.is_modified or i.ai_confirmed for i in existing):
        return "已有人工标注/确认过的片段，不覆盖"
    if existing and not overwrite_ai:
        return "已有 AI 片段"

    csv_start = await _csv_start_of(sample)
    return _Prepared(task=task, sample=sample, record=record, old_ai_items=existing, csv_start=csv_start)


async def _apply(
    db: AsyncSession, p: _Prepared, inf: SampleInference, by_name: dict[str, int], unmatched: set[str]
) -> str | None:
    """把一个样本的推理结果写进任务草稿。返回 None = 成功；字符串 = 跳过原因。"""
    record = p.record
    if record is None:
        record = AnnotationRecord(task_id=p.task.id, round_no=p.task.round_no, source_type=RecordSourceType.ai_revised)
        db.add(record)
        await db.flush()
    else:
        # 只有纯 AI 的旧片段才会走到这里（_prepare 已经把有人工痕迹的都拦住了），整批换新
        for i in p.old_ai_items:
            await db.delete(i)
        await db.flush()

    written = 0
    for it in inf.items:
        label_id = by_name.get(it.label_name)
        if label_id is None:
            unmatched.add(it.label_name)
            continue
        db.add(
            AnnotationLabelItem(
                annotation_record_id=record.id,
                label_id=label_id,
                start_time_ms=it.start_time_ms,
                end_time_ms=it.end_time_ms,
                source_type=LabelItemSource.ai_generated,
                is_modified=False,
                ai_confidence=it.confidence,
                ai_confirmed=False,
                created_by=None,
            )
        )
        written += 1

    await replace_candidates(db, p.task, inf.candidates)
    p.sample.ai_label_path = inf.ai_label_path
    # 建任务时选的是"从零标注"，批量跑完 AI 之后实际上就是 AI 预标注+人工修改了，
    # 类型跟着改过来，导出时才会落到 ai_revised 那个目录
    if p.task.task_type != TaskType.ai_assisted:
        p.task.task_type = TaskType.ai_assisted
    await db.commit()
    if written == 0 and inf.items:
        return "AI 类别名跟项目标签全对不上，一段都没写入"
    return None
