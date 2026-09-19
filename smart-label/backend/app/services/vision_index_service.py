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

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services import site_layout
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
# 暂停：gate 没 set 的时候，每一路开始前都会停在 gate 上等；正在建的那几路建完
_paused: set[int] = set()
_gate: dict[int, asyncio.Event] = {}
# 正在跑的每一路（asyncio.Task），停止时直接 cancel，不等它建完
_tasks: dict[int, list[asyncio.Task]] = {}


def get_progress(project_id: int) -> IndexProgress:
    return _progress.get(project_id) or IndexProgress(project_id=project_id)


def cancel(project_id: int) -> bool:
    """停止：立刻。正在建的几路也掐掉（视觉服务那边这一路可能还会跑完，但这里不再等）。"""
    if project_id not in _running:
        return False
    _cancelled.add(project_id)
    _paused.discard(project_id)
    if (g := _gate.get(project_id)) is not None:
        g.set()             # 停在暂停上的也放出来，让它们看到取消
    for t in _tasks.get(project_id, []):
        if not t.done():
            t.cancel()
    return True


def pause(project_id: int) -> bool:
    if project_id not in _running or project_id in _cancelled:
        return False
    _paused.add(project_id)
    if (g := _gate.get(project_id)) is not None:
        g.clear()
    p = _progress.get(project_id)
    if p is not None:
        p.status = "paused"
    return True


def resume(project_id: int) -> bool:
    if project_id not in _running:
        return False
    _paused.discard(project_id)
    if (g := _gate.get(project_id)) is not None:
        g.set()
    p = _progress.get(project_id)
    if p is not None and p.status == "paused":
        p.status = "running"
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
    gate = asyncio.Event()      # 每次跑新建：Event 绑当前事件循环
    gate.set()
    _gate[project_id] = gate
    _paused.discard(project_id)
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
        _paused.discard(project_id)
        _gate.pop(project_id, None)
        _tasks.pop(project_id, None)


def day_dir_of(sample: Sample) -> str | None:
    p = sample.video_cam1_path or ""
    return p.split("/")[-2] if "/" in p else None


def usable_cams(sample: Sample) -> list[str]:
    """这份样本哪几路能拿来当 IMU 的候选：按现场布局表（site_layout，抄自采集端配置）
    看每一路视频是这只狗自己单间的摄像头还是公共区。

    狗场：自己单间那一路用，公共区（cam7）不用——几只狗同在，画面里找到的对不上是谁的 IMU。
    影棚：三路全是公共的，只能全用，命中的候选要人看清是哪只狗。
    认不出来的（老数据、别的场地）按能用处理，别把老数据挡掉。
    """
    out = []
    for c in ("cam1", "cam2", "cam3"):
        path = video_path_of(sample, c)
        if not path:
            continue
        kind = site_layout.classify(path, sample.sample_code, day_dir_of(sample))
        if kind == "public" and site_layout.site_of(sample.sample_code, day_dir_of(sample), path) == "gouchang":
            continue        # 狗场公共区：不用
        out.append(c)
    return out


def is_multi_dog(sample: Sample, cam: str) -> bool:
    """这一路画面里可能有别的狗（影棚 / 公共区）。"""
    path = video_path_of(sample, cam)
    return site_layout.classify(path, sample.sample_code, day_dir_of(sample)) == "public"


async def project_videos(db: AsyncSession, project_id: int | None, cam: str,
                         task_ids: list[int] | None = None) -> list[tuple[Task, Sample, str]]:
    """项目里待认领/标注中的任务 → (task, sample, 那一路的视频路径)。没那一路的不在里面。"""
    # project_id=None：所有项目（找相似跨项目搜）
    q = select(Task).where(Task.status.in_([TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS]))
    if project_id is not None:
        q = q.where(Task.project_id == project_id)
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
    # 几路一起建：视觉服务那边 GPU 有锁，但解码是各自的 CPU，两三路并行能把 GPU 喂饱。
    # 再多没意义（GPU 排队），还占显存
    sem = asyncio.Semaphore(max(1, settings.vision_index_concurrency))

    gate = _gate.get(project_id)

    async def one(code: str, path: str) -> None:
        async with sem:
            if gate is not None:
                await gate.wait()       # 暂停时停在这里；继续 / 停止都会放行
            if project_id in _cancelled:
                return
            progress.current = code
            try:
                r = await build_fn(path, force=force)
            except asyncio.CancelledError:
                progress.log(f"{code}：停止，这一路没建完")
                return
            except Exception as e:  # noqa: BLE001
                progress.failed += 1
                progress.processed += 1
                progress.log(f"{code}：失败 {type(e).__name__}: {e}")
                return
            progress.processed += 1
            if r.get("cached"):
                progress.cached += 1
                progress.log(f"{code}：已有索引（{r.get('n', 0)} 帧）")
            else:
                progress.built += 1
                progress.log(f"{code}：建好 {r.get('n', 0)} 帧，{r.get('seconds', 0)} 秒")

    # 每一路一个 Task，停止时能挨个 cancel；被 cancel 的那一路在 one() 里自己收尾，不往外抛
    tasks = [asyncio.ensure_future(one(code, path)) for code, path in paths]
    _tasks[project_id] = tasks
    await asyncio.gather(*tasks, return_exceptions=True)
    if project_id in _cancelled and progress.processed < progress.total:
        progress.log(f"已停止，剩下 {progress.total - progress.processed} 路没建")


# ── 找相似 → 候选 ─────────────────────────────────────────────────────

@dataclass
class SimilarParams:
    label_name: str
    cam: str = "cam1"
    t_s: float | None = None        # 以图搜图：当前任务视频的第几秒
    text: str | None = None         # 或一句英文描述
    scope: str = "project"          # project = 整个项目；task = 只在当前任务里；all = 所有项目
    top_k: int = 60
    min_score: float = 0.0
    # 相邻命中隔多久以内合成一段。舔一次往往持续几十秒、命中却断断续续，3 秒会拆成十几条
    # 看着像重复；默认 15 秒，一次舔合成一条
    gap_s: float = 15.0
    # 减掉所有帧的平均向量再比：同狗同房同地板的共同背景把余弦顶到 0.95+，动作差别被淹没
    center: bool = True
    # 姿态相似占多少（0 只看画面，1 只看姿态）；None 用视觉服务的默认
    pose_w: float | None = None
    # 只搜不写：先把命中的画面摆出来看，看着对再写候选
    dry_run: bool = False


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
        # 整个项目 / 所有项目：每份样本只搜能对上 IMU 的那几路（一间一狗的场地只搜自己房间那一路）
        rows = await project_videos(db, None if params.scope == "all" else task.project_id, "all")
    by_path: dict[str, list[Task]] = {}
    _multi_of: dict[int, bool] = {}
    _code_of: dict[int, str | None] = {}
    _proj_of: dict[int, int] = {}
    for t, s_, path in rows:
        by_path.setdefault(path, []).append(t)
        _code_of[t.id] = s_.sample_code if s_ else None
        _proj_of[t.id] = t.project_id
        if s_ is not None:
            kind = site_layout.classify(path, s_.sample_code, day_dir_of(s_))
            _multi_of[t.id] = _multi_of.get(t.id, False) or kind == "public"
    paths = list(by_path)
    if not paths:
        raise ValueError("这个范围里没有可搜的视频")

    ref = {"path": own_path, "t": params.t_s} if params.t_s is not None else None
    r = await search_fn(paths, text=params.text, ref=ref, top_k=params.top_k,
                        min_score=params.min_score, gap_s=params.gap_s, center=params.center,
                        pose_w=params.pose_w)
    # 每个命中对应哪个任务（同一路视频可能有几个任务：整段的 + 短任务），给"先看命中"画图和跳转
    hits_out: list[dict] = []
    for h in r.get("hits", []):
        if not h.get("path"):
            continue
        tasks_here = by_path.get(h["path"]) or []
        t_ms = int(h["t"] * 1000)
        # 短任务（有区间）落在里面的优先，其次整段的任务
        owner = next((t for t in tasks_here if t.segment_start_ms is not None and t.segment_end_ms is not None
                      and t.segment_start_ms <= t_ms < t.segment_end_ms), None) \
            or next((t for t in tasks_here if t.segment_start_ms is None or t.segment_end_ms is None), None) \
            or (tasks_here[0] if tasks_here else None)
        hits_out.append({"path": h["path"], "t": h["t"], "score": h["score"], "pose_score": h.get("pose_score"),
                         "vis_score": h.get("vis_score"),
                         "task_id": owner.id if owner else None,
                         "project_id": _proj_of.get(owner.id) if owner else None,
                         "sample_code": _code_of.get(owner.id) if owner else None,
                         "multi_dog": bool(_multi_of.get(owner.id)) if owner else False})
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
            n = 0 if params.dry_run else await add_similar_candidates(db, t, params.label_name, segs_t)
            written += n
            per_task.append({"task_id": t.id, "project_id": t.project_id, "candidates": n, "segments": len(segs_t),
                             "sample_code": _code_of.get(t.id), "multi_dog": bool(_multi_of.get(t.id)),
                             # 前几段的时间和分数：人要知道"落到哪了"，不然找完了不知道去哪看
                             "items": [{"start_s": x["start_s"], "end_s": x["end_s"], "score": x.get("score")}
                                       for x in sorted(segs_t, key=lambda x: -(x.get("score") or 0))[:10]]})
    if not params.dry_run:
        await db.commit()
    # 多狗同场（影棚 / 公共区）的命中要提醒：画面里那只不一定是这条 IMU 的狗
    multi = sum(pt["candidates"] for pt in per_task if _multi_of.get(pt["task_id"]))
    return {"written": written, "hits": len(r.get("hits", [])), "segments": len(r.get("segments", [])),
            "searched": r.get("searched", 0), "missing": len(r.get("missing", [])),
            "query": r.get("query"), "per_task": per_task, "multi_dog_candidates": multi,
            "centered": bool(r.get("centered")), "pose_used": bool(r.get("pose_used")), "pose_w": r.get("pose_w"),
            "dry_run": params.dry_run, "hit_list": hits_out,
            # 样例自己那一路的路径：前端拿它请求样例帧的缩略图，跟命中并排比
            "ref_path": own_path}
