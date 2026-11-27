"""
后台定时任务：任务超时回收 + 自动扫描NAS新样本。必须只跑一个实例（多实例会重复扫描，
虽然各自的操作本身是幂等/安全的，但没有意义地重复执行），跟 FastAPI 主进程分开部署，
独立运行：

    python -m app.workers.scheduler

不要和 uvicorn 的多 worker 混在一起跑（--workers 2 会导致这个模块跑两份）。
"""

import asyncio
import logging
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User, UserRole
from app.services.reclaim_service import reclaim_expired_reviews, reclaim_expired_tasks
from app.services.sample_import_service import get_progress, run_scan

from app.core.logging_setup import setup_logging  # noqa: E402

setup_logging("scheduler")
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
            await db.execute(
                select(User)
                .where(User.role.in_((UserRole.admin, UserRole.super_admin)))
                .order_by(User.id)
                .limit(1)
            )
        ).scalar_one_or_none()
    if admin is None:
        logger.warning("自动扫描跳过：还没有任何管理员账号，无法归属created_by")
        return

    await run_scan(settings.nas_root, admin.id)
    p = get_progress()
    if p.status == "error":
        logger.error("自动扫描失败: %s", p.error_message)
    else:
        logger.info(
            "自动扫描完成: 新增%d个样本（其中verified=%d, error=%d），跳过已存在%d个",
            p.created, p.verified, p.errors, p.skipped_existing,
        )


async def _collect_local_model_stats() -> None:
    """算法机上本地模型的调用计数在它进程内存里，拉一次快照按小时记差值（调用统计页按天看）。"""
    from app.services import local_model_stats_service as lms

    try:
        async with SessionLocal() as db:
            r = await lms.collect(db)
        if r.get("skipped"):
            logger.debug("本地模型计数采集跳过：%s", r["skipped"])
    except Exception:  # noqa: BLE001 定时任务不能因为这个挂掉
        logger.exception("本地模型计数采集失败")


async def _daily_smart_clean_scan() -> None:
    """每日自动检测所有启用项目需要智能挖洞 / 去重 / 合并的片段数，供前端顶部提示。"""
    from app.services import smart_clean_service as scs

    try:
        async with SessionLocal() as db:
            rep = await scs.scan_all_projects(db)
        logger.info(
            "每日智能检测完成: %d/%d 个项目、%d 个任务待清理（挖洞 %d / 去重 %d / 合并 %d）",
            rep["projects_need_clean"], rep["projects_total"], rep["tasks_need_clean"],
            rep["n_carve"], rep["n_dedupe"], rep["n_merge"],
        )
    except Exception:  # noqa: BLE001
        logger.exception("每日智能检测失败")


async def _warm_zero_signal_cache() -> None:
    """后台静默补全无信号 CSV 磁盘缓存（单遍 C 引擎读取，扫过一次永久复用，每天只补新增）。"""
    from app.services import smart_clean_service as scs

    try:
        r = await scs.warm_zero_signal_cache(max_workers=8)
        logger.info(
            "无信号 CSV 缓存完成: 共 %d 份，本次新扫 %d 份，耗时 %.1fs",
            r["total"], r["scanned"], r["sec"],
        )
    except Exception:  # noqa: BLE001
        logger.exception("无信号 CSV 缓存补全失败")


async def main() -> None:
    scheduler = AsyncIOScheduler()
    scheduler.add_job(_collect_local_model_stats, "interval", minutes=5, id="local_model_stats", next_run_time=datetime.now())
    scheduler.add_job(_sweep_once, "interval", minutes=2, id="reclaim_expired_tasks")
    # 启动后立刻扫一次，不用等 10 分钟；之后每 10 分钟一次
    scheduler.add_job(_auto_scan_samples, "interval", minutes=10, id="auto_scan_samples", next_run_time=datetime.now())
    # 每天凌晨 03:00 自动检测一次全量项目，启动时也顺手检测一次保证立即可见
    scheduler.add_job(_daily_smart_clean_scan, "cron", hour=3, minute=0, id="daily_smart_clean_scan", next_run_time=datetime.now())
    # 每天凌晨 03:10（及启动后后台静默）补全无信号 CSV 缓存，不卡前台一键智能处理
    scheduler.add_job(_warm_zero_signal_cache, "cron", hour=3, minute=10, id="warm_zero_signal_cache", next_run_time=datetime.now())
    scheduler.start()
    logger.info("定时任务已启动：超时回收(每2分钟) + NAS样本自动扫描(每10分钟) + 本地模型计数采集(每5分钟) + 每日智能清理检测(03:00) + 无信号CSV缓存(03:10)")
    await asyncio.Event().wait()  # 常驻进程


if __name__ == "__main__":
    asyncio.run(main())
