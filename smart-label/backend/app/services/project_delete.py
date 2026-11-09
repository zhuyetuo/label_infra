"""删项目放到后台、一小批一小批地删。

原来删一个项目是一个大事务：上百个任务、上万条片段 / 候选一次删完才提交。删的这段时间里
这几张表的相关行一直锁着，别人存草稿、开任务全在等锁；一次删 10 个项目就是 10 个这样的大事务
互相抢锁，页面一起卡死、超时。

现在：点删除立刻返回（项目先停用），后台按每 100 个任务一批删、每批单独提交——每个事务都很短，
别人的操作插得进来；好几个项目排队一个一个删，不同时抢。进度在内存里，项目页轮询。
"""
from __future__ import annotations

import asyncio
import logging
import time

from sqlalchemy import delete, select, update

log = logging.getLogger("project_delete")

BATCH_TASKS = 100
_lock: asyncio.Lock | None = None
PROGRESS: dict[int, dict] = {}
_factory = None   # 测试里换成别的 session 工厂


def _session():
    from app.db.session import SessionLocal

    return (_factory or SessionLocal)()


def progress() -> dict[int, dict]:
    # 删完的留 10 分钟，页面能看到「已删除」；再老的清掉
    now = time.time()
    for pid in [p for p, v in PROGRESS.items() if v.get("finished_at") and now - v["finished_at"] > 600]:
        PROGRESS.pop(pid, None)
    return PROGRESS


async def enqueue(project_id: int, name: str) -> dict:
    """先把项目停用（列表里显示「删除中」，别人别再往里点），再排进后台删除队列"""
    from app.models.project import Project

    cur = PROGRESS.get(project_id)
    if cur and cur["status"] in ("queued", "running"):
        return cur
    async with _session() as db:
        p = await db.get(Project, project_id)
        if p is not None:
            p.is_active = False
            await db.commit()
    PROGRESS[project_id] = {"project_id": project_id, "name": name, "status": "queued", "done": 0, "total": None,
                            "error": None, "queued_at": time.time(), "finished_at": None}
    asyncio.create_task(_run(project_id))
    return PROGRESS[project_id]


async def _run(project_id: int) -> None:
    global _lock
    from app.models.label import LabelDefinition
    from app.models.project import Project
    from app.models.task import Task
    from app.services.task_service import purge_task_children

    st = PROGRESS[project_id]
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:   # 一次只删一个项目
        st["status"] = "running"
        st["started_at"] = time.time()
        try:
            async with _session() as db:
                task_ids = list((await db.execute(select(Task.id).where(Task.project_id == project_id))).scalars())
            st["total"] = len(task_ids)
            for i in range(0, len(task_ids), BATCH_TASKS):
                batch = task_ids[i:i + BATCH_TASKS]
                async with _session() as db:
                    await purge_task_children(db, batch)
                    await db.execute(delete(Task).where(Task.id.in_(batch)))
                    await db.commit()
                st["done"] = min(len(task_ids), i + len(batch))
                await asyncio.sleep(0)   # 让别的请求插进来
            async with _session() as db:
                await db.execute(update(LabelDefinition).where(LabelDefinition.project_id == project_id).values(parent_id=None))
                await db.execute(delete(LabelDefinition).where(LabelDefinition.project_id == project_id))
                p = await db.get(Project, project_id)
                if p is not None:
                    await db.delete(p)
                await db.commit()
            st["status"] = "done"
        except Exception as e:  # noqa: BLE001
            log.exception("删除项目 #%d 失败", project_id)
            st["status"] = "error"
            st["error"] = f"{type(e).__name__}: {e}"[:300]
        finally:
            st["finished_at"] = time.time()
