"""把缺时长的样本重新探一遍（时长 / 帧率 / 分辨率）。

    # 先看有多少、为什么缺，**不写库**
    docker compose exec api python -m app.scripts.backfill_video_probe
    docker compose exec api python -m app.scripts.backfill_video_probe --date 2026-09-15
    # 确认之后再写
    docker compose exec api python -m app.scripts.backfill_video_probe --apply

## 为什么会缺

导入时用 ffprobe 探 cam1。`probe_video` 把所有异常都吞掉返回 None
（超时、文件截断、编码坏了都一样），而样本**照样建**：

    video_duration_sec=probe["duration_sec"] if probe else None

于是那个样本在界面上是 `08:00:14 ~ ?`、总时长 `-`。更麻烦的是
skin_link_service 用 video_duration_sec 算时间跨度，缺了的话那个样本
会**悄悄**从一部分分析里掉出去。

## 这个脚本做什么

对每个缺时长的样本，按 cam1 → cam2 → cam3 的顺序重探，第一个成功的就用它。
（同一次录制各路时长一样；cam1 坏了不代表 cam2 也坏。）

探不出来的**分三种情况分别报**，因为处理方式完全不同：

    文件不在      NAS 上没有这个文件 → 补文件，或者这个样本本来就该删
    ffprobe 失败  文件在但读不出来（截断/编码坏）→ 转码或重采
    没有视频路径  三路全空 → 导入时就有问题

不区分的话，一句"探测失败"会让人对着一个**文件根本不在**的样本反复重试。
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import os
import sys
from collections import Counter

from sqlalchemy import or_, select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.sample import Sample
from app.utils.ffprobe import probe_video

_CAMS = ("video_cam1_path", "video_cam2_path", "video_cam3_path")

#: 探测结果的三类失败，分开报——处理方式完全不同
NO_PATH, MISSING, UNREADABLE, OK = "没有视频路径", "文件不在", "ffprobe 失败", "ok"


def probe_sample(nas_root: str, cam_paths: list[str | None]) -> tuple[str, dict | None, str | None]:
    """按 cam1→cam2→cam3 探，第一个成功的就用它。

    → (结果类别, probe 字典, 用的是哪个文件)

    **纯函数（只读文件系统），跟数据库分开**，好测。
    """
    paths = [p for p in cam_paths if (p or "").strip()]
    if not paths:
        return NO_PATH, None, None
    worst = MISSING
    for rel in paths:
        full = os.path.join(nas_root, rel)
        if not os.path.isfile(full):
            continue
        # 文件在，那至少不是"文件不在"了
        worst = UNREADABLE
        got = probe_video(full)
        if got and got.get("duration_sec"):
            return OK, got, rel
    return worst, None, None


async def run(date_filter, apply: bool, limit: int) -> int:
    async with SessionLocal() as db:
        q = select(Sample).where(
            or_(Sample.video_duration_sec.is_(None), Sample.video_duration_sec <= 0)
        )
        if date_filter:
            q = q.where(Sample.session_date == date_filter)
        samples = (await db.execute(q.limit(limit))).scalars().all()

        if not samples:
            print("没有缺时长的样本。")
            return 0

        print(f"缺时长的样本 {len(samples)} 个，逐个重探…\n")
        tally: Counter[str] = Counter()
        failed: dict[str, list[str]] = {}
        for sm in samples:
            kind, got, used = probe_sample(
                settings.nas_root, [getattr(sm, c) for c in _CAMS])
            tally[kind] += 1
            if kind != OK:
                failed.setdefault(kind, []).append(sm.sample_code)
                continue
            print(f"  ✓ {sm.sample_code}  {got['duration_sec']}s"
                  f"  {got.get('width')}x{got.get('height')}  {got.get('fps')}fps"
                  f"   ← {os.path.basename(used)}")
            if apply:
                sm.video_duration_sec = got["duration_sec"]
                # 帧率/分辨率**只在原来是空的时候补**：原来有值说明那次探测
                # 成功过，别拿另一路的参数去盖（各路机位分辨率可能不同）
                if sm.video_fps is None:
                    sm.video_fps = got.get("fps")
                if not sm.video_resolution and got.get("width"):
                    sm.video_resolution = f"{got['width']}x{got['height']}"

        if apply and tally[OK]:
            await db.commit()

    print()
    print(f"补上 {tally[OK]} 个" + ("（已写库）" if apply and tally[OK] else ""))
    for kind in (MISSING, UNREADABLE, NO_PATH):
        if not tally[kind]:
            continue
        print(f"\n{kind}：{tally[kind]} 个")
        hint = {
            MISSING: "NAS 上没有这个文件——补文件，或者这个样本本来就该删",
            UNREADABLE: "文件在但读不出来（截断 / 编码坏）——转码或重采，重试没用",
            NO_PATH: "三路全空，导入时就有问题——重新扫一次那个目录",
        }[kind]
        print(f"  {hint}")
        for c in failed[kind][:15]:
            print(f"    {c}")
        if len(failed[kind]) > 15:
            print(f"    …… 还有 {len(failed[kind]) - 15} 个")

    if tally[OK] and not apply:
        print("\n**没有写库**（dry-run）。确认之后加 --apply。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="只看某一天（YYYY-MM-DD）。不传 = 全部")
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只看不改）")
    ap.add_argument("--limit", type=int, default=100000)
    args = ap.parse_args()
    d = dt.date.fromisoformat(args.date) if args.date else None
    return asyncio.run(run(d, args.apply, args.limit))


if __name__ == "__main__":
    sys.exit(main())
