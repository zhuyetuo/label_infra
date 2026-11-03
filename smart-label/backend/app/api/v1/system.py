"""系统监控：网页上看服务器资源、数据库、依赖服务和日志，出问题（比如页面一片 timeout）
不用 ssh 上去 tail。只给管理员。

资源读的是 /proc：容器里 /proc/loadavg、/proc/stat、/proc/meminfo 反映的就是宿主机
（docker 不隔离这几个），磁盘按挂进来的目录（NAS 数据根、日志目录）各算一份。
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from collections import deque

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import require_role
from app.db.session import get_db
from app.models.user import UserRole
from app.schemas.envelope import ok

router = APIRouter(
    prefix="/system", tags=["system"],
    dependencies=[Depends(require_role(UserRole.admin, UserRole.super_admin))],
)

LOG_FILES = ("api.log", "access.log", "scheduler.log")
_svc_cache: tuple[float, list[dict]] | None = None


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def _cpu_times() -> tuple[int, int] | None:
    """(总 jiffies, 空闲 jiffies)"""
    line = _read("/proc/stat").split("\n", 1)[0]
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return None
    vals = [int(x) for x in parts[1:]]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return sum(vals), idle


def _meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    for line in _read("/proc/meminfo").splitlines():
        m = re.match(r"(\w+):\s+(\d+)", line)
        if m:
            out[m.group(1)] = int(m.group(2)) * 1024
    return out


def _disk(path: str) -> dict | None:
    try:
        u = shutil.disk_usage(path)
    except OSError:
        return None
    return {"path": path, "total": u.total, "used": u.used, "free": u.free}


async def _probe(url: str) -> dict:
    """依赖服务通不通、多快。随便打个 GET，只看连不连得上，不管状态码"""
    if not url:
        return {"url": "", "ok": None, "ms": None, "error": "没配置"}
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(url.rstrip("/") + "/docs")
        return {"url": url, "ok": r.status_code < 500, "ms": round((time.perf_counter() - t0) * 1000), "error": None}
    except Exception as e:  # noqa: BLE001 —— 连不上就是连不上，原样报给人看
        return {"url": url, "ok": False, "ms": None, "error": f"{type(e).__name__}: {e}"[:200]}


@router.get("/status")
async def get_status(db: AsyncSession = Depends(get_db)):
    # CPU 占用：隔 0.3 秒采两次 /proc/stat
    a = _cpu_times()
    await asyncio.sleep(0.3)
    b = _cpu_times()
    cpu_pct = None
    if a and b and b[0] > a[0]:
        cpu_pct = round(100 * (1 - (b[1] - a[1]) / (b[0] - a[0])), 1)
    load = _read("/proc/loadavg").split()[:3]
    mem = _meminfo()
    up = _read("/proc/uptime").split()

    # 磁盘：同一块盘只报一次
    disks, seen = [], set()
    for p in (settings.nas_root, settings.log_dir, "/"):
        try:
            dev = os.stat(p).st_dev
        except OSError:
            continue
        if dev in seen:
            continue
        seen.add(dev)
        d = _disk(p)
        if d:
            disks.append(d)

    # 后端进程自己占多少内存
    rss = None
    m = re.search(r"VmRSS:\s+(\d+) kB", _read("/proc/self/status"))
    if m:
        rss = int(m.group(1)) * 1024

    # 数据库：连一下多快、连接数、正在跑超过 3 秒的查询（页面卡住时多半是它）
    dbinfo: dict = {"ok": False}
    try:
        t0 = time.perf_counter()
        await db.execute(text("SELECT 1"))
        dbinfo = {"ok": True, "ms": round((time.perf_counter() - t0) * 1000, 1)}
        bind = getattr(db, "bind", None)
        if bind is not None and bind.dialect.name == "mysql":
            r = (await db.execute(text("SHOW STATUS LIKE 'Threads_connected'"))).first()
            dbinfo["connections"] = int(r[1]) if r else None
            # performance_schema.processlist（8.0.22+）；老版本退回 information_schema——后者在新版
            # 每查一次就往日志里打一条 deprecated 警告，5 秒刷一次能把日志刷满
            sql = ("SELECT ID, TIME, STATE, LEFT(INFO, 300) FROM {t} "
                   "WHERE COMMAND <> 'Sleep' AND TIME >= 3 AND INFO IS NOT NULL ORDER BY TIME DESC LIMIT 10")
            try:
                rows = (await db.execute(text(sql.format(t="performance_schema.processlist")))).all()
            except Exception:  # noqa: BLE001
                await db.rollback()
                rows = (await db.execute(text(sql.format(t="information_schema.PROCESSLIST")))).all()
            dbinfo["slow_queries"] = [{"id": r[0], "sec": r[1], "state": r[2], "sql": r[3]} for r in rows]
    except Exception as e:  # noqa: BLE001
        dbinfo = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}

    # 依赖服务 1 分钟探一次就够：页面 5 秒刷一次，每次都探的话 httpx 往日志里每 5 秒打两行
    global _svc_cache
    if _svc_cache is None or time.monotonic() - _svc_cache[0] > 60:
        _svc_cache = (time.monotonic(), await asyncio.gather(
            _probe(settings.algo_service_url),
            _probe(settings.vision_service_url),
        ))
    services = _svc_cache[1]
    return ok({
        "cpu": {"percent": cpu_pct, "count": os.cpu_count(), "load": [float(x) for x in load] if load else None},
        "mem": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable"),
                "swap_total": mem.get("SwapTotal"), "swap_free": mem.get("SwapFree")},
        "disks": disks,
        "uptime_sec": float(up[0]) if up else None,
        "api_rss": rss,
        "db": dbinfo,
        "services": [{"name": "algo_service（训练 / 推理）", **services[0]},
                     {"name": "vision_service（SAM）", **services[1]}],
    })


def _tail(path: str, n: int) -> list[str]:
    """读文件最后 n 行，从末尾往前按块读，大文件也快"""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block, data = 64 * 1024, b""
            while size > 0 and data.count(b"\n") <= n:
                step = min(block, size)
                size -= step
                f.seek(size)
                data = f.read(step) + data
    except OSError:
        return []
    return data.decode("utf-8", errors="replace").splitlines()[-n:]


@router.get("/logs")
async def get_logs(file: str = "api.log", lines: int = 500, q: str | None = None, level: str | None = None,
                   date: str | None = None):
    """看日志最后 N 行。q = 关键字（不分大小写）；level = ERROR / WARNING（含更严重的）；
    date = YYYY-MM-DD 看那天切出去的旧文件（不给就是今天这份）"""
    if file not in LOG_FILES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"只能看 {' / '.join(LOG_FILES)}")
    name = file if not date else f"{file}.{date}"
    if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "date 要是 YYYY-MM-DD")
    path = os.path.join(settings.log_dir, name)
    n = max(1, min(lines, 5000))
    # 有筛选时多读一些再筛，不然最后 500 行里可能一条都没有
    raw = _tail(path, n if not (q or level) else n * 20)
    levels = {"ERROR": ("ERROR", "CRITICAL"), "WARNING": ("WARNING", "ERROR", "CRITICAL")}.get((level or "").upper())
    out: deque[str] = deque(maxlen=n)
    keep_tb = False   # 异常堆栈的后续行（没有时间戳开头）跟着上一条走
    for line in raw:
        head = re.match(r"\d{4}-\d{2}-\d{2} [\d:,]+ (\w+) ", line)
        if head:
            ok_ = (not levels or head.group(1) in levels) and (not q or q.lower() in line.lower())
            keep_tb = ok_
            if ok_:
                out.append(line)
        elif keep_tb or not (q or level):
            out.append(line)
    files = sorted(f for f in os.listdir(settings.log_dir) if f.startswith(file)) if os.path.isdir(settings.log_dir) else []
    dates = sorted({f[len(file) + 1:] for f in files if f != file}, reverse=True)
    return ok({"file": name, "exists": os.path.exists(path), "lines": list(out), "dates": dates})
