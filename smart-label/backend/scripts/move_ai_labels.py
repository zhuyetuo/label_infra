"""
一次性把以前写在 data_raw/ 里的 *_ai_label.json 挪到 data_labeled_ai/ 下，并更新
samples.ai_label_path。以前 AI 预标注结果跟原始数据混在一个目录，现在分开了
（见 ai_prelabel_service.ai_label_relpath）。可以重复跑，已经挪过的跳过。

用法（后端跑在 docker 里，宿主机的 python 没装 asyncmy 等依赖，要在 api 容器里跑）：
    cd smart-label/deploy
    docker compose exec api python -m scripts.move_ai_labels          # 只打印会怎么挪，不动文件
    docker compose exec api python -m scripts.move_ai_labels --apply  # 真的挪
"""

import asyncio
import os
import shutil
import sys

sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.sample import Sample  # noqa: E402
from app.services.ai_prelabel_service import ai_label_relpath  # noqa: E402


async def main(apply: bool) -> None:
    moved = skipped = missing = 0
    async with SessionLocal() as db:
        samples = (await db.execute(select(Sample).where(Sample.ai_label_path.is_not(None)))).scalars().all()
        for s in samples:
            old_rel = s.ai_label_path
            new_rel = ai_label_relpath(s.imu_csv_path)
            if old_rel == new_rel:
                skipped += 1
                continue
            old_full = os.path.join(settings.nas_root, old_rel)
            new_full = os.path.join(settings.nas_root, new_rel)
            if not os.path.exists(old_full):
                print(f"[缺文件] sample#{s.id} {old_rel} 不存在，只改数据库指向")
                missing += 1
            print(f"{'[挪]' if apply else '[将挪]'} {old_rel} -> {new_rel}")
            if apply:
                if os.path.exists(old_full):
                    os.makedirs(os.path.dirname(new_full), exist_ok=True)
                    shutil.move(old_full, new_full)
                s.ai_label_path = new_rel
            moved += 1
        if apply:
            await db.commit()
    print(f"完成：{'已挪' if apply else '待挪'} {moved}，已在新位置 {skipped}，原文件缺失 {missing}"
          + ("" if apply else "（加 --apply 才会真的动）"))


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
