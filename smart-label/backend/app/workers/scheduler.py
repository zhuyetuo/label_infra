"""
后台定时任务：任务超时回收 + 自动扫描NAS新样本。必须只跑一个实例（多实例会重复扫描，
虽然各自的操作本身是幂等/安全的，但没有意义地重复执行），跟 FastAPI 主进程分开部署，
独立运行：

    python -m app.workers.scheduler

不要和 uvicorn 的多 worker 混在一起跑（--workers 2 会导致这个模块跑两份）。
"""

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User, UserRole
from app.services.reclaim_service import reclaim_expired_reviews, reclaim_expired_tasks
from app.services.sample_import_service import get_progress, run_scan

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("smart-label.scheduler")


async def _sweep_once() -> None:
    async with SessionLocal() as db:
        annotation_count = await reclaim_expired_tasks(db)
        review_count = await reclaim_expired_reviews(db)
        if annotation_count or review_count:
            logger.info("回收超时任务: 标注%d个, 审核%d个", annotation_count, review_count)


async def _auto_scan_samples() -> None:
    async with SessionLocal() as db:
        admin = (
            await db.execute(select(User).where(User.role == UserRole.admin).order_by(User.id).limit(1))
        ).scalar_one_or_none()
    if admin is None:
        logger.warning("自动扫描跳过：还没有任何管理员账号，无法归属created_by")
        return

    await run_scan(settings.nas_root, admin.id)
    p = get_progress()
    if p.status == "error":
        logger.error("自动扫描失败: %s", p.error_message)
    elif p.created:
        logger.info(
            "自动扫描完成: 新增%d个样本（其中verified=%d, error=%d），跳过已存在%d个",
            p.created, p.verified, p.errors, p.skipped_existing,
        )


async def main() -> None:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(_sweep_once, "interval", minutes=2, id="reclaim_expired_tasks")
    scheduler.add_job(_auto_scan_samples, "interval", minutes=10, id="auto_scan_samples")
    scheduler.start()
    logger.info("定时任务已启动：超时回收(每2分钟) + NAS样本自动扫描(每10分钟)")
    await asyncio.Event().wait()  # 常驻进程


if __name__ == "__main__":
    asyncio.run(main())
