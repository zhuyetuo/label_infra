"""
任务超时回收定时任务。必须只跑一个实例（多实例会重复扫描，虽然UPDATE本身幂等无害，
但没有意义地重复执行），跟 FastAPI 主进程分开部署，独立运行：

    python -m app.workers.scheduler

不要和 uvicorn 的多 worker 混在一起跑（--workers 2 会导致这个模块跑两份）。
"""

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.db.session import SessionLocal
from app.services.reclaim_service import reclaim_expired_reviews, reclaim_expired_tasks

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smart-label.scheduler")


async def _sweep_once() -> None:
    async with SessionLocal() as db:
        annotation_count = await reclaim_expired_tasks(db)
        review_count = await reclaim_expired_reviews(db)
        if annotation_count or review_count:
            logger.info("回收超时任务: 标注%d个, 审核%d个", annotation_count, review_count)


async def main() -> None:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(_sweep_once, "interval", minutes=2, id="reclaim_expired_tasks")
    scheduler.start()
    logger.info("超时回收定时任务已启动，每2分钟扫描一次")
    await asyncio.Event().wait()  # 常驻进程


if __name__ == "__main__":
    asyncio.run(main())
