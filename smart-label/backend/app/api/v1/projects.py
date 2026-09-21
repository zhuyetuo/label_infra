"""
项目管理。同一份数据在不同业务场景下要标的东西不一样，所以任务和标签都挂在
项目下，项目之间标签互不干扰。所有登录用户都能读（标注/审核页要按项目筛），
只有管理员能增删改。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.task import Task, TaskStatus
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services.ai_prelabel_service import get_progress as get_prelabel_progress
from app.services.ai_prelabel_service import list_run_history as list_prelabel_history
from app.services.ai_prelabel_service import cancel_project_prelabel, start_project_prelabel
from app.services import llm_provider_service, vision_sam_client
from app.services import vision_index_service as vindex
from app.services import vision_seek_service as vseek
from app.services.task_scope import visible_project_ids
from app.services.task_service import purge_task_children
from app.schemas.project import (
    ProjectAssignRequest,
    ProjectAssignResult,
    ProjectCreate,
    ProjectOut,
    ProjectPrelabelRequest,
    ProjectUpdate,
    ProjectVisionSeekRequest,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("")
async def list_projects(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """管理员看全部；标注员/审核员只看得到有自己任务的项目。"""
    query = select(Project)
    allowed = await visible_project_ids(db, user)
    if allowed is not None:
        if not allowed:
            return ok([])
        query = query.where(Project.id.in_(allowed))
    result = await db.execute(query.order_by(Project.created_at.desc()))
    return ok([ProjectOut.model_validate(p).model_dump() for p in result.scalars().all()])


@router.post("", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def create_project(
    body: ProjectCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(get_current_user)
):
    exists = (await db.execute(select(Project).where(Project.name == body.name))).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "项目名已存在")
    project = Project(**body.model_dump(), created_by=admin.id)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ok(ProjectOut.model_validate(project).model_dump())


@router.patch("/{project_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def update_project(project_id: int, body: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    await db.commit()
    await db.refresh(project)
    return ok(ProjectOut.model_validate(project).model_dump())


@router.post("/{project_id}/assign", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def assign_project(project_id: int, body: ProjectAssignRequest, db: AsyncSession = Depends(get_db)):
    """
    把整个项目的任务一次性指派给某人：一个项目往往就是一批要一起干的活儿，
    逐个任务点太麻烦。

    默认只改还没被认领的任务（PENDING_ASSIGN）——已经有人在标或已提交的
    不动，免得把别人做了一半的活儿抢走。确实要整体换人时传 include_claimed。
    已审核通过的任务任何情况下都不动，那是归档数据。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    if body.user_id is not None:
        target = await db.get(User, body.user_id)
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
        if not target.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该账号已停用，不能指派任务")

    movable = (
        [TaskStatus.PENDING_ASSIGN, TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED, TaskStatus.REJECTED]
        if body.include_claimed
        else [TaskStatus.PENDING_ASSIGN]
    )
    total = (
        await db.execute(select(func.count()).select_from(Task).where(Task.project_id == project_id))
    ).scalar_one()

    values: dict = {"assigned_to": body.user_id}
    if body.include_claimed:
        # 换人就得把旧的软锁一起清掉，否则新人认领不了（claim 要求 PENDING_ASSIGN）
        values.update({"status": TaskStatus.PENDING_ASSIGN, "locked_by": None, "lock_expires_at": None})

    result = await db.execute(
        update(Task).where(Task.project_id == project_id, Task.status.in_(movable)).values(**values)
    )
    await db.commit()
    assigned = result.rowcount or 0
    return ok(ProjectAssignResult(assigned=assigned, skipped=total - assigned).model_dump())


@router.post("/{project_id}/ai-prelabel", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def start_ai_prelabel(project_id: int, body: ProjectPrelabelRequest, db: AsyncSession = Depends(get_db)):
    """
    给项目下的任务批量做 AI 预标注（后台跑，用 GET .../ai-prelabel/status 轮询进度）。
    一个个认领再进去点"AI预标注"太慢，这里一次把整个项目还没人动过的任务都跑掉。
    只碰待认领/标注中且没有人工痕迹的任务；overwrite_ai=true 时连已经有 AI 片段
    （但没人改过/确认过）的也重新跑一遍，比如换了模型想刷新。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    started = await start_project_prelabel(
        project_id, task_ids=body.task_ids, overwrite_ai=body.overwrite_ai, mode=body.mode
    )
    return ok({"started": started, "queued": not started})


@router.post("/{project_id}/vision-seek", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def start_vision_seek(project_id: int, body: ProjectVisionSeekRequest, db: AsyncSession = Depends(get_db)):
    """用大模型看视频找动作（后台跑，GET .../vision-seek/status 轮询）。

    vision_service 先在本地筛出"有狗且在动"的几秒窗，再抽帧问视觉大模型（API），
    像的写成候选（reason=vision），工作台「疑似片段」里确认。dry_run 只筛不问，
    先看会送多少段再决定花不花这个钱。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if body.cam not in ("cam1", "cam2", "cam3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cam 只能是 cam1 / cam2 / cam3")
    if not (1 <= body.max_clips <= 2000):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "max_clips 要在 1~2000 之间")
    if body.provider:
        # 选了哪家就用哪家配的 key；配错在这里就报，别等后台跑起来才发现
        try:
            await llm_provider_service.resolve(db, body.provider, body.model)
        except ValueError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
        st = await vision_sam_client.seek_status()
        if not st.get("providers") and not body.dry_run:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                                st.get("error") or "视觉服务连不上或版本太旧（不支持选模型），先 git pull 重启它")
    else:
        st = await vision_sam_client.seek_status()
        if not st.get("available") and not body.dry_run:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, st.get("error") or "大模型看视频找动作不可用")
    params = vseek.SeekParams(labels=body.labels, part_depth=body.part_depth, cam=body.cam,
                              max_clips=body.max_clips, min_conf=body.min_conf, dry_run=body.dry_run,
                              provider=body.provider, model=body.model, review=body.review)
    started = await vseek.start(project_id, body.task_ids, params)
    if not started:
        raise HTTPException(status.HTTP_409_CONFLICT, "这个项目正在找，等它跑完")
    return ok({"started": True})


@router.get("/{project_id}/vision-seek/status")
async def vision_seek_status(project_id: int):
    d = vseek.get_progress(project_id).to_dict()
    d["service"] = await vision_sam_client.seek_status()
    return ok(d)


@router.get("/{project_id}/vision-seek/found")
async def vision_seek_found(project_id: int, limit: int = 2000):
    """review 模式跑完之后，待人筛的那些段。状态接口只报个数，列表走这儿取一次。"""
    p = vseek.get_progress(project_id)
    return ok({"found": p.found[: max(1, min(limit, 5000))], "total": len(p.found), "review": p.review})


class SeekPickIn(BaseModel):
    """人筛完，勾中的那些段。类别是这一屏上现场改过的，以这里带的为准。"""
    picks: list[dict] = Field(default_factory=list, max_length=5000)


@router.post("/{project_id}/vision-seek/write", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def write_vision_seek(project_id: int, body: SeekPickIn, db: AsyncSession = Depends(get_db)):
    """把人勾中的段写成候选。**只加不删**——这是人一条条挑出来的，谁也没说要动别的。"""
    from app.services.vision_seek_service import VisionCandidate, add_vision_candidates

    prog = vseek.get_progress(project_id)
    by_task: dict[int, list[VisionCandidate]] = {}
    for p_ in body.picks:
        try:
            tid = int(p_["task_id"])
            s_ms, e_ms = int(p_["start_ms"]), int(p_["end_ms"])
            name = str(p_["label_name"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not name or e_ms <= s_ms:
            continue
        by_task.setdefault(tid, []).append(VisionCandidate(
            label_name=name, start_time_ms=s_ms, end_time_ms=e_ms,
            confidence=p_.get("confidence"), spec=None, reason="vision",
            model=prog.llm, evidence=p_.get("evidence")))
    written = 0
    for tid, cands in by_task.items():
        task = await db.get(Task, tid)
        if task is None or task.project_id != project_id:
            continue        # 不是这个项目的：跳过，别让一个乱传的 id 写到别处去
        # 这个项目里没有的类别不写：写进去确认时找不到标签，成了点不动的死行
        names = set((await db.execute(select(LabelDefinition.display_name).where(
            LabelDefinition.project_id == project_id, LabelDefinition.is_active.is_(True)))).scalars())
        cands = [c for c in cands if c.label_name in names]
        written += await add_vision_candidates(db, task, cands, model=prog.llm)
    await db.commit()
    # 写过的从待筛列表里去掉：再点开这一屏时，剩的才是还没处理的
    done = {(int(p_["task_id"]), int(p_["start_ms"])) for p_ in body.picks
            if p_.get("task_id") is not None and p_.get("start_ms") is not None}
    prog.found = [f for f in prog.found if (f["task_id"], f["start_ms"]) not in done]
    return ok({"written": written, "left": len(prog.found)})


@router.post("/{project_id}/vision-seek/cancel", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def cancel_vision_seek(project_id: int):
    """停：正在问的那个视频会跑完，之后的不再发。"""
    return ok({"stopped": vseek.cancel(project_id)})


@router.post("/{project_id}/vision-seek/pause", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def pause_vision_seek(project_id: int):
    """暂停：正在问的那个视频问完就停，后面的不开始；「继续」接着跑。

    这一步是花钱的（每段问一次大模型），能随时按住比建索引那边更要紧——
    看到前几条结果不对就该停下来改问法，而不是把钱花完再说。
    """
    return ok({"paused": vseek.pause(project_id), **vseek.get_progress(project_id).to_dict()})


@router.post("/{project_id}/vision-seek/resume", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def resume_vision_seek(project_id: int):
    return ok({"resumed": vseek.resume(project_id), **vseek.get_progress(project_id).to_dict()})


class VisionIndexIn(BaseModel):
    task_ids: list[int] | None = None
    # 档位：fine = 每秒一帧（慢、全）/ fast = 只解关键帧（快、稀）。
    # 快档这批素材约 12 秒一帧，**短动作会整个漏掉**，只适合"找到第一张样例"和粗筛。
    # 精档是快档的超集：已经有精档的路再要快档会原样返回，不会被降级
    mode: str = Field("fine", pattern="^(fine|fast)$")
    # all = 样本有几路建几路。cam1/2/3 是**样本里的槽位**（该狗自己房间的机位 / 公共区机位），
    # 不是现场的 1~7 号摄像头编号
    cam: str = "all"
    force: bool = False


class ProjectSearchIn(BaseModel):
    """项目级「一句话找画面」：不挑任务、不要样例帧，直接一句英文搜整个项目。"""
    text: str = Field(min_length=1, max_length=300)
    top_k: int = 60
    min_score: float = 0.0
    gap_s: float = 15.0
    center: bool = True
    pose_w: float | None = None
    part: str | None = Field(None, max_length=40)


@router.post("/{project_id}/similar-search")
async def project_similar_search(project_id: int, body: ProjectSearchIn,
                                 db: AsyncSession = Depends(get_db),
                                 user: User = Depends(get_current_user)):
    """一句话在整个项目里找画面。**只搜不写**——写哪几张由人在结果里勾。

    为什么要项目级这个入口：想找「一张狗咬尾巴的图」的时候，人手上还没有任何
    样例，本来也不该先随便挑个任务、打开工作台、再去里面找这个功能。
    """
    # 参数顺序是 (db, user)；而且管理员那一档返回的是 None（= 不受限），
    # 不是"一个空集合"——两件事都写错过一次，直接 500
    allowed = await visible_project_ids(db, user)
    if allowed is not None and project_id not in allowed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在或无权访问")
    params = vindex.SimilarParams(
        label_name="", text=body.text.strip(), scope="project",
        top_k=max(1, min(500, body.top_k)), min_score=body.min_score,
        gap_s=max(0.0, min(120.0, body.gap_s)), center=body.center,
        pose_w=(max(0.0, min(1.0, body.pose_w)) if body.pose_w is not None else None),
        part=body.part, dry_run=True)
    try:
        r = await vindex.find_similar(db, None, params, project_id=project_id)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    except vision_sam_client.SamUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e
    return ok({"hits": r["hit_list"], "searched": r["searched"], "missing": r["missing"],
               "centered": r["centered"], "pose_used": r["pose_used"],
               # 有几路索引是旧版（没有"没抠背景"那一列），这次没搜它们
               "old_index": r.get("old_index", 0), "text_space": r.get("text_space"),
               "coarse": r.get("coarse", 0)})


class ProjectSearchWriteIn(BaseModel):
    """人在结果里勾中的帧：[[任务号, 路径, 秒, 类别名], …]。类别各按各的。"""
    picks: list[tuple[int, str, float, str]] = Field(default_factory=list, max_length=2000)
    gap_s: float = 15.0


@router.post("/{project_id}/similar-write", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def project_similar_write(project_id: int, body: ProjectSearchWriteIn,
                                db: AsyncSession = Depends(get_db)):
    """把勾中的帧合成段写成候选。按（任务, 类别）分组合段，跟工作台那边同一套规则。"""
    names = set((await db.execute(select(LabelDefinition.display_name).where(
        LabelDefinition.project_id == project_id, LabelDefinition.is_active.is_(True)))).scalars())
    missing = sorted({lab for _t, _p, _s, lab in body.picks if lab not in names})
    if missing:
        # 写进去确认时找不到标签，那条候选就成了点不动的死行——宁可整批不写并说清楚
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            f"项目里没有这些标签：{'、'.join(missing)}（先去标签管理里加）")
    by_task: dict[int, list[dict]] = {}
    for tid, path, t, lab in body.picks:
        by_task.setdefault(int(tid), []).append({"path": path, "t": float(t), "score": 0.0, "label": lab})
    written = 0
    segments = 0
    per_task: list[dict] = []
    gap = max(0.0, min(120.0, body.gap_s))
    for tid, hits in by_task.items():
        task = await db.get(Task, tid)
        if task is None or task.project_id != project_id:
            continue        # 不是这个项目的：跳过，别让一个乱传的 id 写到别处去
        segs = vindex.group_hits(hits, gap)
        segments += len(segs)
        n = await vindex.add_similar_candidates(db, task, "", segs)
        written += n
        if n:
            per_task.append({"task_id": tid, "n": n})
    await db.commit()
    # **写到哪几个任务去了**：只说"写了 N 条"等于没说——候选散在别的任务里，
    # 人根本不知道去哪找。带上任务号，界面才能给出链接
    per_task.sort(key=lambda x: -x["n"])
    # 合出来几段、真写了几条：差额就是"跟已有候选重叠、没重复写"的那些。
    # 不报这个差额的话，人看到「写了 0 条」只会以为是坏了——其实是早就写过了
    return ok({"written": written, "segments": segments,
               "skipped_existing": max(0, segments - written), "tasks": per_task})


@router.post("/{project_id}/vision-index", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def start_vision_index(project_id: int, body: VisionIndexIn, db: AsyncSession = Depends(get_db)):
    """给项目里的视频建画面向量索引（后台）。建好之后工作台里能「找相似」，免费、瞬间。"""
    if await db.get(Project, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")
    if body.cam not in ("all", "cam1", "cam2", "cam3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "cam 只能是 all / cam1 / cam2 / cam3")
    st = await vision_sam_client.embed_status()
    if not st.get("available"):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, st.get("error") or "画面向量模型不可用")
    if not await vindex.start(project_id, body.task_ids, body.cam, body.force, body.mode):
        raise HTTPException(status.HTTP_409_CONFLICT, "这个项目正在建索引，等它跑完")
    return ok({"started": True})


@router.get("/{project_id}/vision-index/status")
async def vision_index_status(project_id: int):
    d = vindex.get_progress(project_id).to_dict()
    d["service"] = await vision_sam_client.embed_status()
    return ok(d)


@router.post("/{project_id}/vision-index/cancel", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def cancel_vision_index(project_id: int):
    """停止：立刻，正在建的那几路也掐掉；建好的保留。"""
    return ok({"stopped": vindex.cancel(project_id)})


@router.post("/{project_id}/vision-index/pause", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def pause_vision_index(project_id: int):
    """暂停：正在建的那几路建完就停，后面的不开始；「继续」接着建。"""
    return ok({"paused": vindex.pause(project_id), **vindex.get_progress(project_id).to_dict()})


@router.post("/{project_id}/vision-index/resume", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def resume_vision_index(project_id: int):
    return ok({"resumed": vindex.resume(project_id), **vindex.get_progress(project_id).to_dict()})


@router.get("/{project_id}/ai-prelabel/status")
async def ai_prelabel_status(project_id: int, db: AsyncSession = Depends(get_db)):
    """
    进度在内存里，服务重启（git pull && bash up.sh）就没了；没有在跑的时候
    退回到 audit_logs 里最近一次的记录，项目行里"上次 AI 预标注 N 个，总耗时 x:xx"
    重启后也还在。
    """
    progress = get_prelabel_progress(project_id).to_dict()
    if progress["status"] == "idle":
        history = await list_prelabel_history(db, project_id, limit=1)
        if history:
            last = history[0]
            finished = datetime.fromisoformat(last["finished_at"]).timestamp() if last.get("finished_at") else None
            progress.update(
                status=last.get("status", "done"),
                total=last.get("total", 0),
                processed=last.get("total", 0),
                succeeded=last.get("succeeded", 0),
                skipped=last.get("skipped", 0),
                failed=last.get("failed", 0),
                elapsed_sec=last.get("elapsed_sec", 0.0),
                ai_wait_sec=last.get("ai_wait_sec", 0.0),
                batches_done=last.get("batches", 0),
                unmatched_labels=last.get("unmatched_labels", []),
                error_message=last.get("error_message"),
                finished_at=finished,
            )
    return ok(progress)


@router.post("/{project_id}/ai-prelabel/cancel", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def ai_prelabel_cancel(project_id: int):
    """
    停掉正在跑的批量预标注。

    已经发给 AI 服务的那一批停不下来（那边进程池正在算，中途撤回只会留下一半
    写进草稿一半没写的烂摊子），所以是「这一批跑完就停」——几十秒内会停。
    已经写好的草稿保留，剩下没跑的任务下次再跑。
    """
    stopped = cancel_project_prelabel(project_id)
    return ok({"stopped": stopped}, msg="正在停止，当前这一批跑完就停" if stopped else "这个项目没有在跑的预标注")


@router.get("/{project_id}/ai-prelabel/history")
async def ai_prelabel_history(project_id: int, db: AsyncSession = Depends(get_db)):
    """最近几次批量预标注的耗时/数量记录（存在 audit_logs 里，重启不丢）。"""
    return ok(await list_prelabel_history(db, project_id))


@router.delete("/{project_id}", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def delete_project(project_id: int, db: AsyncSession = Depends(get_db)):
    """
    删项目会把它下面的任务、标注结果、候选、审核记录、标签一起删掉，不可恢复。
    外键都指向上一层，不能直接删项目：任务下面那几张表由 purge_task_children
    统一按顺序清（跟删任务共用一份，免得再出现"一边加了新表另一边漏掉"），
    这里只管任务本身、标签定义、项目。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "项目不存在")

    task_ids = (
        (await db.execute(select(Task.id).where(Task.project_id == project_id))).scalars().all()
    )
    if task_ids:
        await purge_task_children(db, task_ids)
        await db.execute(delete(Task).where(Task.project_id == project_id))
    # 标签有父子自引用外键（parent_id）：整批 DELETE 时父可能先于子被删，MySQL 直接报
    # 外键错。先把这个项目里的 parent_id 全清空，再删
    await db.execute(update(LabelDefinition).where(LabelDefinition.project_id == project_id).values(parent_id=None))
    label_count = (
        await db.execute(delete(LabelDefinition).where(LabelDefinition.project_id == project_id))
    ).rowcount or 0

    await db.delete(project)
    await db.commit()
    return ok(msg=f"项目已删除（连带 {len(task_ids)} 个任务、{label_count} 个标签）")
