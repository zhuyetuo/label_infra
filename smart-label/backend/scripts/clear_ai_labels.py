"""
清掉所有 AI 预标注 JSON：删 NAS 上 data_raw/ 和 data_labeled_ai/ 下的 *_ai_label.json
（老位置和新位置都扫），并把 samples.ai_label_path 清空。只碰 *_ai_label.json，
CSV/MP4/人工标注导出都不动。测试完想从头来一遍的时候用。

用法（后端跑在 docker 里，宿主机的 python 没装 asyncmy 等依赖，要在 api 容器里跑）：
    cd smart-label/deploy
    docker compose exec api python -m scripts.clear_ai_labels          # 只列出会删哪些，不动
    python -m scripts.clear_ai_labels --apply  # 真的删
"""

import asyncio
import os
import sys

sys.path.insert(0, ".")

from sqlalchemy import update  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.sample import Sample  # noqa: E402

SUFFIX = "_ai_label.json"


def _find_files() -> list[str]:
    found: list[str] = []
    for sub in (settings.data_raw_dir, settings.ai_label_dir):
        base = os.path.join(settings.nas_root, sub)
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            found.extend(os.path.join(root, f) for f in files if f.endswith(SUFFIX))
    return sorted(found)


async def main(apply: bool) -> None:
    files = _find_files()
    for f in files:
        print(f"{'[删]' if apply else '[将删]'} {f}")
    if apply:
        for f in files:
            os.remove(f)
        # 新位置的空目录顺手清掉，原始数据目录的结构不动
        ai_base = os.path.join(settings.nas_root, settings.ai_label_dir)
        for root, dirs, fs in os.walk(ai_base, topdown=False):
            if root != ai_base and not dirs and not fs:
                os.rmdir(root)
        async with SessionLocal() as db:
            r = await db.execute(update(Sample).where(Sample.ai_label_path.is_not(None)).values(ai_label_path=None))
            await db.commit()
            print(f"samples.ai_label_path 清空 {r.rowcount} 条")
    print(f"{'已删' if apply else '将删'} {len(files)} 个 {SUFFIX}" + ("" if apply else "（加 --apply 才会真的删）"))


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
