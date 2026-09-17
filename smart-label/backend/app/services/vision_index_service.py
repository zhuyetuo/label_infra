"""
画面向量索引：建索引（项目级后台任务）+ 以图搜图 / 一句话搜 → 候选。

跟「画面找片段」（问大模型）互补：索引建一次，之后在工作台里看到一帧"舔尾巴"，
点一下就把整个项目里长得像的几秒全挑出来，免费、瞬间。结果走同一条候选通道
（ai_candidates，reason=similar），确认方式跟别的候选一样。

时间对齐：视频 0 秒 = IMU CSV 第一行，跟 vision_seek 同一假设。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict, dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionLocal
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services import dog_presence_service as presence
from app.services import vision_sam_client as vc
from app.services.vision_seek_service import video_path_of

_logger = logging.getLogger("smart-label.vision_index")

REASON = "similar"
MODEL_TAG = "siglip"


# ── 建索引（后台） ────────────────────────────────────────────────────

@dataclass
class IndexProgress:
    status: str = "idle"
    project_id: int = 0
    cam: str = "cam1"
    total: int = 0
    processed: int = 0
    built: int = 0
    cached: int = 0
    skipped: int = 0
    failed: int = 0
    current: str | None = None
    detail: list[str] = field(default_factory=list)
    error_message: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    elapsed_sec: float = 0.0

    def log(self, line: str) -> None:
        self.detail.append(line)
        if len(self.detail) > 60:
            del self.detail[: len(self.detail) - 60]

    def to_dict(self) -> dict:
        if self.status == "running" and self.started_at is not None:
            self.elapsed_sec = time.time() - self.started_at
        return asdict(self)


_progress: dict[int, IndexProgress] = {}
_running: set[int] = set()
_cancelled: set[int] = set()


def get_progress(project_id: int) -> IndexProgress:
    return _progress.get(project_id) or IndexProgress(project_id=project_id)


def cancel(project_id: int) -> bool:
    if project_id not in _running:
        return False
    _cancelled.add(project_id)
    return True


async def start(project_id: int, task_ids: list[int] | None, cam: str, force: bool) -> bool:
    if project_id in _running:
        return False
    _running.add(project_id)
    asyncio.create_task(_run(project_id, task_ids, cam, force))
    return True


async def _run(project_id: int, task_ids: list[int] | None, cam: str, force: bool) -> None:
    progress = IndexProgress(status="running", project_id=project_id, cam=cam, started_at=time.time())
    _progress[project_id] = progress
    try:
        async with SessionLocal() as db:
            await run_project(db, project_id, task_ids, cam, force, progress)
        progress.status = "cancelled" if project_id in _cancelled else "done"
    except Exception as exc:  # noqa: BLE001
        progress.status = "error"
        progress.error_message = f"{type(exc).__name__}: {exc}"
    finally:
        progress.finished_at = time.time()
        progress.elapsed_sec = progress.finished_at - (progress.started_at or progress.finished_at)
        progress.current = None
        _running.discard(project_id)
        _cancelled.discard(project_id)


def day_dir_of(sample: Sample) -> str | None:
    p = sample.video_cam1_path or ""
    return p.split("/")[-2] if "/" in p else None


def usable_cams(sample: Sample) -> list[str]:
    """这份样本哪几路能拿来当 IMU 的候选。

    狗场：六个单间各一只狗一个摄像头（样本的 cam1），外加一个公共区摄像头（cam2）。
    公共区里几只狗同时在，画面里找到"有狗在舔"也对不上是哪只的 IMU——所以一间一狗的
    场地只用 cam1。影棚：四只狗三个公共摄像头，没有"自己的那一路"，只能全用，
    命中的候选要人看清是哪只狗（工作台标题上有狗名）。
    """
    present = [c for c in ("cam1", "cam2", "cam3") if video_path_of(sample, c)]
    if presence.is_one_dog_site(sample.sample_code, day_dir_of(sample)):
        return [c for c in present if c == "cam1"]
    return present


async def project_videos(db: AsyncSession, project_id: int, cam: str,
                         task_ids: list[int] | None = None) -> list[tuple[Task, Sample, str]]:
    """项目里待认领/标注中的任务 → (task, sample, 那一路的视频路径)。没那一路的不在里面。"""
    q = select(Task).where(Task.project_id == project_id,
                           Task.status.in_([TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS]))
    if task_ids is not None:
        q = q.where(Task.id.in_(task_ids))
    tasks = (await db.execute(q.order_by(Task.id))).scalars().all()
    out = []
    for t in tasks:
        s = await db.get(Sample, t.sample_id)
        if s is None:
            continue
        cams = usable_cams(s) if cam == "all" else [cam]
        for c in cams:
            path = video_path_of(s, c)
            if path:
                out.append((t, s, path))
    return out


async def run_project(db: AsyncSession, project_id: int, task_ids: list[int] | None, cam: str,
                      force: bool, progress: IndexProgress, build_fn=None) -> None:
    """同一路视频只建一次（几个任务共用一个样本时）。cam="all" = 样本有几路建几路。"""
    build_fn = build_fn or vc.embed_build
    seen: set[str] = set()
    paths = []
    for _t, s, path in await project_videos(db, project_id, cam, task_ids):
        if path not in seen:
            seen.add(path)
            paths.append((s.sample_code, path))
    progress.total = len(paths)
    for code, path in paths:
        if project_id in _cancelled:
            progress.log(f"已取消，剩下 {progress.total - progress.processed} 路没建")
            break
        progress.current = code
        try:
            r = await build_fn(path, force=force)
        except Exception as e:  # noqa: BLE001
            progress.failed += 1
            progress.processed += 1
            progress.log(f"{code}：失败 {type(e).__name__}: {e}")
            continue
        progress.processed += 1
        if r.get("cached"):
            progress.cached += 1
            progress.log(f"{code}：已有索引（{r.get('n', 0)} 帧）")
        else:
            progress.built += 1
            progress.log(f"{code}：建好 {r.get('n', 0)} 帧，{r.get('seconds', 0)} 秒")


# ── 找相似 → 候选 ─────────────────────────────────────────────────────

@dataclass
class SimilarParams:
    label_name: str
    cam: str = "cam1"
    t_s: float | None = None        # 以图搜图：当前任务视频的第几秒
    text: str | None = None         # 或一句英文描述
    scope: str = "project"          # project = 整个项目；task = 只在当前任务里
    top_k: int = 60
    min_score: float = 0.0
    gap_s: float = 3.0


def overlaps(a0: int, a1: int, b0: int, b1: int) -> bool:
    return a0 < b1 and b0 < a1


async def add_similar_candidates(db: AsyncSession, task: Task, label_name: str,
                                 segs: list[dict]) -> int:
    """把命中的段写成候选。跟已有的（任何来源、任何状态）同标签且时间重叠的不重复写：
    人已经判过的不该再冒出来，别的来源已经指出来的也没必要再加一条。"""
    existing = (await db.execute(
        select(AiCandidate).where(AiCandidate.task_id == task.id, AiCandidate.round_no == task.round_no)
    )).scalars().all()
    n = 0
    for s in sorted(segs, key=lambda x: x["start_s"]):
        s_ms, e_ms = int(round(s["start_s"] * 1000)), int(round(s["end_s"] * 1000))
        if e_ms <= s_ms:
            continue
        if any(c.label_name == label_name and overlaps(s_ms, e_ms, c.start_time_ms, c.end_time_ms) for c in existing):
            continue
        c = AiCandidate(task_id=task.id, round_no=task.round_no, label_name=label_name,
                        start_time_ms=s_ms, end_time_ms=e_ms, confidence=float(s.get("score") or 0.0),
                        spec=None, reason=REASON, model=MODEL_TAG)
        db.add(c)
        existing.append(c)
        n += 1
    return n


async def find_similar(db: AsyncSession, task: Task, params: SimilarParams, search_fn=None) -> dict:
    """在项目（或本任务）已建索引的视频里找像的，写成候选。返回汇总。"""
    search_fn = search_fn or vc.embed_search
    if (params.t_s is None) == (params.text is None):
        raise ValueError("给一帧的时间或一句描述，二选一")
    sample = await db.get(Sample, task.sample_id)
    own_path = video_path_of(sample, params.cam) if sample else None
    if params.t_s is not None and not own_path:
        raise ValueError(f"这个任务的样本没有 {params.cam} 视频")

    if params.scope == "task":
        rows = [(task, sample, own_path)] if own_path else []
    else:
        # 整个项目：每份样本只搜能对上 IMU 的那几路（一间一狗的场地只搜自己房间那一路）
        rows = await project_videos(db, task.project_id, "all")
    by_path: dict[str, list[Task]] = {}
    _code_of: dict[int, str | None] = {}
    _day_of: dict[int, str | None] = {}
    for t, s_, path in rows:
        by_path.setdefault(path, []).append(t)
        _code_of[t.id] = s_.sample_code if s_ else None
        _day_of[t.id] = day_dir_of(s_) if s_ else None
    paths = list(by_path)
    if not paths:
        raise ValueError("这个范围里没有可搜的视频")

    ref = {"path": own_path, "t": params.t_s} if params.t_s is not None else None
    r = await search_fn(paths, text=params.text, ref=ref, top_k=params.top_k,
                        min_score=params.min_score, gap_s=params.gap_s)
    written = 0
    per_task: list[dict] = []
    for path, tasks in by_path.items():
        segs = [s for s in r.get("segments", []) if s["path"] == path]
        if not segs:
            continue
        for t in tasks:
            # 短任务只收落在自己区间里的
            if t.segment_start_ms is not None and t.segment_end_ms is not None:
                segs_t = [s for s in segs if overlaps(int(s["start_s"] * 1000), int(s["end_s"] * 1000),
                                                      t.segment_start_ms, t.segment_end_ms)]
            else:
                segs_t = segs
            n = await add_similar_candidates(db, t, params.label_name, segs_t)
            written += n
            per_task.append({"task_id": t.id, "candidates": n, "segments": len(segs_t)})
    await db.commit()
    # 多狗同场（影棚）的命中要提醒：画面里那只不一定是这条 IMU 的狗
    multi = sum(pt["candidates"] for pt in per_task
                if not presence.is_one_dog_site(_code_of.get(pt["task_id"]), _day_of.get(pt["task_id"])))
    return {"written": written, "hits": len(r.get("hits", [])), "segments": len(r.get("segments", [])),
            "searched": r.get("searched", 0), "missing": len(r.get("missing", [])),
            "query": r.get("query"), "per_task": per_task, "multi_dog_candidates": multi}
