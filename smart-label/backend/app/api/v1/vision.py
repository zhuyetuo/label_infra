"""
视觉标注工作台（雏形）：在素材库的口腔/皮肤照片上画框、打类别、填属性。

跟现有模块的关系：照片列表和图片流完全复用 /material/{album}/*（一行没改），
标注结果落自己的两张表（vision_assets / vision_annotations），不碰 samples /
tasks / annotation_* 任何一张。所以这个页面坏掉不会影响任何现有功能，反过来也一样。

权限：登录就能进这个路由，但看得见什么由指派决定——管理员/审核员看整个相册，
标注员只看指派给自己的组，别的整组在接口层就被剔掉（不是靠前端不显示）。
指派、导出、删数据集这些管理动作在各自接口上单独要管理员。

这套可见性是自己实现的，没有走 task_scope——那是 samples/tasks 那条链路的东西，
照片不是样本，硬接过去要先让 samples 接受"没有视频也没有 IMU 的样本"，会动到
一堆现有热路径。
"""

import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.user import User, UserRole
from app.models.vision_annotation import VisionAnnotation, VisionAssignment, VisionAsset
from app.schemas.envelope import ok
from app.services import (
    tooth_service,
    vision_export_service as exp,
    vision_sam_client as sam_client,
    vision_service as svc,
)

# 登录就能进这个路由，但**能看见什么由下面的可见性判据决定**：
# 管理员和审核员看整个相册，标注员只看指派给自己的那几组，别的一张都看不到。
# 导出、指派、删数据集这些管理动作在各自的接口上单独要管理员。
router = APIRouter(prefix="/vision", tags=["vision"])

_MANAGERS = (UserRole.admin, UserRole.super_admin)
_REVIEWERS = (UserRole.admin, UserRole.super_admin, UserRole.reviewer)
# 通过 = 锁定。要再改必须由审核员打回，否则"审过了"这件事就没有意义
_EDITABLE_STATES = ("open", "rejected")


def _is_manager(user: User) -> bool:
    return user.role in _MANAGERS


def _can_review(user: User) -> bool:
    return user.role in _REVIEWERS


def _assignment_dict(row: VisionAssignment) -> dict:
    return {
        "id": row.id,
        "album": row.album,
        "group_key": row.group_key,
        "assignee_id": row.assignee_id,
        "state": row.state,
        "review_note": row.review_note,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def _my_assignments(db: AsyncSession, album: str, user: User) -> dict[str, VisionAssignment]:
    """这个人被指派了哪些组。管理员/审核员不受指派限制，返回空表示"不设限"。"""
    rows = (
        await db.execute(
            select(VisionAssignment).where(
                VisionAssignment.album == album, VisionAssignment.assignee_id == user.id
            )
        )
    ).scalars().all()
    return {r.group_key: r for r in rows}


# 「这张图不归你」和「这张图不存在」必须是同一个回答。不一样的话，标注员就能
# 拿任何一个接口当探针：日期目录是 YYYY-MM-DD-ok、狗名就那么几个、文件名是
# 时间戳格式，全是可枚举的，按回答的差别就能把整个相册的目录结构摸出来。
# 所以也不能把请求里的路径回显在错误里。
_NOT_FOUND = "没有这张照片"


def _no_such_photo() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)


async def _check_readable(db: AsyncSession, album: str, rel_path: str, user: User) -> str:
    """校验路径 + 判可见性，返回规范化后的相对路径。

    顺序很重要：**先判可见性，再看文件在不在**。反过来的话，"文件不存在"和
    "不是你的组"会给出不同的回答（前者还会把路径原样回显），那就是一个探针。
    """
    try:
        svc.clean_rel_path(rel_path)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    if not _can_review(user):
        mine = await _my_assignments(db, album, user)
        if svc.group_of(rel_path) not in mine:
            raise _no_such_photo()
    try:
        svc.check_photo(album, rel_path)
    except svc.VisionError as e:
        # 归属过了但文件不在：对管理员如实说，对标注员仍然是统一的那句
        raise (HTTPException(status.HTTP_404_NOT_FOUND, str(e)) if _can_review(user) else _no_such_photo()) from e
    return rel_path


async def _check_writable(db: AsyncSession, album: str, rel_path: str, user: User) -> str:
    """同上，外加「能不能改」。

    这里的顺序有两条互相拉扯的约束，都要满足：
      - 「管理员也不能直接改已通过的」必须成立（审过的结论被静默改掉，审核就白做了），
        所以 approved 的检查不能放在 _is_manager 之后；
      - 但也不能把它放在归属判断之前——那样 anna 往 ben 组写会拿到 409
        「已通过、锁定了」，而没通过时是 404，一问就知道别人组审到哪了。
    解法是先判可见性，再判锁定：管理员天然可见，所以对他 approved 照样拦得住。
    """
    try:
        svc.clean_rel_path(rel_path)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    group = svc.group_of(rel_path)
    row = (
        await db.execute(
            select(VisionAssignment).where(
                VisionAssignment.album == album, VisionAssignment.group_key == group
            )
        )
    ).scalar_one_or_none()

    visible = _is_manager(user) or (row is not None and row.assignee_id == user.id)
    if not visible:
        raise _no_such_photo()
    if row is not None and row.state == "approved":
        raise HTTPException(status.HTTP_409_CONFLICT, "这组已经审核通过、锁定了。要改先让审核员打回。")
    if not _is_manager(user) and row is not None and row.state not in _EDITABLE_STATES:
        raise HTTPException(status.HTTP_409_CONFLICT, "这组已经提交，等审核结果；被打回后可以继续改。")

    try:
        svc.check_photo(album, rel_path)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return rel_path


@router.get("/labels")
async def get_labels(album: str = Query("oral"), user: User = Depends(get_current_user)):  # noqa: ARG001
    """这个相册用哪套类别、每个框能填哪些属性、图级属性有哪些"""
    try:
        return ok(svc.catalog(album))
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e


@router.get("/photos")
async def list_photos(album: str = Query("oral"), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """相册目录树，每张图挂上「标了几个框、状态是什么」。

    照片本身走 tooth_service.list_photos（跟 /material 同一个函数），这里只是把
    标注进度和指派状态贴上去。**标注员只会看到指派给自己的组**，别的整组都不返回。
    """
    try:
        svc.domain_of(album)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    try:
        # 扫 NAS 目录是阻塞 IO，扔线程里——NAS 卡一下不该把整个 API 进程拖住
        folders = await asyncio.to_thread(tooth_service.list_photos, album)
    except tooth_service.ToothError as e:  # 目录不存在 / 素材库 NAS 没挂上
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e

    assigns = {
        r.group_key: r
        for r in (await db.execute(select(VisionAssignment).where(VisionAssignment.album == album))).scalars().all()
    }
    if not _can_review(user):
        # 在这里就把别人的组整组剔掉，而不是靠前端不显示——前端过滤等于没过滤
        allowed = {k for k, v in assigns.items() if v.assignee_id == user.id}
        kept = []
        for folder in folders:
            dogs = [d for d in folder["dogs"] if svc.group_of(d["photos"][0]["rel_path"]) in allowed]
            if dogs:
                kept.append({**folder, "dogs": dogs})
        folders = kept

    counts = dict(
        (
            await db.execute(
                select(VisionAnnotation.rel_path, func.count(VisionAnnotation.id))
                .where(VisionAnnotation.album == album)
                .group_by(VisionAnnotation.rel_path)
            )
        ).all()
    )
    states = {
        r.rel_path: r.state
        for r in (await db.execute(select(VisionAsset).where(VisionAsset.album == album))).scalars().all()
    }
    for folder in folders:
        for dog in folder["dogs"]:
            group = svc.group_of(dog["photos"][0]["rel_path"]) if dog["photos"] else ""
            a = assigns.get(group)
            dog["group_key"] = group
            dog["assignment"] = _assignment_dict(a) if a else None
            for p in dog["photos"]:
                p["n_boxes"] = int(counts.get(p["rel_path"], 0))
                p["state"] = states.get(p["rel_path"], "todo")
    return ok({"album": album, "folders": folders, "can_review": _can_review(user), "is_manager": _is_manager(user)})


@router.post("/photos/token")
async def photo_token(body: dict, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """图片流的短期签名 token。

    为什么不让前端直接用 /material/{album}/photos/token：那个路由是管理员专属的，
    标注员拿不到。这里按「这张图在不在你被指派的组里」发 token，是这个页面对
    标注员开放之后唯一的取图入口。
    """
    album = body.get("album") or "oral"
    rel_path = body.get("path") or ""
    await _check_readable(db, album, rel_path, user)
    # 有效期用 vision 自己的 10 分钟，不是 media 那个 4 小时：这个 token 不查库、
    # 不带身份、不可吊销，撤销指派之后只能等它过期，所以这个"等"必须短
    return ok({"token": svc.issue_photo_token(album, rel_path)})


@router.get("/annotations")
async def get_annotations(album: str = Query("oral"), path: str = Query(...), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """一张照片上已有的框 + 这张图的状态和图级属性"""
    await _check_readable(db, album, path, user)
    rows = (
        await db.execute(
            select(VisionAnnotation)
            .where(VisionAnnotation.album == album, VisionAnnotation.rel_path == path)
            .order_by(VisionAnnotation.id)
        )
    ).scalars().all()
    asset = (
        await db.execute(select(VisionAsset).where(VisionAsset.album == album, VisionAsset.rel_path == path))
    ).scalar_one_or_none()
    return ok({
        "items": [svc.annotation_to_dict(r) for r in rows],
        "asset": svc.asset_to_dict(asset) if asset else {
            "album": album, "rel_path": path, "state": "todo",
            "skip_reason": None, "attrs": {}, "width": None, "height": None, "updated_at": None,
        },
    })


class ItemIn(BaseModel):
    label_code: str
    bbox: list[float] = Field(..., min_length=4, max_length=4, description="[x, y, w, h] 归一化 0-1")
    attrs: dict | None = None


class SaveIn(BaseModel):
    album: str = "oral"
    path: str
    items: list[ItemIn] = Field(default_factory=list, max_length=500)
    state: str = Field("done", description="todo / done / skipped")
    skip_reason: str | None = None
    asset_attrs: dict | None = None
    width: int | None = None
    height: int | None = None


@router.put("/annotations")
async def save_annotations(body: SaveIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """整张图的框一次性覆盖保存。

    为什么是整张覆盖而不是逐条增删改：一张图撑死几十个框，整存整取省掉了前端维护
    临时 id、后端做增量 diff 的全部复杂度，也就没有「删了一半网断了」这种半截状态。
    等一张图上百个框了再说。
    """
    try:
        allowed = svc.valid_label_codes(body.album)
        if body.state not in svc.ASSET_STATES:
            raise svc.VisionError(f"state 只能是 {', '.join(svc.ASSET_STATES)}")
        prepared = []
        for it in body.items:
            if it.label_code not in allowed:
                raise svc.VisionError(f"这个相册没有类别 {it.label_code}")
            prepared.append((it.label_code, svc.normalize_bbox(it.bbox), svc.clean_attrs(it.attrs)))
        asset_attrs = svc.clean_attrs(body.asset_attrs)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    await _check_writable(db, body.album, body.path, user)

    await db.execute(
        delete(VisionAnnotation).where(
            VisionAnnotation.album == body.album, VisionAnnotation.rel_path == body.path
        )
    )
    for label_code, bbox, attrs in prepared:
        db.add(VisionAnnotation(
            album=body.album, rel_path=body.path, label_code=label_code,
            bbox=json.dumps(bbox), attrs=attrs,
            source="human", created_by=user.id,
        ))

    asset = (
        await db.execute(select(VisionAsset).where(VisionAsset.album == body.album, VisionAsset.rel_path == body.path))
    ).scalar_one_or_none()
    if asset is None:
        asset = VisionAsset(album=body.album, rel_path=body.path)
        db.add(asset)
    asset.state = body.state
    asset.skip_reason = body.skip_reason
    asset.attrs = asset_attrs
    if body.width:
        asset.width = body.width
    if body.height:
        asset.height = body.height
    asset.updated_by = user.id

    await db.commit()
    return ok({"saved": len(prepared), "state": body.state})


class SamPoint(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    label: int = Field(1, description="1=正点（要这块），0=负点（不要这块）")


class SamIn(BaseModel):
    album: str = "oral"
    path: str
    points: list[SamPoint] = Field(default_factory=list, max_length=32)
    box: list[float] | None = Field(None, min_length=4, max_length=4)


@router.get("/sam/status")
async def sam_status(user: User = Depends(get_current_user)):  # noqa: ARG001
    """SAM 辅助开着没有。前端据此决定按钮置灰还是可点。"""
    return ok(await sam_client.status())


@router.post("/sam/segment")
async def sam_segment(body: SamIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """在图上点一下出一个框。

    权限跟保存走同一条判据：能改这张图的人才能用 SAM 点它。否则等于开了个后门，
    谁都能拿它去探别人组里的照片存不存在。
    """
    await _check_writable(db, body.album, body.path, user)
    if not body.points and not body.box:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "至少点一个点")

    # vision_service 那边的路径是相对素材库根的，要带上相册目录这一层
    material_rel = f"{tooth_service.ALBUMS[body.album]()}/{body.path}"
    try:
        data = await sam_client.segment(material_rel, [p.model_dump() for p in body.points], body.box)
    except sam_client.SamUnavailable as e:
        # 503 而不是 500：前端据此提示"SAM 暂时用不了，先手画"，而不是弹个报错
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from e

    try:
        bbox = svc.normalize_bbox(data.get("bbox"))
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"SAM 返回的框不合法：{e}") from e
    return ok({"bbox": bbox, "polygon": data.get("polygon"), "score": data.get("score")})


class AssignIn(BaseModel):
    album: str = "oral"
    group_keys: list[str] = Field(..., min_length=1, max_length=200, description="日期目录/狗名")
    assignee_id: int


@router.post("/assignments")
async def create_assignments(body: AssignIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_role(*_MANAGERS))):
    """把若干组指派给一个标注员。已经指派过的组会改派（除非已通过、锁定了）。"""
    try:
        svc.domain_of(body.album)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    assignee = await db.get(User, body.assignee_id)
    if assignee is None or not assignee.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "这个账号不存在或已禁用")

    existing = {
        r.group_key: r
        for r in (await db.execute(select(VisionAssignment).where(VisionAssignment.album == body.album))).scalars().all()
    }
    created, moved, locked = 0, 0, []
    # 同一个请求里出现重复的 group_key 会连插两条、撞唯一键变成 500。
    # 前端多选时很容易出现重复，这里去重（保持顺序，便于复现问题）
    for g in dict.fromkeys(body.group_keys):
        row = existing.get(g)
        if row is None:
            db.add(VisionAssignment(album=body.album, group_key=g, assignee_id=body.assignee_id, created_by=user.id))
            created += 1
            continue
        if row.state == "approved":
            # 改派一个已通过的组会让"审过了"这件事失效，要先打回
            locked.append(g)
            continue
        if row.assignee_id != body.assignee_id:
            row.assignee_id = body.assignee_id
            row.state = "open"
            row.review_note = None
            moved += 1
    await db.commit()
    return ok({"created": created, "moved": moved, "locked": locked})


@router.get("/assignments")
async def list_assignments(album: str = Query("oral"), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """管理员/审核员看全部，标注员只看自己的"""
    stmt = select(VisionAssignment).where(VisionAssignment.album == album)
    if not _can_review(user):
        stmt = stmt.where(VisionAssignment.assignee_id == user.id)
    rows = (await db.execute(stmt.order_by(VisionAssignment.group_key))).scalars().all()
    names = {
        u.id: (u.display_name or u.username)
        for u in (await db.execute(select(User))).scalars().all()
    }
    return ok([{**_assignment_dict(r), "assignee_name": names.get(r.assignee_id)} for r in rows])


@router.post("/assignments/{assignment_id}/submit")
async def submit_assignment(assignment_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """标注员交活。交之前先数一遍：还有没标完的图就先拦住，别等审核员发现。"""
    row = await db.get(VisionAssignment, assignment_id)
    if row is None or (not _is_manager(user) and row.assignee_id != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这条指派")
    if row.state not in _EDITABLE_STATES:
        raise HTTPException(status.HTTP_409_CONFLICT, "已经提交过了" if row.state == "submitted" else "这组已经通过，不用再交")

    try:
        folders = await asyncio.to_thread(tooth_service.list_photos, row.album)
    except tooth_service.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    paths = [
        p["rel_path"]
        for f in folders for d in f["dogs"] for p in d["photos"]
        if svc.group_of(p["rel_path"]) == row.group_key
    ]
    done = {
        r.rel_path
        for r in (
            await db.execute(
                select(VisionAsset).where(VisionAsset.album == row.album, VisionAsset.rel_path.in_(paths))
            )
        ).scalars().all()
        if r.state in ("done", "skipped")
    }
    left = [p for p in paths if p not in done]
    if left:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"这组还有 {len(left)} 张没表态（标完或跳过都算）。没表态的图在导出时会被当成「还没标」整张丢掉。",
        )

    row.state = "submitted"
    row.review_note = None
    await db.commit()
    return ok(_assignment_dict(row))


class ReviewIn(BaseModel):
    approve: bool
    note: str | None = Field(None, max_length=500)


@router.post("/assignments/{assignment_id}/review")
async def review_assignment(assignment_id: int, body: ReviewIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_role(*_REVIEWERS))):
    """通过（锁定）或打回（可继续改）。打回必须写清楚哪里要改。"""
    row = await db.get(VisionAssignment, assignment_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这条指派")
    if not body.approve and not (body.note or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "打回要写明哪里需要改，不然对方只能猜")
    row.state = "approved" if body.approve else "rejected"
    row.review_note = (body.note or "").strip() or None
    row.reviewed_by = user.id
    row.reviewed_at = datetime.now()
    await db.commit()
    return ok(_assignment_dict(row))


@router.delete("/assignments/{assignment_id}")
async def delete_assignment(assignment_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_role(*_MANAGERS))):  # noqa: ARG001
    """撤销指派。只删指派关系，已经标好的框原样留着。"""
    row = await db.get(VisionAssignment, assignment_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这条指派")
    await db.execute(delete(VisionAssignment).where(VisionAssignment.id == assignment_id))
    await db.commit()
    return ok({"deleted": assignment_id})


@router.get("/annotators")
async def list_annotators(db: AsyncSession = Depends(get_db), user: User = Depends(require_role(*_MANAGERS))):  # noqa: ARG001
    """能被指派的人：标注员，加上管理员自己（小团队里管理员也常常自己标）"""
    rows = (
        await db.execute(
            select(User).where(
                User.is_active.is_(True),
                User.role.in_([UserRole.annotator, UserRole.admin, UserRole.super_admin]),
            ).order_by(User.id)
        )
    ).scalars().all()
    return ok([{"id": u.id, "name": u.display_name or u.username, "role": u.role.value} for u in rows])


class ExportIn(BaseModel):
    album: str = "oral"
    name: str = Field(..., description="数据集目录名，字母数字下划线短横线")
    val_ratio: float = Field(0.2, ge=0.0, le=1.0)
    only_approved: bool = Field(
        False,
        description="只要审核通过的组。默认 False：被打回的组一律排除，其余（通过/标注中/没指派）都进——"
                    "小团队里管理员常常自己标自己不审，全要求通过的话就导不出东西了",
    )


@router.post("/export")
async def export_dataset(body: ExportIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_role(UserRole.admin, UserRole.super_admin))):
    """导出成 YOLO 检测数据集，落 nas_root/data_train_vision/<name>/。

    刻意不跟 IMU 那套 data_train 混在一个目录——那边的 list_datasets 会把每个带
    meta.json 的目录都读出来丢给模型训练页，delete_dataset 又只按名字删。
    """
    try:
        exp.dataset_root(body.name)  # 先把名字校验了，不然扫完全表才发现名字不合法
        assets = (
            await db.execute(select(VisionAsset).where(VisionAsset.album == body.album))
        ).scalars().all()
        rows = (
            await db.execute(select(VisionAnnotation).where(VisionAnnotation.album == body.album))
        ).scalars().all()
        assigns = {
            r.group_key: r.state
            for r in (
                await db.execute(select(VisionAssignment).where(VisionAssignment.album == body.album))
            ).scalars().all()
        }
        boxes: dict[str, list[dict]] = {}
        for r in rows:
            boxes.setdefault(r.rel_path, []).append({"label_code": r.label_code, "bbox": svc.load_bbox(r.bbox)})
        plan = exp.plan_dataset(
            body.album,
            [{"rel_path": a.rel_path, "state": a.state, "review_state": assigns.get(svc.group_of(a.rel_path))}
             for a in assets],
            boxes, body.val_ratio, only_approved=body.only_approved,
        )
        if not plan["items"]:
            raise exp.ExportError(
                "没有一张图能进这个数据集。要么还没标完，要么所属的组被打回了/还没审过"
                "（勾上「只要审核通过的」时，只有通过的组才算）。"
            )
        # 复制几百张原图是纯 IO，扔到线程里跑。留在事件循环上会把整个 API 进程
        # 卡住几十秒——包括样本、任务、审核这些跟视觉毫无关系的现有功能
        meta = await asyncio.to_thread(exp.write_dataset, body.name, plan, user.username)
    except (exp.ExportError, svc.VisionError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return ok(meta)


@router.get("/datasets")
async def list_datasets(user: User = Depends(require_role(*_MANAGERS))):  # noqa: ARG001
    """只列视觉数据集（data_train_vision），跟模型训练页那边的列表互不干扰"""
    return ok(await asyncio.to_thread(exp.list_datasets))


@router.delete("/datasets/{name}")
async def delete_dataset(name: str, user: User = Depends(require_role(*_MANAGERS))):  # noqa: ARG001
    try:
        await asyncio.to_thread(exp.delete_dataset, name)
    except exp.ExportError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return ok({"deleted": name})


@router.get("/stats")
async def stats(album: str = Query("oral"), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """标了多少、各类别各多少。看进度用，也是导出前的一眼体检。

    标注员看到的是**自己那几组**的进度，不是全局——既是权限（别的组他本来就看不见），
    也更有用（他关心的是自己还剩多少）。
    """
    try:
        svc.domain_of(album)
    except svc.VisionError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    # 按组过滤在 Python 里做而不是拼 LIKE：散图那种组名就是日期目录，
    # `日期/%` 会连带匹配到 `日期/狗/图`，多给出去的正是不该看见的那些
    mine: set[str] | None = None
    if not _can_review(user):
        mine = set((await _my_assignments(db, album, user)).keys())

    ann = (await db.execute(select(VisionAnnotation).where(VisionAnnotation.album == album))).scalars().all()
    assets = (await db.execute(select(VisionAsset).where(VisionAsset.album == album))).scalars().all()
    if mine is not None:
        ann = [r for r in ann if svc.group_of(r.rel_path) in mine]
        assets = [r for r in assets if svc.group_of(r.rel_path) in mine]

    by_label: dict[str, int] = {}
    for r in ann:
        by_label[r.label_code] = by_label.get(r.label_code, 0) + 1
    by_state: dict[str, int] = {}
    for r in assets:
        by_state[r.state] = by_state.get(r.state, 0) + 1

    return ok({
        "by_label": [{"label_code": c, "n": n} for c, n in sorted(by_label.items())],
        "by_state": [{"state": s, "n": n} for s, n in sorted(by_state.items())],
        "total_boxes": sum(by_label.values()),
        "scoped": mine is not None,
    })
