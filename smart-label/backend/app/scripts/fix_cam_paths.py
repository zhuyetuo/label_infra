"""把已导入样本的视频路数按现在的规则重挂一遍。

    # 先看会改什么，**不写库**
    docker compose exec api python -m app.scripts.fix_cam_paths --date 2026-09-15
    # 确认没问题再写
    docker compose exec api python -m app.scripts.fix_cam_paths --date 2026-09-15 --apply

为什么需要它：导入那边只**补空位和失效路径**，文件还在的那一路一律不碰
（影棚那种多只狗共用一组视频的，碰了只会来回改）。所以规则改了之后，
已经导入的样本不会自动跟上。

这次要修的是：狗场一间一狗一摄像头，但**不是每场六只狗都在**。少一只狗的
那场，那个房间的摄像头没有配对文件，被当成了"公用"挂给当场所有的狗——
于是每只狗都多出一路**空房间**的画面（平台上就是"狗场怎么是 3 路"，
而第二路是一地空地砖）。

判定和挂载都直接调 sample_import_service 里那两个函数，**不另抄一份**：
抄一份的话"修复"算出来的跟导入算出来的迟早不一样，那时候修复本身在改坏。

默认 dry-run。--apply 才写库，而且**只改狗场那种配对站点**的样本。
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import os
import sys

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.sample import Sample
from app.services.sample_import_service import (
    _scan_filesystem,
    cams_for_imu,
    genuinely_shared_cams,
)

_SLOTS = ("video_cam1_path", "video_cam2_path", "video_cam3_path")


def _imu_of(sample_code: str) -> int | None:
    import re

    m = re.search(r"_imu(\d+)$", sample_code)
    return int(m.group(1)) if m else None


async def run(date_filter, apply: bool, limit: int) -> int:
    raw_root = os.path.join(settings.nas_root, settings.data_raw_dir)
    if not os.path.isdir(raw_root):
        print(f"✗ 找不到 {raw_root}")
        return 2

    print("扫 NAS…")
    groups = _scan_filesystem(raw_root, settings.nas_root)
    print(f"  {len(groups)} 个 session\n")

    async with SessionLocal() as db:
        q = select(Sample)
        if date_filter:
            q = q.where(Sample.session_date == date_filter)
        samples = (await db.execute(q.limit(limit))).scalars().all()

        n_seen = n_diff = n_skip = 0
        for sm in samples:
            imu_idx = _imu_of(sm.sample_code)
            session_key = sm.sample_code.rsplit("_imu", 1)[0]
            g = groups.get(session_key)
            if g is None or imu_idx is None:
                n_skip += 1
                continue
            # **只动配对站点**。影棚和旧数据那套共用逻辑一个字没改，
            # 碰它们只会把"同一位置落到哪个文件取决于扫描顺序"那件事
            # 变成来回改
            if not (g.get("paired_site") and (g.get("videos_by_imu") or {})):
                n_skip += 1
                continue
            n_seen += 1

            shared_cams = {c: g["videos"][c] for c in (1, 2, 3) if c in g["videos"]}
            want = cams_for_imu(g, imu_idx, shared_cams, genuinely_shared_cams(g))
            cur = {i: getattr(sm, col) for i, col in enumerate(_SLOTS, 1)
                   if getattr(sm, col)}
            if cur == want:
                continue

            n_diff += 1
            print(f"  {sm.sample_code}   {len(cur)} 路 → {len(want)} 路")
            for slot in (1, 2, 3):
                a, b = cur.get(slot), want.get(slot)
                if a == b:
                    continue
                print(f"      cam{slot}: {os.path.basename(a) if a else '（空）'}")
                print(f"           →  {os.path.basename(b) if b else '（清空）'}")
            if apply:
                for slot, col in enumerate(_SLOTS, 1):
                    setattr(sm, col, want.get(slot))

        if apply and n_diff:
            await db.commit()

    print()
    print(f"配对站点的样本 {n_seen} 个，其中 {n_diff} 个需要改，跳过 {n_skip} 个"
          f"（非配对站点 / 扫不到对应目录）")
    if n_diff and not apply:
        print("\n**没有写库**（dry-run）。确认上面的改动没问题再加 --apply。")
    elif n_diff:
        print("\n已写库。受影响的任务重新打开就会看到正确的视角。")
    else:
        print("\n不用改。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="只修某一天（YYYY-MM-DD）。不传 = 全部")
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只看不改）")
    ap.add_argument("--limit", type=int, default=100000)
    args = ap.parse_args()
    d = dt.date.fromisoformat(args.date) if args.date else None
    return asyncio.run(run(d, args.apply, args.limit))


if __name__ == "__main__":
    sys.exit(main())
