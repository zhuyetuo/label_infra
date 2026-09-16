"""把历史推理结果的「每类总时长」补进 sample_inference_runs。

    docker compose exec api python -m app.scripts.backfill_label_seconds
    docker compose exec api python -m app.scripts.backfill_label_seconds --dry-run

`label_seconds` 是后加的列，只有新跑的结果才有。不补的话「日常统计」页面
**每一行都是「时长未记」**——功能在，但一个数都看不到。

我最初的判断是"历史不回填"，理由是要把 NAS 上几万个 JSON 重读一遍。
那个判断是错的：这是**一次性**的几分钟，而代价是页面一直没用。

只补缺的那些行（label_seconds 是 NULL），所以可以重复跑；
中途断了再跑一次接着补。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.inference_run import SampleInferenceRun
from app.services.ai_prelabel_service import _label_seconds


def _read(relpath: str) -> dict | None:
    """读 NAS 上那份结果 JSON。

    读不到就**跳过这一行，不写空字典**——写空的话那一行会变成
    "有时长数据，全是 0"，比"时长未记"更糟：前者看着像真的。
    """
    p = os.path.join(settings.nas_root, relpath)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


async def run(dry: bool, limit: int) -> int:
    async with SessionLocal() as db:
        rows = (await db.execute(
            select(SampleInferenceRun)
            .where(SampleInferenceRun.label_seconds.is_(None))
            .limit(limit)
        )).scalars().all()

        print(f"待补 {len(rows)} 行（只查 label_seconds 为空的）")
        done = miss = 0
        for i, r in enumerate(rows, 1):
            data = _read(r.json_path)
            if data is None:
                miss += 1
                continue
            secs = _label_seconds(data.get("segments") or {})
            if not dry:
                r.label_seconds = json.dumps(secs, ensure_ascii=False)
            done += 1
            if i % 500 == 0:
                if not dry:
                    await db.commit()
                print(f"  {i}/{len(rows)}  已补 {done}，读不到 {miss}")
        if not dry:
            await db.commit()

        print(f"\n补完：{done} 行，读不到 JSON 的 {miss} 行"
              + ("（--dry-run，没写库）" if dry else ""))
        if miss:
            # **说出来**。读不到的那些行会继续显示"时长未记"，
            # 不说的话人会以为补过了却还有一堆空的，去查一个不存在的 bug
            print(f"读不到的那 {miss} 行会继续显示「时长未记」——"
                  f"多半是 NAS 上那份 JSON 被清理了。重跑一次那天的预标注才会有。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="只看能补多少，不写库")
    ap.add_argument("--limit", type=int, default=200000)
    args = ap.parse_args()
    return asyncio.run(run(args.dry_run, args.limit))


if __name__ == "__main__":
    sys.exit(main())
