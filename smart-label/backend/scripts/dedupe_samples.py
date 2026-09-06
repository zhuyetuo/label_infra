"""
手动清理多 IMU 扫描 bug 留下的重复样本（不带 _imu{N} 后缀、跟带后缀那行指向同一份
CSV 的旧行）。逻辑在 app/services/sample_dedupe_service.py，每次扫描结束也会自动跑
一遍；这个脚本用来先看一眼会怎么处理，或者不想等扫描时手动跑。

用法（后端跑在 docker 里，要在 api 容器里跑）：
    cd smart-label/deploy
    docker compose exec api python -m scripts.dedupe_samples          # 只列出会怎么处理，不动
    docker compose exec api python -m scripts.dedupe_samples --apply  # 真的合并 + 删除
"""

import asyncio
import sys

sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.services.sample_dedupe_service import merge_duplicate_samples  # noqa: E402


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        merged, kept = await merge_duplicate_samples(db, apply=apply)
    print(
        f"\n{'已合并删除' if apply else '将合并删除'} {merged} 个重复样本，{kept} 个因两边都有任务而保留"
        + ("" if apply else "（加 --apply 才会真的动）")
    )


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
