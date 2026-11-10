"""
素材库相册浏览（只读）：album=oral 口腔照片 / skin 皮肤瘙痒问诊照片，两者在 NAS 上都是
{日期-ok}/{狗}/*.jpg 的结构，共用 tooth_service 里的扫描/路径签名逻辑。牙齿识别页用
/tooth/photos（带检测结果），皮肤评估页用这里的 /material/skin/photos（纯看图）。
"""

import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.photo_flag import PhotoFlag
from app.models.skin_photo_rating import SkinPhotoRating
from app.core import permissions as perms
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import tooth_service as svc
from app.services.range_stream import stream_file

router = APIRouter(prefix="/material", tags=["material"])

# 皮肤照片：兽医 / 实习生要看图评级，登录了就能看；口腔照片照旧只给管理员
OPEN_ALBUMS = {"skin"}
GRADES = ("S0", "S1", "S2", "unsure")


def _check_album(album: str, user: User) -> None:
    if album not in OPEN_ALBUMS and user.role not in (UserRole.admin, UserRole.super_admin):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "没有权限看这个相册")
stream_router = APIRouter(prefix="/material", tags=["material"])

_CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp"}


@router.get("/{album}/photos")
async def list_photos(album: str, user: User = Depends(get_current_user)):
    _check_album(album, user)
    try:
        # sources：每个来源扫到多少张、多少张分不出品类——页面靠它说清「这个狗场为什么一张都没有」。
        # 扫 NAS 放线程里（原来直接在事件循环里扫，扫的这几秒整个后端都卡住），结果缓存 60 秒
        folders, sources = await asyncio.to_thread(svc.list_photos_cached, album)
        return ok({"root": svc.album_root(album), "folders": folders, "sources": sources})
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e


@router.post("/{album}/photos/token")
async def photo_token(album: str, body: dict, user: User = Depends(get_current_user)):
    _check_album(album, user)
    rel_path = body.get("path") or ""
    try:
        svc.resolve_photo(rel_path, album)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    return ok({"token": svc.issue_photo_token(rel_path, album)})


class TokensIn(BaseModel):
    paths: list[str] = Field(..., max_length=2000)


@router.post("/{album}/photos/tokens")
async def photo_tokens(album: str, body: TokensIn, user: User = Depends(get_current_user)):
    """一次给一批照片发访问凭证（原来一张一个请求，一只狗十几张就是十几个来回）。
    只签名、不碰 NAS：路径对不对等真正取图时 resolve_photo 再校验"""
    _check_album(album, user)
    return ok({p: svc.issue_photo_token(p, album) for p in body.paths})


def _thumb(full: str, w: int) -> str:
    """缩略图：长边缩到 w，存在本地缓存目录（按 路径+修改时间+大小 命名，原图改了自动换新）。
    手机原图一张几 MB，网格里显示 160px 的小图却要把整张从 NAS 拉下来——十几张就是几十 MB"""
    import hashlib

    from PIL import Image, ImageOps

    st = os.stat(full)
    key = hashlib.sha1(f"{full}|{st.st_mtime_ns}|{st.st_size}|{w}".encode()).hexdigest()
    out_dir = os.path.join(settings.log_dir, "..", "thumb-cache", key[:2])
    out = os.path.join(out_dir, key + ".jpg")
    if os.path.isfile(out):
        return out
    os.makedirs(out_dir, exist_ok=True)
    with Image.open(full) as im:
        im = ImageOps.exif_transpose(im)      # 手机照片带旋转信息，不转的话缩略图是横着的
        im.thumbnail((w, w))
        tmp = out + ".tmp"
        im.convert("RGB").save(tmp, "JPEG", quality=78, optimize=True)
        os.replace(tmp, out)
    return out


@stream_router.get("/{album}/photos/stream")
async def photo_stream(album: str, path: str, token: str, request: Request, w: int | None = None):
    if not svc.verify_photo_token(path, token, album):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "token 无效或已过期")
    try:
        full = svc.resolve_photo(path, album)
    except svc.ToothError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    # w：要缩略图（网格里用）；不给就是原图（点开放大时用）
    if w:
        try:
            thumb = await asyncio.to_thread(_thumb, full, max(64, min(int(w), 1024)))
            return await stream_file(request, thumb, "image/jpeg")
        except Exception:  # noqa: BLE001 —— 缩不了（格式怪、文件坏）就退回原图，别让格子空着
            pass
    ext = full[full.rfind("."):].lower()
    return await stream_file(request, full, _CONTENT_TYPES.get(ext, "application/octet-stream"))


# ── 照片评级：每人对每只狗那一次问诊评一个档 ─────────────────────────────

@router.get("/{album}/ratings")
async def list_ratings(album: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """这个相册里的评级。管理员看所有人的（对一致性、看实习生评得准不准）；
    其他人（兽医 / 实习生）只看自己的——看得到别人的评级会被带着走，几个人各评各的才有对照价值"""
    _check_album(album, user)
    q = (select(SkinPhotoRating, User.display_name, User.username, User.role, User.permissions)
         .join(User, User.id == SkinPhotoRating.user_id)
         .where(SkinPhotoRating.album == album))
    if user.role not in (UserRole.admin, UserRole.super_admin):
        q = q.where(SkinPhotoRating.user_id == user.id)
    rows = (await db.execute(q)).all()
    return ok([{
        "folder": r.folder, "dog_folder": r.dog_folder, "user_id": r.user_id,
        "user_name": dn or un, "user_role": getattr(role, "value", str(role)),
        "grade": r.grade, "note": r.note, "is_vet": perms.is_vet(pm),
        "updated_at": r.updated_at.isoformat(sep=" ", timespec="minutes") if r.updated_at else None,
    } for r, dn, un, role, pm in rows])


class RatingIn(BaseModel):
    folder: str = Field(..., max_length=200)
    dog_folder: str = Field(..., max_length=200)
    # 不给 / 给 null = 撤销我对这只狗的评级
    grade: str | None = None
    note: str | None = Field(None, max_length=500)


@router.put("/{album}/ratings")
async def put_rating(album: str, body: RatingIn, db: AsyncSession = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """我对这只狗这一次的评级（有就改，没有就新建；grade 为空 = 撤销）"""
    _check_album(album, user)
    if body.grade is not None and body.grade not in GRADES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"grade 只能是 {' / '.join(GRADES)}")
    row = (await db.execute(select(SkinPhotoRating).where(
        SkinPhotoRating.album == album, SkinPhotoRating.folder == body.folder,
        SkinPhotoRating.dog_folder == body.dog_folder, SkinPhotoRating.user_id == user.id))).scalar_one_or_none()
    if body.grade is None:
        if row is not None:
            await db.delete(row)
            await db.commit()
        return ok({"grade": None})
    note = (body.note or "").strip() or None
    if row is None:
        row = SkinPhotoRating(album=album, folder=body.folder, dog_folder=body.dog_folder, user_id=user.id,
                              grade=body.grade, note=note)
        db.add(row)
    else:
        row.grade, row.note = body.grade, note
    await db.commit()
    return ok({"grade": row.grade, "note": row.note})


# ── 单张照片拍摄不合格：标出来，汇总给狗场 ────────────────────────────────

FLAG_REASONS = {
    "blurry": "模糊 / 没对焦",
    "dark": "太暗 / 过曝",
    "no_skin": "没拍到皮肤（只拍到毛 / 整只狗太远）",
    "blocked": "被手 / 东西挡住",
    "far": "离太远，看不清细节",
    "other": "其他",
}


@router.get("/{album}/flags")
async def list_flags(album: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """这个相册里所有被标了拍摄问题的照片（大家共用一份：谁标的都算）"""
    _check_album(album, user)
    rows = (await db.execute(
        select(PhotoFlag, User.display_name, User.username).join(User, User.id == PhotoFlag.user_id)
        .where(PhotoFlag.album == album).order_by(PhotoFlag.folder, PhotoFlag.dog_folder, PhotoFlag.filename))).all()
    return ok({"reasons": FLAG_REASONS, "flags": [{
        "folder": f.folder, "dog_folder": f.dog_folder, "filename": f.filename, "reason": f.reason,
        "reason_text": FLAG_REASONS.get(f.reason, f.reason), "note": f.note, "user_name": dn or un,
        "updated_at": f.updated_at.isoformat(sep=" ", timespec="minutes") if f.updated_at else None,
    } for f, dn, un in rows]})


class FlagIn(BaseModel):
    folder: str = Field(..., max_length=200)
    dog_folder: str = Field(..., max_length=200)
    filename: str = Field(..., max_length=200)
    # 不给 / null = 取消这张的标记
    reason: str | None = None
    note: str | None = Field(None, max_length=300)


@router.put("/{album}/flags")
async def put_flag(album: str, body: FlagIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _check_album(album, user)
    if body.reason is not None and body.reason not in FLAG_REASONS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"reason 只能是 {' / '.join(FLAG_REASONS)}")
    row = (await db.execute(select(PhotoFlag).where(
        PhotoFlag.album == album, PhotoFlag.folder == body.folder, PhotoFlag.dog_folder == body.dog_folder,
        PhotoFlag.filename == body.filename))).scalar_one_or_none()
    if body.reason is None:
        if row is not None:
            await db.delete(row)
            await db.commit()
        return ok({"reason": None})
    note = (body.note or "").strip() or None
    if row is None:
        row = PhotoFlag(album=album, folder=body.folder, dog_folder=body.dog_folder, filename=body.filename,
                        reason=body.reason, note=note, user_id=user.id)
        db.add(row)
    else:
        row.reason, row.note, row.user_id = body.reason, note, user.id
    await db.commit()
    return ok({"reason": row.reason, "note": row.note})
