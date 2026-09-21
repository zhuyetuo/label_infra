"""
画面向量索引：建索引（项目级后台任务）+ 以图搜图 / 一句话搜 → 候选。

跟「大模型看视频找动作」（问大模型）互补：索引建一次，之后在工作台里看到一帧"舔尾巴"，
点一下就把整个项目里长得像的几秒全挑出来，免费、瞬间。结果走同一条候选通道
（ai_candidates，reason=similar），确认方式跟别的候选一样。

时间对齐：视频 0 秒 = IMU CSV 第一行，跟 vision_seek 同一假设。
"""

from __future__ import annotations

import asyncio
import logging
import re
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
# 「一句话找画面」跟「用这一张去扩」写出来的候选，reason 都是 similar——分不开的话，
# 想把某一次试错的结果整批删掉就只能连坐，或者干脆删项目重建。model 上带一截来源，
# 旧数据仍是光秃秃的 "siglip"（前端按前缀认，认不出就当「画面相似」）
MODEL_TEXT = f"{MODEL_TAG}:text"      # 一句话找画面
MODEL_IMAGE = f"{MODEL_TAG}:img"      # 以图搜图（用这一张去扩）
# 两端都在这个误差内就算「同一段」。同一次命中换个部位重写一遍，合出来的段两端
# 完全一致；真挨着的两个动作之间隔着的是秒级，不会被这 0.25 秒并掉
SAME_SPAN_MS = 250


# ── 建索引（后台） ────────────────────────────────────────────────────

@dataclass
class IndexProgress:
    status: str = "idle"
    project_id: int = 0
    cam: str = "cam1"
    # 这一轮建的是哪一档：fine = 每秒一帧 / fast = 只解关键帧（快，约 12 秒一帧）
    mode: str = "fine"
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


async def start(project_id: int, task_ids: list[int] | None, cam: str, force: bool,
                mode: str | None = None) -> bool:
    if project_id in _running:
        return False
    _running.add(project_id)
    asyncio.create_task(_run(project_id, task_ids, cam, force, mode))
    return True


async def _run(project_id: int, task_ids: list[int] | None, cam: str, force: bool,
               mode: str | None = None) -> None:
    progress = IndexProgress(status="running", project_id=project_id, cam=cam, mode=mode or "fine",
                             started_at=time.time())
    _progress[project_id] = progress
    gate = asyncio.Event()      # 每次跑新建：Event 绑当前事件循环
    gate.set()
    _gate[project_id] = gate
    _paused.discard(project_id)
    try:
        async with SessionLocal() as db:
            await run_project(db, project_id, task_ids, cam, force, progress, mode=mode)
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


# 日期目录尾巴上的场地字样（2026_9_16_gouchang2 → gouchang2）
_SITE_TAIL = re.compile(r"_([a-z]+\d*)$", re.IGNORECASE)
_SITE_CN = {"gouchang": "狗场", "yingpeng": "影棚"}


def scope_of(path: str, day_dir: str | None) -> tuple[str, str]:
    """这一路视频属于「哪个场地的哪个机位」。返回 (筛选用的 key, 给人看的名字)。

    为什么要有这个：一次搜整个项目会把 200 多路一起搜，命中常常挤在某一个机位上
    （那个角度的画面互相最像）。人真正想问的是「狗场2 的 cam1 里有没有」——
    没有这一层，他只能一张张往下翻，翻到的还都是同一个摄像头。

    认不出来的照实归到「其他」，不猜：猜错了人按机位筛就会漏掉素材。
    """
    cam, _imu = site_layout.parse_cam_imu(path)
    m = _SITE_TAIL.search(day_dir or "")
    site = (m.group(1).lower() if m else "")
    # 一个布局键底下还分几处场地（狗场1 / 狗场2），按机位号分——日期目录里只写了
    # gouchang。分不出来就退回目录里那个字样，不硬凑
    base = next((k for k in _SITE_CN if site.startswith(k)), "")
    part = site_layout.site_part(base, cam) if base else None
    cn = part or (_SITE_CN.get(base, "") + site[len(base):] if base else "") or site or "其他"
    key = part or site
    if cam is None:
        return f"{key}/", f"{cn}·未知机位"
    return f"{key}/cam{cam}", f"{cn}·cam{cam}"


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


_SPENT_NAME = {"scan": "解码+检测", "pose": "姿态", "seg": "抠狗", "embed": "向量"}


def _spent_note(r: dict) -> str:
    """建索引慢的时候，这一行直接说是慢在哪一步，不用去翻视觉服务的日志。
    老版本视觉服务不报 spent，那就什么都不加。"""
    spent = r.get("spent") or {}
    parts = [f"{_SPENT_NAME.get(k, k)} {v}s" for k, v in
             sorted(spent.items(), key=lambda kv: -float(kv[1] or 0)) if float(v or 0) >= 0.5]
    return f"（{'，'.join(parts)}）" if parts else ""


async def run_project(db: AsyncSession, project_id: int, task_ids: list[int] | None, cam: str,
                      force: bool, progress: IndexProgress, build_fn=None,
                      mode: str | None = None) -> None:
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
                r = await build_fn(path, force=force, mode=mode)
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
                progress.log(f"{code}：建好 {r.get('n', 0)} 帧，{r.get('seconds', 0)} 秒{_spent_note(r)}")

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
    # 去共同背景：每一帧减掉**它自己那一路**的平均向量（视觉服务 2026-09-20 起的做法）。
    # 同狗同房同地板的共同背景把余弦顶到 0.95+，动作差别被淹没；减掉之后身份在两边
    # 同时抵消，剩下的才是动作——这是"搜出来全是同一只狗"的解药
    center: bool = True
    # 姿态相似占多少（0 只看画面，1 只看姿态）；None 用视觉服务的默认
    pose_w: float | None = None
    # 只要"鼻子够到了这个部位"的帧（几何硬条件，不是相似度）。SigLIP 看整体长相，
    # 分不清左前爪和右前爪；这一条直接按关键点距离卡，而且天然跨狗（按体长归一化过）。
    # 认不出的部位名（腰、腹股沟…）不筛，结果里 part_used 会如实说
    part: str | None = None
    # 只搜这几个「场地·机位」（scope_of 给的 key，如 gouchang2/cam1）。空 = 全搜。
    # 一次搜整个项目会把 200 多路一起搜，命中常常挤在某一个机位上——那个角度的画面
    # 互相最像。人真正想问的是「狗场2 的 cam1 里有没有」，没有这一层只能一张张翻
    scopes: tuple[str, ...] = ()
    # 只搜不写：先把命中的画面摆出来看，看着对再写候选
    dry_run: bool = False
    # 「先看命中」里人手动去掉的那几帧（[(路径, 秒), …]）。一眼看出不是同一个动作的
    # 挑出来扔掉，剩下的再写候选——检索总会混进几张明显不对的，为那几张去调参数
    # 常常把对的也一起调没了，人点两下比调参数准
    drop: tuple[tuple[str, float], ...] = ()
    # 「先看命中」里人勾中的帧，连同**这一帧标成哪个类别**：((路径, 秒, 类别名), …)。
    # 一次检索里常常混着别的动作——全按一个类别写进去，等于把活儿推到后面让人
    # 一条条改；在这里当场分开标，改的机会就在眼前，不用回头找
    pick: tuple[tuple[str, float, str], ...] = ()


def overlaps(a0: int, a1: int, b0: int, b1: int) -> bool:
    return a0 < b1 and b0 < a1


# 命中合段：跟视觉服务 embed.group_hits 同一套规则（相邻 gap_s 内合一段，前后各留 1 秒）。
# 人手动去掉几帧之后段要重算——被去掉那一帧如果正好是一段的边界，段的起止就得跟着缩；
# 整段的帧都被去掉了，这一段就不该再写进候选。
# 这段逻辑在算法那边也有一份：两个仓库是解耦的，宁可各留一份，也不为了省十几行
# 让标注平台去 import 算法服务的内部函数
SEG_PAD_S = 1.0


def group_hits(hits: list[dict], gap_s: float, pad_s: float = SEG_PAD_S) -> list[dict]:
    # 按（视频, 类别）分组，不只按视频：挨着的两帧标成了不同类别就该是两段，
    # 合成一段就得替人选一个类别，而那正是人刚刚分开标的东西
    by_path: dict[tuple[str, str | None], list[dict]] = {}
    for h in hits:
        by_path.setdefault((h["path"], h.get("label")), []).append(h)
    out: list[dict] = []
    for (rp, lab), hs in by_path.items():
        hs = sorted(hs, key=lambda h: h["t"])
        cur: dict | None = None
        for h in hs:
            if cur and h["t"] - cur["_last"] <= gap_s:
                cur["_last"] = h["t"]
                cur["score"] = max(cur["score"], h["score"])
                cur["n"] += 1
                continue
            if cur:
                out.append(cur)
            cur = {"path": rp, "label": lab, "_first": h["t"], "_last": h["t"], "score": h["score"], "n": 1}
        if cur:
            out.append(cur)
    segs = [{"path": s["path"], "label": s["label"], "start_s": round(max(0.0, s["_first"] - pad_s), 2),
             "end_s": round(s["_last"] + pad_s, 2), "score": s["score"], "n": s["n"]} for s in out]
    segs.sort(key=lambda s: -s["score"])
    return segs


async def add_similar_candidates(db: AsyncSession, task: Task, label_name: str,
                                 segs: list[dict], blocked: list[dict] | None = None,
                                 model_tag: str = MODEL_TAG) -> int:
    """把命中的段写成候选。跟已有的（任何来源、任何状态）同标签且时间重叠的不重复写：
    人已经判过的不该再冒出来，别的来源已经指出来的也没必要再加一条。

    label_name 是缺省类别；段自己带了 label 就用它自己的——一次检索里常常混着
    别的动作，人在「先看命中」里当场分开标的，不能到这里又被统一成一个。

    blocked 给了的话，**每一段被挡下来时把挡它的那条候选记进去**（任务、时间、
    类别、状态）。只报一句「之前已经写过了」是不够的：人删掉的是「片段」，挡路的
    却是那条还留着的「候选」——他去任务里翻，看到的是「待确认 1」，那一条不在
    待确认里（多半已确认/已排除），于是只会觉得系统在撒谎。得把挡路的那条指出来。
    """
    existing = (await db.execute(
        select(AiCandidate).where(AiCandidate.task_id == task.id, AiCandidate.round_no == task.round_no)
    )).scalars().all()
    n = 0
    for s in sorted(segs, key=lambda x: x["start_s"]):
        s_ms, e_ms = int(round(s["start_s"] * 1000)), int(round(s["end_s"] * 1000))
        if e_ms <= s_ms:
            continue
        lab = s.get("label") or label_name
        hit_by = next((c for c in existing
                       if c.label_name == lab and overlaps(s_ms, e_ms, c.start_time_ms, c.end_time_ms)), None)
        # 同一段时间已经从画面相似写过了，只是标成别的部位——那是「改类别」，不是新的一段。
        # 只按类别去重的话，同一次命中换个部位再写一遍就会得到两行一模一样时间的候选，
        # 人看着以为系统重复了。两端都对得上（250ms 内）才算同一段，别把真挨着的两个动作并掉
        if hit_by is None:
            hit_by = next((c for c in existing
                           if c.reason == REASON
                           and abs(c.start_time_ms - s_ms) <= SAME_SPAN_MS
                           and abs(c.end_time_ms - e_ms) <= SAME_SPAN_MS), None)
        if hit_by is not None:
            if blocked is not None:
                blocked.append({
                    # 挡路那条标的是什么 vs 这次想标什么：不一样就说明人是在改部位，
                    # 提示里要两个都给，不然「挡路的是 舔-后肢」跟他刚标的 舔-后爪 对不上号
                    "task_id": task.id, "label_name": hit_by.label_name, "want_label": lab,
                    "start_time_ms": hit_by.start_time_ms, "end_time_ms": hit_by.end_time_ms,
                    "status": getattr(hit_by.status, "value", str(hit_by.status)) if hit_by.status else "pending",
                    "reason": hit_by.reason,
                    "want_start_ms": s_ms, "want_end_ms": e_ms,
                })
            continue
        c = AiCandidate(task_id=task.id, round_no=task.round_no, label_name=lab,
                        start_time_ms=s_ms, end_time_ms=e_ms, confidence=float(s.get("score") or 0.0),
                        spec=None, reason=REASON, model=model_tag)
        db.add(c)
        existing.append(c)
        n += 1
    return n


async def find_similar(db: AsyncSession, task: Task | None, params: SimilarParams, search_fn=None,
                       project_id: int | None = None) -> dict:
    """在项目（或本任务）已建索引的视频里找像的，写成候选。返回汇总。

    task 可以是 None：**一句话搜不需要样例帧，也就不需要一个"当前任务"**。
    项目页那个入口就是这么进来的——想找「一张狗咬尾巴的图」时，人手上还没有
    任何一条样例，本来也不该先随便挑个任务打开工作台。那时用 project_id 说明搜哪个项目。
    """
    search_fn = search_fn or vc.embed_search
    if (params.t_s is None) == (params.text is None):
        raise ValueError("给一帧的时间或一句描述，二选一")
    if task is None and params.t_s is not None:
        raise ValueError("以图搜图要有样例帧所在的任务")
    sample = await db.get(Sample, task.sample_id) if task is not None else None
    own_path = video_path_of(sample, params.cam) if sample else None
    if params.t_s is not None and not own_path:
        raise ValueError(f"这个任务的样本没有 {params.cam} 视频")

    if params.scope == "task":
        rows = [(task, sample, own_path)] if (task is not None and own_path) else []
    else:
        # 整个项目 / 所有项目：每份样本只搜能对上 IMU 的那几路（一间一狗的场地只搜自己房间那一路）
        pid = None if params.scope == "all" else (task.project_id if task is not None else project_id)
        rows = await project_videos(db, pid, "all")
    by_path: dict[str, list[Task]] = {}
    _multi_of: dict[int, bool] = {}
    _code_of: dict[int, str | None] = {}
    _proj_of: dict[int, int] = {}
    # 每路视频是哪份样本的哪个槽位：前端拿它去换视频流，在预览里直接循环播放命中的那几秒
    _media_of: dict[str, tuple[int, str]] = {}
    for t, s_, path in rows:
        by_path.setdefault(path, []).append(t)
        _code_of[t.id] = s_.sample_code if s_ else None
        _proj_of[t.id] = t.project_id
        if s_ is not None and path not in _media_of:
            slot = next((c for c in ("cam1", "cam2", "cam3") if video_path_of(s_, c) == path), None)
            if slot:
                _media_of[path] = (s_.id, slot)
        if s_ is not None:
            kind = site_layout.classify(path, s_.sample_code, day_dir_of(s_))
            _multi_of[t.id] = _multi_of.get(t.id, False) or kind == "public"
    # 有哪些「场地·机位」可挑，各有几路：**不管这次筛没筛，都按全量算**，
    # 不然筛过一次之后下拉里就只剩选中的那一个，人再也切不回去
    _day_of: dict[str, str | None] = {}
    for t, s_, path in rows:
        if path not in _day_of:
            _day_of[path] = day_dir_of(s_) if s_ is not None else None
    scope_list: dict[str, dict] = {}
    for path in by_path:
        key, label = scope_of(path, _day_of.get(path))
        e = scope_list.setdefault(key, {"key": key, "label": label, "videos": 0})
        e["videos"] += 1
    scopes_out = sorted(scope_list.values(), key=lambda x: x["key"])

    paths = list(by_path)
    if params.scopes:
        want = set(params.scopes)
        paths = [p_ for p_ in paths if scope_of(p_, _day_of.get(p_))[0] in want]
        if not paths:
            # 挑了个这个项目里根本没有的机位：说清楚，别让人对着 0 条结果猜
            raise ValueError(f"选中的机位在这个范围里没有视频（有的是：{'、'.join(x['label'] for x in scopes_out)}）")
    if not paths:
        raise ValueError("这个范围里没有可搜的视频")

    ref = {"path": own_path, "t": params.t_s} if params.t_s is not None else None
    r = await search_fn(paths, text=params.text, ref=ref, top_k=params.top_k,
                        min_score=params.min_score, gap_s=params.gap_s, center=params.center,
                        pose_w=params.pose_w, part=params.part)
    dropped = 0
    if params.pick:
        # 人勾了哪几帧、每一帧标成什么，都在 pick 里。**只写勾中的**，而且各按
        # 各的类别——一次检索里常常混着别的动作，统一标一个类别等于把活儿推到
        # 后面让人一条条改
        want = {(p_, int(round(t * 1000))): lab for p_, t, lab in params.pick}
        kept = []
        for h in r.get("hits", []):
            lab = want.get((h.get("path"), int(round(h["t"] * 1000))))
            if lab:
                kept.append({**h, "label": lab})
        dropped = len(r.get("hits", [])) - len(kept)
        r = {**r, "hits": kept, "segments": group_hits(kept, params.gap_s)}
    elif params.drop:
        # 时间按毫秒对齐再比：命中的 t 是两位小数，浮点直接相等靠不住
        gone = {(p, int(round(t * 1000))) for p, t in params.drop}
        kept = [h for h in r.get("hits", []) if (h.get("path"), int(round(h["t"] * 1000))) not in gone]
        dropped = len(r.get("hits", [])) - len(kept)
        r = {**r, "hits": kept, "segments": group_hits(kept, params.gap_s)}
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
        m = _media_of.get(h["path"])
        hits_out.append({"path": h["path"], "t": h["t"], "score": h["score"], "pose_score": h.get("pose_score"),
                         "vis_score": h.get("vis_score"),
                         "sample_id": m[0] if m else None, "cam": m[1] if m else None,
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
            n = 0 if params.dry_run else await add_similar_candidates(
                db, t, params.label_name, segs_t,
                model_tag=MODEL_TEXT if params.text is not None else MODEL_IMAGE)
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
            # 人手动去掉了几帧：写完要如实说，不然"命中 60 帧"跟实际写进去的对不上
            "dropped": dropped,
            "searched": r.get("searched", 0), "missing": len(r.get("missing", [])),
            # 一句话搜跳过了几路老索引（没有"没抠背景"那一列）。不报的话人只会看到
            # "搜到的少"，还以为是这一句不行
            "old_index": r.get("old_index", 0), "text_space": r.get("text_space"),
            # 搜过的里面有几路是快档（约 12 秒一帧）：搜不到不等于素材里没有
            "coarse": r.get("coarse", 0),
            "query": r.get("query"), "per_task": per_task, "multi_dog_candidates": multi,
            # 这个范围里有哪些「场地·机位」、各几路：前端的机位筛选就用它当选项。
            # 全量给（不受本次筛选影响），不然筛过一次就切不回去
            "scopes": scopes_out, "scope_used": list(params.scopes),
            "centered": bool(r.get("centered")), "pose_used": bool(r.get("pose_used")), "pose_w": r.get("pose_w"),
            # part_used=None 而 part 有值 = 这个部位判不了（腰、腹股沟…），**没筛**。
            # 前端要照实说，不然人会把没筛的一堆当成筛过的结果
            "part": r.get("part"), "part_used": r.get("part_used"),
            "dry_run": params.dry_run, "hit_list": hits_out,
            # 样例自己那一路的路径：前端拿它请求样例帧的缩略图，跟命中并排比
            "ref_path": own_path}
