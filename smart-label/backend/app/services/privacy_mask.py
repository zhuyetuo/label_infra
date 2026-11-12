"""
隐私遮罩：项目开了之后，除超级管理员外的人只拿得到「狗框以外全黑」的视频。

遮罩视频由 vision_service 生成（imu_train/vision_service/privacy_mask.py），放在同一个
NAS 根下的 _privacy_mask/<原相对路径>，旁边一个同名 .json 说明（ok、原视频大小和修改时间）。

── 规矩：一道关，所有出画面的地方都过它 ──────────────────────────────────

只在页面上盖黑等于没做（浏览器拿到的还是原视频）。所以判断放在服务端，凡是会把
画面给出去的接口——视频流、夜视、以图搜图的预览 / 缩略图、划区域取帧——一律先过
pick_video：

  - 超级管理员：原版（想看遮罩效果可以显式要遮罩版）
  - 其他人：这份视频所在的任何一个项目开了遮罩 → 只给遮罩版；遮罩版还没做好 → 403，
    **不退回原版**。宁可看不了，也不能漏。

一份视频可能同时挂在好几个项目里：只要有一个项目开了遮罩，就按开了算。

── 缓存 ─────────────────────────────────────────────────────────────

视频是按 Range 一小段一小段取的，一个视频几百个请求，每个都查库 + 读 json 太浪费。
「要不要遮」「遮罩版好没好」各缓存 20 秒；开关一动就整个清掉。
"""

from __future__ import annotations

import json
import os
import time

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task
from app.models.user import User, UserRole
from app.services.media_resolver import PathTraversalError, resolve_nas_path

MASK_DIR = os.environ.get("PRIVACY_MASK_DIR", "_privacy_mask").strip("/") or "_privacy_mask"
_TTL = 20.0

_required_cache: dict[str, tuple[float, bool]] = {}
_ready_cache: dict[str, tuple[float, bool]] = {}


def clear_cache() -> None:
    _required_cache.clear()
    _ready_cache.clear()


def exempt(user: User | None) -> bool:
    """只有超级管理员能看原版。"""
    return user is not None and user.role == UserRole.super_admin


def masked_rel(rel_path: str) -> str:
    return f"{MASK_DIR}/{rel_path.lstrip('/')}"


def sample_video_paths(sample: Sample) -> list[str]:
    return [p for p in (sample.video_cam1_path, sample.video_cam2_path, sample.video_cam3_path) if (p or "").strip()]


def masked_ready(rel_path: str) -> bool:
    """遮罩版做好了没有：说明 ok、遮罩文件在、原视频没变过（大小 / 修改时间对得上）。"""
    now = time.monotonic()
    hit = _ready_cache.get(rel_path)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    ok = False
    try:
        src = resolve_nas_path(rel_path)
        dst = resolve_nas_path(masked_rel(rel_path))
        with open(dst + ".json", encoding="utf-8") as f:
            info = json.load(f)
        st = os.stat(src)
        ok = bool(info.get("ok")) and os.path.isfile(dst) and info.get("src") == {
            "size": st.st_size, "mtime": int(st.st_mtime)}
    except (OSError, ValueError, PathTraversalError, json.JSONDecodeError):
        ok = False
    _ready_cache[rel_path] = (now, ok)
    return ok


async def path_requires_mask(db: AsyncSession, rel_path: str) -> bool:
    """这份视频有没有挂在任何一个开了遮罩的项目里。不是样本视频（比如 IMU CSV）→ False。"""
    now = time.monotonic()
    hit = _required_cache.get(rel_path)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    q = (
        select(Task.id)
        .join(Project, Project.id == Task.project_id)
        .join(Sample, Sample.id == Task.sample_id)
        .where(Project.privacy_mask.is_(True))
        .where(or_(Sample.video_cam1_path == rel_path, Sample.video_cam2_path == rel_path,
                   Sample.video_cam3_path == rel_path))
        .limit(1)
    )
    req = (await db.execute(q)).scalar_one_or_none() is not None
    _required_cache[rel_path] = (now, req)
    return req


async def pick_video(db: AsyncSession, user: User | None, rel_path: str, *, exempt_user: bool | None = None,
                     prefer_mask: bool = False) -> str:
    """该给这个人哪一份视频（相对 NAS 根的路径）。要遮却没做好 → 403。

    exempt_user：接口本身拿不到 user（<img>/<video> 走 token 的那几个）时，由 token 里
    带的身份决定，从这里传进来。prefer_mask：超级管理员想看看遮罩效果。"""
    is_exempt = exempt(user) if exempt_user is None else exempt_user
    if is_exempt and not prefer_mask:
        return rel_path
    required = await path_requires_mask(db, rel_path)
    if required or prefer_mask:
        if masked_ready(rel_path):
            return masked_rel(rel_path)
        if required and not is_exempt:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "这个项目开了隐私遮罩，这段视频的遮罩还没处理好，暂时看不了。请联系超级管理员处理")
    return rel_path
