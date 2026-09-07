"""
牙齿识别：素材库 NAS 上的口腔照片目录浏览 + 调 imu_train/label_service 的 YOLO 检测。

目录约定（material_root/oral_dir 下）：
    2026-09-02-ok/            日期目录，后缀 -ok 表示这天的照片已整理好
    ├── Bali/                 狗名目录
    │   ├── 微信图片_xxx.jpg
    └── 杜小满-马尔济斯/
照片只读不写；检测结果落 tooth_photo_results 表。图片给浏览器看走
/tooth/photos/stream?path=&token=，token 是按路径签的短期 HMAC（跟 media token
一个思路，只是绑定路径而不是 media_files.id——这批照片不是样本，不进 media_files）。
"""

import hashlib
import hmac
import json
import os
import re
import time

import httpx

from app.core.config import settings

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(-.*)?$")


class ToothError(Exception):
    pass


def oral_root() -> str:
    return os.path.join(settings.material_root, settings.oral_dir)


def resolve_photo(rel_path: str) -> str:
    """相对 oral_dir 的路径 → 绝对路径，realpath 必须仍在 oral_root 之内"""
    root = os.path.realpath(oral_root())
    full = os.path.realpath(os.path.join(root, rel_path))
    if full != root and not full.startswith(root + os.sep):
        raise ToothError("非法路径")
    if not os.path.isfile(full):
        raise ToothError(f"文件不存在: {rel_path}")
    return full


def list_photos() -> list[dict]:
    """扫 oral_root 两层目录（日期/狗），返回 [{folder, date, ok, dogs:[{name, photos:[{rel_path, filename, size_bytes}]}]}]，
    日期倒序。几百张图几十个目录，每次现扫就行，不缓存。"""
    root = oral_root()
    if not os.path.isdir(root):
        raise ToothError(f"口腔照片目录不存在: {root}（素材库 NAS 还没挂载？）")
    out = []
    for folder in sorted(os.listdir(root), reverse=True):
        fpath = os.path.join(root, folder)
        if not os.path.isdir(fpath):
            continue
        m = _DATE_RE.match(folder)
        dogs = []
        for dog in sorted(os.listdir(fpath)):
            dpath = os.path.join(fpath, dog)
            if not os.path.isdir(dpath):
                continue
            photos = []
            for fn in sorted(os.listdir(dpath)):
                if os.path.splitext(fn)[1].lower() not in IMAGE_EXTS:
                    continue
                p = os.path.join(dpath, fn)
                photos.append({"rel_path": f"{folder}/{dog}/{fn}", "filename": fn, "size_bytes": os.path.getsize(p)})
            if photos:
                dogs.append({"name": dog, "photos": photos})
        if dogs:
            out.append({"folder": folder, "date": m.group(1) if m else None, "ok": folder.endswith("-ok"), "dogs": dogs})
    return out


# ── 路径签名 token ──────────────────────────────────────────────────────

def issue_photo_token(rel_path: str) -> str:
    expires_at = int(time.time()) + settings.media_token_ttl_hours * 3600
    payload = f"tooth:{rel_path}:{expires_at}"
    sig = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{expires_at}.{sig}"


def verify_photo_token(rel_path: str, token: str) -> bool:
    try:
        expires_at_str, sig = token.split(".", 1)
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    payload = f"tooth:{rel_path}:{expires_at}"
    expected = hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expected, sig)


# ── 调 label_service 检测 ─────────────────────────────────────────────

async def detect_remote(rel_path: str, conf: float | None, with_image: bool) -> dict:
    """label_service 的 MATERIAL_ROOT 跟这边 material_root 是同一目录，它要的 path 是
    相对 MATERIAL_ROOT 的，所以前面拼上 oral_dir。"""
    url = f"{settings.algo_service_url.rstrip('/')}/api/v1/tooth/detect"
    payload = {"path": f"{settings.oral_dir}/{rel_path}", "conf": conf, "with_image": with_image}
    try:
        async with httpx.AsyncClient(timeout=settings.algo_infer_timeout_sec) as client:
            resp = await client.post(url, json=payload)
    except httpx.RequestError as e:
        raise ToothError(f"无法连接 AI 服务 ({url}): {e}") from e
    if resp.status_code == 503:
        raise ToothError("AI 服务没有牙齿模型权重（label_service 的 TOOTH_WEIGHTS），先训练或配置权重")
    if resp.status_code != 200:
        raise ToothError(f"AI 服务返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def summarize(detections: list[dict]) -> tuple[str | None, float | None]:
    if not detections:
        return None, None
    top = max(detections, key=lambda d: d["confidence"])
    return top["class_name"], float(top["confidence"])


def result_to_dict(r) -> dict:
    return {
        "rel_path": r.rel_path, "folder": r.folder, "dog_folder": r.dog_folder, "dog_id": r.dog_id,
        "detections": json.loads(r.detections or "[]"), "n_detections": r.n_detections,
        "top_class": r.top_class, "top_conf": r.top_conf, "model_conf": r.model_conf,
        "width": r.width, "height": r.height, "detected_at": r.detected_at.isoformat() if r.detected_at else None,
    }
