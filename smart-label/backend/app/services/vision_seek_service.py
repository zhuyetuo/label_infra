"""
画面找片段：让视觉大模型在视频里把「舔 / 啃 / 抓挠 / 蹭」这类行为的几秒挑出来，
按视频时间写成候选，标注员在工作台「疑似片段」里确认，IMU 片段随之落下。

跟「疑似抓挠」候选走**同一条通道**（ai_candidates，reason=vision），所以确认/排除/
改类别、统计、导出一个都不用重做。区别只在候选从哪来：

    low_conf / spectral   IMU 模型                 抓挠
    grooming              IMU 加速度姿态规则       舔身体
    vision                画面 + 视觉大模型（API） 项目里选的任意类别（含部位）

为什么值得：每加一个新类别都得有人从 24 小时视频里翻片段。IMU 规则只能挑姿态
特殊的动作，而且每个类别要重新想规则；画面 + 一句话描述，新类别当天就能出候选。

时间对齐：视频 0 秒 = IMU CSV 第一行（采集端同一个 tick 起的），跟 scratch_crosscheck
叠画面时间线用的是同一个假设。所以候选毫秒 = 视频秒 × 1000，不需要再减 csv_start。

花费：大模型走 API，按送出去的段数计费。vision_service 那边本地先筛（有狗 + 在动），
再按 max_clips 封顶；dry_run 只筛不问，先看会送多少段。进度里累计送了多少段、
估了多少美元，让人随时能停。
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
from app.models.label import LabelDefinition
from app.models.sample import Sample
from app.models.task import Task, TaskStatus
from app.services import llm_call_service
from app.services import llm_provider_service as llmsvc
from app.services import vision_sam_client as vc
from app.services.ai_prelabel_service import CandidateItem
from app.services import label_tree
from app.services.grooming_labels import GROUPS, alias_names

_logger = logging.getLogger("smart-label.vision_seek")

REASON = "vision"

# 给模型看的一句话：这个动作长什么样。按 grooming_labels 里的分组（code）走，项目里有
# 哪些父标签就送哪些；部位子标签有的也一并送去让它选。
DESCRIPTIONS: dict[str, str] = {
    "lick_body": "狗用舌头反复舔自己身体的某处，头低下贴着那个部位，持续几秒以上",
    "chew_body": "狗用牙齿啃咬自己身体的某处（常见啃爪子、啃尾根），头贴着那个部位小幅度地啃",
    "scratch": "狗用后腿快速抓挠自己身体（耳朵、脖子、侧腹等），后腿有节奏地来回蹬",
    "rub_body": "狗把身体某处在地面、墙面或物体上蹭：蹭脸、仰躺翻滚蹭背、侧身蹭墙、坐着拖屁股",
}


# 一个类别最多送多少条部位给视觉服务。视觉服务那边也有同样的上限——超了整批 422
# （2026-09-20 真实故障：套了解剖学层级模板之后「抓挠」有 24 条子孙，服务端卡 12，
# 303 个任务一条没跑成）。这里先截断，宁可少送几条也不要整批失败
MAX_PARTS = 60
# 部位默认送到第几层（相对父标签）：1 = 大区域（头颈耳），2 = 具体部位（耳/耳后），
# 3 = 连左右。几帧俯拍画面分不出左右，选项一多模型还容易乱选，默认到 2
DEFAULT_PART_DEPTH = 2


def label_specs(labels: list[LabelDefinition], wanted: list[str] | None = None,
                part_depth: int = DEFAULT_PART_DEPTH) -> list[dict]:
    """项目标签 → 送给视觉服务的 [{name, description, parts}]。

    只送 GROUPS 里那四类（有描述、模型分得清），项目里没有的不送。父标签按 code
    或名字（新旧名都认：「舔」「舔身体」）找，送项目里实际的显示名；部位取它的
    子孙标签加上按「父名-部位」命名的（老项目没挂父子关系也认）。
    wanted 传了就只送这几个父类（按显示名）。

    part_depth：部位送到第几层（相对父标签）。0 = 不送部位，只问是不是这个动作；
    1 = 只送大区域；2 = 送到具体部位；3 = 连左右一起送。老模板的部位本来就只有
    一层，任何 ≥1 的值行为都跟以前一样。
    """
    active = [l for l in labels if l.is_active]
    names = {l.display_name for l in active}
    by_id = {l.id: l for l in active}
    out = []
    for code, name, _color, _tpl, _parts in GROUPS:
        parent = next((l for l in active if l.code == code), None) or \
            next((l for l in active if l.display_name in alias_names(name)), None)
        if parent is None:
            continue
        if wanted is not None and parent.display_name not in wanted:
            continue
        pname = parent.display_name
        parts: list[str] = []
        if part_depth > 0:
            # 子孙标签的部位名：去掉「父名-」前缀（舔-前左爪 → 前左爪）
            desc_ids = label_tree.descendants(active, {parent.id}) - {parent.id}
            for l in sorted((l for l in active if l.id in desc_ids), key=lambda l: (l.sort_order, l.id)):
                if _depth_under(by_id, l.id, parent.id) > part_depth:
                    continue
                p = l.display_name[len(pname) + 1:] if l.display_name.startswith(pname + "-") else l.display_name
                if p and p not in parts:
                    parts.append(p)
            # 老项目：叫「父名-部位」但没挂父子关系的，按名字补上。**只补树上没有的**——
            # 挂好了父子关系的已经在上面按层取过，从这里再补一遍等于绕开 part_depth
            in_tree = {l.display_name for l in active if l.id in desc_ids}
            parts += sorted(n[len(pname) + 1:] for n in names
                            if n.startswith(pname + "-") and n not in in_tree
                            and n[len(pname) + 1:] not in parts)
        out.append({"name": pname, "description": DESCRIPTIONS.get(code, ""), "parts": parts[:MAX_PARTS]})
    return out


def _depth_under(by_id: dict[int, LabelDefinition], label_id: int, root_id: int) -> int:
    """label 在 root 底下第几层（root 的直接子标签 = 1）。不在 root 底下返回一个很大的数。"""
    chain = label_tree.ancestors_chain(by_id, label_id)      # [祖, …, 自己]，断链/成环也安全
    if root_id not in chain:
        return 1 << 30
    return len(chain) - 1 - chain.index(root_id)


@dataclass
class VisionCandidate(CandidateItem):
    model: str | None = None
    # 模型看到了什么 + 为什么这么判（视觉服务回的 desc / note）
    evidence: str | None = None


def _evidence(seg: dict) -> str | None:
    """模型回的 desc（看到了什么）+ note（为什么这么判）拼成一句话。

    两句都要：desc 是事实、note 是结论。只留结论的话，错了看不出是没看清还是
    判错了——这一轮部位检索就是栽在"只有结论没有依据"上，反复猜了四轮。
    老版本视觉服务只给 note，那就只有 note。
    """
    desc = str(seg.get("desc") or "").strip()
    note = str(seg.get("note") or "").strip()
    both = "；".join(x for x in (desc, note) if x)
    return both[:300] or None


def segments_to_candidates(segments: list[dict], label_names: set[str],
                           min_conf: float = 0.0, model: str | None = None) -> list[VisionCandidate]:
    """视觉服务返回的片段（秒）→ 候选（毫秒）。

    带部位且项目里有「父名-部位」这个标签时，候选直接落到部位标签上；
    没有就落到父标签。确认时人还能在「改成别的」里改。
    """
    out: list[CandidateItem] = []
    for s in segments or []:
        try:
            start = float(s["start_s"])
            end = float(s["end_s"])
        except (KeyError, TypeError, ValueError):
            continue
        s_ms, e_ms = int(round(start * 1000)), int(round(end * 1000))
        if e_ms <= s_ms or e_ms <= 0:
            continue
        label = str(s.get("label") or "")
        if not label:
            continue
        conf = s.get("confidence")
        try:
            conf = float(conf) if conf is not None else None
        except (TypeError, ValueError):
            conf = None
        if conf is not None and conf < min_conf:
            continue
        part = s.get("body_part")
        name = f"{label}-{part}" if part and f"{label}-{part}" in label_names else label
        out.append(VisionCandidate(label_name=name, start_time_ms=max(0, s_ms), end_time_ms=e_ms,
                                   confidence=conf, spec=None, reason=REASON, model=model,
                                   evidence=_evidence(s)))
    out.sort(key=lambda c: c.start_time_ms)
    return out


async def replace_vision_candidates(db: AsyncSession, task: Task, cands: list[VisionCandidate],
                                    model: str | None = None) -> int:
    """只换这个任务当前轮里**同一个模型给的、还没人判过的**画面候选。

    IMU 来的不碰，人已经确认/排除的不碰（那是训练数据），**别的模型给的也不碰**——
    同一批用两个模型各跑一遍就是为了并排看谁更准，第二个把第一个冲掉就没法比了。
    model=None 只换没记模型的老候选。
    """
    q = select(AiCandidate).where(
        AiCandidate.task_id == task.id,
        AiCandidate.round_no == task.round_no,
        AiCandidate.reason == REASON,
        AiCandidate.status == CandidateStatus.pending,
        AiCandidate.model == model if model is not None else AiCandidate.model.is_(None),
    )
    old = (await db.execute(q)).scalars().all()
    for o in old:
        await db.delete(o)
    for c in cands:
        db.add(AiCandidate(task_id=task.id, round_no=task.round_no, label_name=c.label_name,
                           start_time_ms=c.start_time_ms, end_time_ms=c.end_time_ms,
                           confidence=c.confidence, spec=None, reason=REASON, model=c.model,
                           evidence=c.evidence))
    return len(cands)


def video_path_of(sample: Sample, cam: str) -> str | None:
    return {"cam1": sample.video_cam1_path, "cam2": sample.video_cam2_path,
            "cam3": sample.video_cam3_path}.get(cam) or None


# ── 后台批量 ──────────────────────────────────────────────────────────

@dataclass
class SeekProgress:
    status: str = "idle"          # idle | running | paused | done | cancelled | error
    project_id: int = 0
    dry_run: bool = False
    total: int = 0
    processed: int = 0
    succeeded: int = 0
    skipped: int = 0
    failed: int = 0
    candidates: int = 0           # 写进去的候选条数
    clips_candidate: int = 0      # 本地筛出来的段数（dry_run 看这个）
    clips_sent: int = 0           # 真送去问模型的段数
    est_usd: float = 0.0
    current_task_id: int | None = None
    current_sample_code: str | None = None
    labels: list[str] = field(default_factory=list)
    llm: str | None = None        # 用的哪家哪个模型，如 anthropic:claude-opus-5；空 = 视觉服务环境变量里那把
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


_progress: dict[int, SeekProgress] = {}
_running: set[int] = set()
_cancelled: set[int] = set()
# 暂停：gate 没 set 的时候，每个任务开始前都停在 gate 上等。跟建索引那边同一套做法。
# **这一步是花钱的**（每段要问一次大模型），能随时按住比建索引那边更要紧：
# 看到前几条结果不对就该停下来改问法，而不是把钱花完再说
_paused: set[int] = set()
_gate: dict[int, asyncio.Event] = {}


def get_progress(project_id: int) -> SeekProgress:
    return _progress.get(project_id) or SeekProgress(project_id=project_id)


def is_running(project_id: int) -> bool:
    return project_id in _running


def cancel(project_id: int) -> bool:
    if project_id not in _running:
        return False
    _cancelled.add(project_id)
    _paused.discard(project_id)
    if (g := _gate.get(project_id)) is not None:
        g.set()             # 停在暂停上的也放出来，让它们看到取消
    return True


def pause(project_id: int) -> bool:
    """正在问的那个视频问完就停，后面的不开始；「继续」接着跑。

    停不到更细：一个任务里是一次 HTTP 调用（视觉服务那边再并发问几十段），
    中途掐掉的话那几段的钱已经花了、结果却丢了。所以按任务边界停。
    """
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


@dataclass
class SeekParams:
    labels: list[str] | None = None   # 只找这几个父类；None = 项目里有的全找
    part_depth: int = DEFAULT_PART_DEPTH   # 部位送到第几层，见 label_specs
    cam: str = "cam1"
    max_clips: int = 120
    min_conf: float = 0.5
    dry_run: bool = False
    clip_s: float = 6.0
    stride_s: float = 3.0
    motion_min: float = 0.02
    provider: str | None = None       # 用哪家；None = 视觉服务环境变量里的 Claude key（老方式）
    model: str | None = None          # 哪个模型；None = 那一家的默认模型


async def start(project_id: int, task_ids: list[int] | None, params: SeekParams) -> bool:
    """起后台任务。已经在跑就返回 False（不排队：一次一批，看完进度再点）。"""
    if project_id in _running:
        return False
    _running.add(project_id)
    asyncio.create_task(_run(project_id, task_ids, params))
    return True


async def _run(project_id: int, task_ids: list[int] | None, params: SeekParams) -> None:
    progress = SeekProgress(status="running", project_id=project_id, dry_run=params.dry_run,
                            started_at=time.time())
    _progress[project_id] = progress
    gate = asyncio.Event()      # 每次跑新建：Event 绑当前事件循环
    gate.set()
    _gate[project_id] = gate
    _paused.discard(project_id)
    try:
        async with SessionLocal() as db:
            await run_project(db, project_id, task_ids, params, progress)
        progress.status = "cancelled" if project_id in _cancelled else "done"
    except Exception as exc:  # noqa: BLE001 后台任务异常不能让进程崩
        progress.status = "error"
        progress.error_message = f"{type(exc).__name__}: {exc}"
    finally:
        progress.finished_at = time.time()
        progress.elapsed_sec = progress.finished_at - (progress.started_at or progress.finished_at)
        progress.current_task_id = None
        progress.current_sample_code = None
        _running.discard(project_id)
        _cancelled.discard(project_id)
        _paused.discard(project_id)
        _gate.pop(project_id, None)


async def run_project(db: AsyncSession, project_id: int, task_ids: list[int] | None,
                      params: SeekParams, progress: SeekProgress,
                      seek_fn=None) -> None:
    """逐个任务：取那一路视频 → 调视觉服务 → 写候选。一个任务失败不影响别的。"""
    seek_fn = seek_fn or vc.seek_video
    labels = (await db.execute(
        select(LabelDefinition).where(LabelDefinition.project_id == project_id)
    )).scalars().all()
    specs = label_specs(labels, params.labels, params.part_depth)
    progress.labels = [s["name"] for s in specs]
    if not specs:
        raise RuntimeError("项目里没有可找的类别（舔/啃/抓挠/蹭），先套用「抓/舔/啃/蹭」模板")
    label_names = {l.display_name for l in labels if l.is_active}

    llm = None
    model_tag = None
    if params.provider:
        llm = await llmsvc.resolve(db, params.provider, params.model)     # 配错了在这里报，一个任务都不跑
        model_tag = f"{llm['provider']}:{llm['model']}"
    progress.llm = model_tag

    query = select(Task).where(
        Task.project_id == project_id,
        Task.status.in_([TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS]),
    )
    if task_ids is not None:
        query = query.where(Task.id.in_(task_ids))
    tasks = (await db.execute(query.order_by(Task.id))).scalars().all()
    progress.total = len(tasks)

    gate = _gate.get(project_id)
    for task in tasks:
        if gate is not None:
            await gate.wait()       # 暂停时停在这里；继续 / 停止都会放行
        if project_id in _cancelled:
            progress.log(f"已取消，剩下 {progress.total - progress.processed} 个没跑")
            break
        sample = await db.get(Sample, task.sample_id)
        code = sample.sample_code if sample else f"sample#{task.sample_id}"
        progress.current_task_id = task.id
        progress.current_sample_code = code
        path = video_path_of(sample, params.cam) if sample else None
        if not path:
            progress.skipped += 1
            progress.processed += 1
            progress.log(f"任务 #{task.id} {code}：跳过（没有 {params.cam} 视频）")
            continue
        kw = {"max_clips": params.max_clips, "min_conf": params.min_conf, "dry_run": params.dry_run,
              "clip_s": params.clip_s, "stride_s": params.stride_s, "motion_min": params.motion_min}
        if llm is not None:
            kw["llm"] = llm
        if task.segment_start_ms is not None and task.segment_end_ms is not None:
            kw["start_s"] = task.segment_start_ms / 1000.0
            kw["end_s"] = task.segment_end_ms / 1000.0
        try:
            r = await seek_fn(path, specs, **kw)
        except Exception as e:  # noqa: BLE001 一个任务挂了不该带倒整批
            progress.failed += 1
            progress.processed += 1
            progress.log(f"任务 #{task.id} {code}：失败 {type(e).__name__}: {e}")
            continue
        st = r.get("stats") or {}
        progress.clips_candidate += int(st.get("clips_candidate") or 0)
        progress.clips_sent += int(st.get("clips_sent") or 0)
        progress.est_usd = round(progress.est_usd + float((st.get("usage") or {}).get("est_usd") or 0.0), 4)
        # 每一次问模型都落一行（次数 / token / 耗时），「大模型 API」页的统计从这里算
        used = st.get("llm") or {}
        prov = (llm or {}).get("provider") or used.get("provider")
        mdl = (llm or {}).get("model") or used.get("model")
        if st.get("calls") and prov and mdl:
            llm_call_service.record_calls(db, prov, mdl, st["calls"], purpose="seek", project_id=project_id, task_id=task.id)
            await db.commit()
        if params.dry_run:
            progress.succeeded += 1
            progress.processed += 1
            progress.log(f"任务 #{task.id} {code}：会送 {st.get('clips_candidate', 0)} 段（预览，没问模型）")
            continue
        cands = segments_to_candidates(r.get("segments") or [], label_names, params.min_conf, model=model_tag)
        n = await replace_vision_candidates(db, task, cands, model=model_tag)
        await db.commit()
        progress.candidates += n
        progress.succeeded += 1
        progress.processed += 1
        progress.log(f"任务 #{task.id} {code}：送 {st.get('clips_sent', 0)} 段，得 {n} 条候选")
