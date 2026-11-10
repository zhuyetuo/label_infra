"""评级标准原件（兽医的培训 PPT / PDF）：放在 NAS 上，平台上能点开、能看历史版本、管理员能传新版。

放 NAS 而不是代码里：兽医会改，改了直接放一份新的进去（或者在平台上传），旧的留着当历史版本，
大家看到的永远是同一份。目录：{nas_root}/docs/评级标准/{种类}/，文件名里带上版本或日期，
比如「犬只皮肤状态评估-标注员培训-2026.11.pptx」；按修改时间排，最新的在最前。
"""
from __future__ import annotations

import asyncio
import os
import time

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status

from app.core.config import settings
from app.core.deps import get_current_user, require_role
from app.models.user import User, UserRole
from app.schemas.envelope import ok
from app.services import tooth_service as svc
from app.services.range_stream import stream_file

router = APIRouter(prefix="/standards", tags=["standards"])
stream_router = APIRouter(prefix="/standards", tags=["standards"])

KINDS = {"skin": "皮肤评估"}
EXTS = {".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".ppt": "application/vnd.ms-powerpoint", ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".key": "application/octet-stream"}
MAX_BYTES = 200 * 1024 * 1024


def _dir(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这种评级标准")
    return os.path.join(settings.nas_root, "docs", "评级标准", KINDS[kind])


def _safe_name(name: str) -> str:
    name = os.path.basename(name or "").strip()
    if not name or name.startswith(".") or os.path.splitext(name)[1].lower() not in EXTS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"只收 {' / '.join(EXTS)} 文件")
    return name


def _list(kind: str) -> list[dict]:
    d = _dir(kind)
    if not os.path.isdir(d):
        return []
    out = []
    for fn in os.listdir(d):
        p = os.path.join(d, fn)
        if os.path.isfile(p) and os.path.splitext(fn)[1].lower() in EXTS and not fn.startswith("."):
            st = os.stat(p)
            out.append({"name": fn, "size_bytes": st.st_size,
                        "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime)), "_t": st.st_mtime})
    out.sort(key=lambda x: -x["_t"])
    for x in out:
        x.pop("_t")
    return out


@router.get("/{kind}")
async def list_standards(kind: str, _: User = Depends(get_current_user)):
    """这种标准在 NAS 上有哪些版本，最新的在最前；顺带给每个文件一个下载凭证（链接直接点开）"""
    files = await asyncio.to_thread(_list, kind)
    for f in files:
        f["token"] = svc.issue_photo_token(f["name"], f"std-{kind}")
    return ok({"dir": _dir(kind), "files": files})


@stream_router.get("/{kind}/file")
async def get_standard_file(kind: str, name: str, token: str, request: Request):
    if not svc.verify_photo_token(name, token, f"std-{kind}"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "链接过期了，回页面重新点一次")
    name = _safe_name(name)
    path = os.path.join(_dir(kind), name)
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不在了")
    resp = await stream_file(request, path, EXTS[os.path.splitext(name)[1].lower()])
    # 浏览器里直接下载，文件名用原名（中文要编码）
    from urllib.parse import quote
    resp.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(name)}"
    return resp


_convert_lock = asyncio.Lock()


def _to_pdf(src: str) -> str:
    """PPT → PDF（网页里直接显示）。按 文件名+修改时间+大小 缓存，原件换了自动重转；只转一次"""
    import hashlib
    import shutil
    import subprocess
    import tempfile

    st = os.stat(src)
    key = hashlib.sha1(f"{src}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()
    cache_dir = os.path.join(settings.log_dir, "..", "thumb-cache", "standards")
    out = os.path.join(cache_dir, key + ".pdf")
    if os.path.isfile(out):
        return out
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "服务器上还没装 LibreOffice，网页里看不了 PPT：先下载原件看，或者传一份 PDF 版")
    os.makedirs(cache_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        # 文件名有中文 / 空格，复制成简单名字再转，省得命令行出岔子
        ext = os.path.splitext(src)[1].lower()
        work = os.path.join(tmp, "doc" + ext)
        shutil.copyfile(src, work)
        subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", tmp, work],
                       check=True, timeout=180, capture_output=True,
                       env={**os.environ, "HOME": tmp})          # LibreOffice 要个能写的 HOME 放配置
        shutil.move(os.path.join(tmp, "doc.pdf"), out)
    return out


@stream_router.get("/{kind}/view")
async def view_standard(kind: str, name: str, token: str, request: Request):
    """在网页里直接看：PDF 原样给，PPT 先转成 PDF（第一次要十几秒，之后秒开）"""
    if not svc.verify_photo_token(name, token, f"std-{kind}"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "链接过期了，回页面重新点一次")
    name = _safe_name(name)
    path = os.path.join(_dir(kind), name)
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不在了")
    ext = os.path.splitext(name)[1].lower()
    if ext != ".pdf":
        if ext not in (".pptx", ".ppt", ".docx"):
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "这种文件网页里看不了，请下载")
        async with _convert_lock:
            try:
                path = await asyncio.to_thread(_to_pdf, path)
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"PPT 转 PDF 失败：{type(e).__name__}") from e
    resp = await stream_file(request, path, "application/pdf")
    resp.headers["Content-Disposition"] = "inline"
    return resp


@router.post("/{kind}/upload", dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))])
async def upload_standard(kind: str, file: UploadFile = File(...)):
    """传新版本：同名的不覆盖，自动在文件名后面加日期，旧版本都留着"""
    name = _safe_name(file.filename or "")
    d = _dir(kind)
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "文件太大（最多 200MB）")

    def save() -> str:
        os.makedirs(d, exist_ok=True)
        base, ext = os.path.splitext(name)
        target, n = name, 1
        while os.path.exists(os.path.join(d, target)):
            target = f"{base}-{time.strftime('%Y%m%d-%H%M')}{'' if n == 1 else f'-{n}'}{ext}"
            n += 1
        with open(os.path.join(d, target), "wb") as f:
            f.write(data)
        return target

    saved = await asyncio.to_thread(save)
    # 传完就在后台先转好 PDF（第一次转要半分钟），别人点「对照看原件」时直接就有
    if os.path.splitext(saved)[1].lower() in (".pptx", ".ppt", ".docx"):
        async def warm() -> None:
            try:
                async with _convert_lock:
                    await asyncio.to_thread(_to_pdf, os.path.join(d, saved))
            except Exception:  # noqa: BLE001
                pass
        asyncio.create_task(warm())
    return ok({"name": saved})
