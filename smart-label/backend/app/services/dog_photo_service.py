"""
狗档案的照片和视频：存在 NAS 上，按狗编号分目录。

放 nas_root 而不是素材库（material_root）：素材库那个共享是**只读**挂载的
（docker-compose 里 `:ro`），传不进去；ai_data 这个本来就要写 AI 结果，是可写的。

目录结构 `<nas_root>/<dog_photo_dir>/<dog_code>/<时间戳>_<原名>`：
  - 按编号分目录，狗改名了照片也不用跟着搬
  - 文件名带上传时间戳，同名照片不会互相覆盖

读取跟素材库一样走「签名 token + 流式返回」：<img>/<video> 带不了 Authorization
头，不签名的话等于把 NAS 上的路径敞开给任何人猜。流式返回本身支持 Range，视频
才能拖进度条。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import time
from datetime import datetime

from app.core.config import settings

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
# 浏览器能直接播的就这几种；.mkv/.avi 收下来也放不了，不如一开始就挡掉，
# 免得传了半天上去发现只能下载
VIDEO_EXTS = {".mp4", ".mov", ".webm"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS
# 照片几 MB 顶天；视频是拍一小段看抓挠动作的，给 500MB
MAX_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 500 * 1024 * 1024
_SAFE = re.compile(r"[^A-Za-z0-9_.\-一-鿿]")


class DogPhotoError(Exception):
    pass


def photos_root() -> str:
    return os.path.join(settings.nas_root, settings.dog_photo_dir)


def dog_dir(dog_code: str) -> str:
    """一只狗的照片目录。编号是要当目录名用的，先挑安全字符。"""
    safe = _SAFE.sub("_", str(dog_code))[:64] or "unknown"
    return os.path.join(photos_root(), safe)


def list_photos(dog_code: str) -> list[dict]:
    """这只狗的照片，新传的在前。"""
    d = dog_dir(dog_code)
    if not os.path.isdir(d):
        return []
    out = []
    for fn in os.listdir(d):
        full = os.path.join(d, fn)
        ext = os.path.splitext(fn)[1].lower()
        if not os.path.isfile(full) or ext not in MEDIA_EXTS:
            continue
        st = os.stat(full)
        out.append(
            {
                "filename": fn,
                "kind": "video" if ext in VIDEO_EXTS else "image",
                "size_bytes": st.st_size,
                "uploaded_at": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "token": issue_token(dog_code, fn),
            }
        )
    out.sort(key=lambda x: x["uploaded_at"], reverse=True)
    return out


def count_photos(dog_codes: list[str]) -> dict[str, int]:
    """档案列表要显示「有几张」。一只狗一次 listdir，不签 token（列表里不显示图）。"""
    out: dict[str, int] = {}
    for code in dog_codes:
        d = dog_dir(code)
        try:
            out[code] = sum(1 for fn in os.listdir(d) if os.path.splitext(fn)[1].lower() in MEDIA_EXTS)
        except OSError:
            out[code] = 0
    return out


def limit_for(ext: str) -> int:
    return MAX_VIDEO_BYTES if ext in VIDEO_EXTS else MAX_BYTES


def prepare_target(dog_code: str, filename: str) -> tuple[str, str, int]:
    """
    校验后缀、建目录、算出落盘文件名。返回 (绝对路径, 文件名, 大小上限)。

    分成 prepare/写两步是因为视频可能几百 MB：不能像以前那样 `await file.read()`
    整个读进内存，得边收边往盘上写。
    """
    ext = os.path.splitext(filename)[1].lower()
    if ext not in MEDIA_EXTS:
        raise DogPhotoError(
            f"只收图片（{'/'.join(sorted(IMAGE_EXTS))}）和视频（{'/'.join(sorted(VIDEO_EXTS))}），"
            f"这个是 {ext or '没有后缀'}"
        )
    d = dog_dir(dog_code)
    os.makedirs(d, exist_ok=True)
    # 时间戳前缀：同名文件不会互相覆盖，列表里也天然按时间排
    name = f"{datetime.now():%Y%m%d_%H%M%S}_{_SAFE.sub('_', os.path.basename(filename))[:80]}"
    return os.path.join(d, name), name, limit_for(ext)


def too_big(nbytes: int, limit: int) -> str:
    return f"文件太大（{nbytes / 1024 / 1024:.0f}MB），最多 {limit // 1024 // 1024}MB"


def save_photo(dog_code: str, filename: str, data: bytes) -> str:
    """整块写。小图还是走这个方便，视频走 prepare_target + 分块写。"""
    full, name, limit = prepare_target(dog_code, filename)
    if len(data) > limit:
        raise DogPhotoError(too_big(len(data), limit))
    with open(full, "wb") as f:
        f.write(data)
    return name


def resolve(dog_code: str, filename: str) -> str:
    """文件名 → 绝对路径。realpath 必须还在这只狗的目录里，挡住 ../ 那一类。"""
    root = os.path.realpath(dog_dir(dog_code))
    full = os.path.realpath(os.path.join(root, os.path.basename(filename)))
    if full != root and not full.startswith(root + os.sep):
        raise DogPhotoError("非法路径")
    if not os.path.isfile(full):
        raise DogPhotoError("文件不存在")
    return full


def delete_photo(dog_code: str, filename: str) -> None:
    os.remove(resolve(dog_code, filename))


def issue_token(dog_code: str, filename: str) -> str:
    expires_at = int(time.time()) + settings.media_token_ttl_hours * 3600
    payload = f"dogphoto:{dog_code}:{filename}:{expires_at}"
    sig = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{expires_at}.{sig}"


def verify_token(dog_code: str, filename: str, token: str) -> bool:
    try:
        expires_at_str, sig = token.split(".", 1)
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    payload = f"dogphoto:{dog_code}:{filename}:{expires_at}"
    expected = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expected, sig)
