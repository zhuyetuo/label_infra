"""系统监控用的运行时采样：网页卡不卡、数据库卡不卡。

为什么不能只看 CPU：页面卡住的时候 CPU 往往很闲——卡的是
  · 数据库：查询在等锁（一个长事务锁着表，后面全排队）、连接池被占满（新请求拿不到连接，干等）；
  · 后端事件循环：某个接口在 async 函数里做了同步的重活（读大文件、算特征），整个 web 进程
    在这段时间里一个请求都处理不了，所有页面一起转圈。
这几样都在这里持续采样，留最近一小时，卡过之后回头也能看出卡在哪。

  · 请求耗时：每个接口一条（中间件记），算 p50 / p95 / 最慢的接口
  · 事件循环延迟：每秒睡 0.5 秒，看实际睡了多久——多出来的就是被堵住的时间
  · 数据库：每 15 秒一次（带超时，库卡死了也不会把采样器拖住）：ping、正在跑的查询数、
    等锁的行数、超过 3 秒的查询数、连接池用了多少
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque

log = logging.getLogger("perf")

REQS: deque = deque(maxlen=30000)          # (ts, method route, ms, status)
LOOP_LAG: deque = deque(maxlen=3600)       # (ts, lag_ms)  每秒一个
DB_HIST: deque = deque(maxlen=240)         # 每 15 秒一个 dict，一小时
_tasks: list[asyncio.Task] = []

# 正在处理的请求：{id: (开始时间, "GET /api/v1/xxx")}。页面卡住时看「谁卡了多久、卡在哪个接口」
INFLIGHT: dict[int, tuple[float, str]] = {}
_next_id = 0


def inflight_start(method: str, path: str) -> int:
    global _next_id
    _next_id += 1
    INFLIGHT[_next_id] = (time.time(), f"{method} {path}")
    return _next_id


def inflight_end(rid: int) -> None:
    INFLIGHT.pop(rid, None)


def inflight_list(min_sec: float = 1.0) -> list[dict]:
    now = time.time()
    out = [{"sec": round(now - t0, 1), "req": what} for t0, what in INFLIGHT.values()
           if now - t0 >= min_sec and not what.endswith("/system/status")]
    return sorted(out, key=lambda x: -x["sec"])[:30]


# 监控专用的数据库连接：不走业务连接池。连接池被卡住的请求占满时，业务请求拿不到连接，
# 监控如果也用那个池子就跟着一起卡、什么都看不到——偏偏那时候最需要看
_mon_engine = None


def _monitor_session():
    global _mon_engine
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import settings
    if _mon_engine is None:
        args = {"connect_timeout": 3} if settings.mysql_dsn.startswith("mysql") else {}
        _mon_engine = create_async_engine(settings.mysql_dsn, poolclass=NullPool, connect_args=args)
    return async_sessionmaker(_mon_engine, expire_on_commit=False)()


def record_request(method: str, route: str, ms: float, status: int) -> None:
    REQS.append((time.time(), f"{method} {route}", ms, status))


async def _loop_lag() -> None:
    while True:
        t0 = time.perf_counter()
        await asyncio.sleep(0.5)
        lag = (time.perf_counter() - t0 - 0.5) * 1000
        LOOP_LAG.append((time.time(), max(0.0, lag)))
        await asyncio.sleep(0.5)


async def db_snapshot(timeout: float = 3.0, session_factory=None) -> dict:
    """数据库现在怎么样。整个过程有超时：库卡死 / 连接池拿不到连接时返回 ok=False，不会一直挂着"""
    from sqlalchemy import text

    from app.db.session import engine

    pool = engine.pool
    out: dict = {"ts": time.time(), "ok": False}
    try:
        out["pool"] = {"size": pool.size(), "checked_out": pool.checkedout(), "overflow": max(0, pool.overflow())}
    except Exception:  # noqa: BLE001
        pass

    async def go() -> None:
        async with (session_factory() if session_factory else _monitor_session()) as db:
            t0 = time.perf_counter()
            await db.execute(text("SELECT 1"))
            out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            out["ok"] = True
            if db.bind.dialect.name != "mysql":
                return
            st = {r[0]: r[1] for r in (await db.execute(text(
                "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running',"
                "'Innodb_row_lock_current_waits','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads',"
                "'Slow_queries','Innodb_row_lock_time_avg')"))).all()}
            out["connections"] = int(st.get("Threads_connected", 0))
            out["running"] = int(st.get("Threads_running", 0))
            out["lock_waits"] = int(st.get("Innodb_row_lock_current_waits", 0))
            out["slow_total"] = int(st.get("Slow_queries", 0))
            rr, rd = int(st.get("Innodb_buffer_pool_read_requests", 0)), int(st.get("Innodb_buffer_pool_reads", 0))
            out["_bp"] = (rr, rd)
            var = {r[0]: r[1] for r in (await db.execute(text(
                "SHOW VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','max_connections')"))).all()}
            out["buffer_pool_bytes"] = int(var.get("innodb_buffer_pool_size", 0))
            out["max_connections"] = int(var.get("max_connections", 0))
            sql = ("SELECT ID, TIME, STATE, LEFT(INFO, 400) FROM {t} "
                   "WHERE COMMAND <> 'Sleep' AND TIME >= 3 AND INFO IS NOT NULL ORDER BY TIME DESC LIMIT 10")
            try:
                rows = (await db.execute(text(sql.format(t="performance_schema.processlist")))).all()
            except Exception:  # noqa: BLE001
                await db.rollback()
                rows = (await db.execute(text(sql.format(t="information_schema.PROCESSLIST")))).all()
            out["slow_queries"] = [{"id": r[0], "sec": r[1], "state": r[2], "sql": r[3]} for r in rows]
            # 谁在等谁的锁（要 performance_schema 权限；没有就算了）
            try:
                lw = (await db.execute(text(
                    "SELECT wait_age_secs, LEFT(waiting_query, 300), waiting_pid, LEFT(blocking_query, 300), blocking_pid "
                    "FROM sys.innodb_lock_waits ORDER BY wait_age_secs DESC LIMIT 5"))).all()
                out["lock_wait_list"] = [{"sec": int(r[0] or 0), "waiting": r[1], "waiting_id": r[2],
                                          "blocking": r[3], "blocking_id": r[4]} for r in lw]
            except Exception:  # noqa: BLE001
                await db.rollback()
            # 等表锁（元数据锁 MDL）的：ALTER TABLE / 改表结构在等一个没结束的事务，后面所有用这张表的
            # 查询又排在它后面——全站一起卡死，CPU 却很闲。InnoDB 行锁那张表里看不到这种，单独查
            try:
                mdl = (await db.execute(text(
                    "SELECT object_name, waiting_pid, LEFT(waiting_query, 300), waiting_query_secs, "
                    "blocking_pid, LEFT(blocking_query, 300) FROM sys.schema_table_lock_waits "
                    "ORDER BY waiting_query_secs DESC LIMIT 10"))).all()
                out["mdl_waits"] = [{"table": r[0], "waiting_id": r[1], "waiting": r[2], "sec": int(r[3] or 0),
                                     "blocking_id": r[4], "blocking": r[5]} for r in mdl]
            except Exception:  # noqa: BLE001
                await db.rollback()
            # 开着没提交的事务（拿着锁不放的多半是它）：跑了多久、哪个连接
            try:
                trx = (await db.execute(text(
                    "SELECT trx_mysql_thread_id, TIMESTAMPDIFF(SECOND, trx_started, NOW()), trx_state, "
                    "LEFT(trx_query, 300), trx_rows_locked FROM information_schema.innodb_trx "
                    "WHERE trx_started < NOW() - INTERVAL 10 SECOND ORDER BY trx_started LIMIT 10"))).all()
                out["long_trx"] = [{"id": r[0], "sec": int(r[1] or 0), "state": r[2], "sql": r[3],
                                    "rows_locked": int(r[4] or 0)} for r in trx]
            except Exception:  # noqa: BLE001
                await db.rollback()

    try:
        await asyncio.wait_for(go(), timeout)
    except asyncio.TimeoutError:
        out["error"] = f"数据库 {timeout:g} 秒没回应（在等锁 / 连接池被占满 / 库本身卡住）"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    return out


_last_bp: tuple[int, int] | None = None


def _hit_rate(snap: dict) -> None:
    """缓冲池命中率：两次采样之间读了多少页、其中多少要去磁盘读"""
    global _last_bp
    bp = snap.pop("_bp", None)
    if bp and _last_bp:
        dr, dd = bp[0] - _last_bp[0], bp[1] - _last_bp[1]
        if dr > 0:
            snap["bp_hit"] = round(100 * (1 - dd / dr), 2)
    if bp:
        _last_bp = bp


def _watchdog(snap: dict) -> None:
    """卡住的时候往 api.log 写一笔（搜 STUCK）：谁在等、等了多久、谁拿着锁。
    不写的话，卡完恢复了就什么都查不到了"""
    stuck = inflight_list(30)
    problems = []
    if not snap.get("ok"):
        problems.append(f"数据库没回应：{snap.get('error')}")
    if snap.get("mdl_waits"):
        problems.append(f"等表锁：{snap['mdl_waits'][:3]}")
    if snap.get("lock_wait_list"):
        problems.append(f"等行锁：{snap['lock_wait_list'][:3]}")
    if snap.get("long_trx") and any(t["sec"] > 60 for t in snap["long_trx"]):
        problems.append(f"长事务：{snap['long_trx'][:3]}")
    if stuck:
        problems.append(f"超过 30 秒还没返回的请求 {len(stuck)} 个：{stuck[:5]}")
    pool = snap.get("pool") or {}
    if pool and pool.get("checked_out", 0) >= pool.get("size", 1) + 20:
        problems.append(f"连接池快满了：{pool}")
    if problems:
        log.warning("STUCK %s", " | ".join(problems))


async def _db_sampler() -> None:
    await asyncio.sleep(5)
    while True:
        try:
            snap = await db_snapshot(5.0)
            _watchdog(snap)
            _hit_rate(snap)
            snap["n_slow"] = len(snap.pop("slow_queries", []) or [])
            snap.pop("lock_wait_list", None)
            snap.pop("mdl_waits", None)
            snap.pop("long_trx", None)
            DB_HIST.append(snap)
        except Exception:  # noqa: BLE001
            log.exception("数据库采样失败")
        await asyncio.sleep(15)


def start() -> None:
    if _tasks:
        return
    _tasks.append(asyncio.create_task(_loop_lag()))
    _tasks.append(asyncio.create_task(_db_sampler()))


async def stop() -> None:
    for t in _tasks:
        t.cancel()
    _tasks.clear()


def _pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 1)


def web_summary(window_sec: int = 300) -> dict:
    """最近几分钟：请求数、p50 / p95、超过 3 秒的请求数、最慢的几个接口；事件循环被堵的情况；一小时的分钟级曲线"""
    now = time.time()
    recent = [r for r in REQS if now - r[0] <= window_sec and not r[1].endswith("/system/status")]
    by: dict[str, list[float]] = {}
    for _, k, ms, _s in recent:
        by.setdefault(k, []).append(ms)
    slowest = sorted(({"route": k, "n": len(v), "p95": _pct(v, 0.95), "max": round(max(v), 1)} for k, v in by.items()),
                     key=lambda x: -(x["p95"] or 0))[:8]
    lag_recent = [lag for ts, lag in LOOP_LAG if now - ts <= window_sec]
    # 一小时、每分钟一个点：请求 p95、最大循环延迟
    per_min: dict[int, dict] = {}
    for ts, k, ms, _s in REQS:
        if now - ts > 3600 or k.endswith("/system/status"):
            continue
        per_min.setdefault(int(ts // 60), {"ms": [], "lag": 0.0})["ms"].append(ms)
    for ts, lag in LOOP_LAG:
        if now - ts <= 3600:
            per_min.setdefault(int(ts // 60), {"ms": [], "lag": 0.0})
            per_min[int(ts // 60)]["lag"] = max(per_min[int(ts // 60)]["lag"], lag)
    hist = [{"t": m * 60, "p95": _pct(v["ms"], 0.95), "n": len(v["ms"]), "lag_max": round(v["lag"], 1)}
            for m, v in sorted(per_min.items())]
    ms_all = [r[2] for r in recent]
    return {
        "window_sec": window_sec,
        "requests": len(recent),
        "p50": _pct(ms_all, 0.5), "p95": _pct(ms_all, 0.95),
        "over_3s": sum(1 for x in ms_all if x >= 3000),
        "errors_5xx": sum(1 for r in recent if r[3] >= 500),
        "slowest": slowest,
        "loop_lag_now": round(LOOP_LAG[-1][1], 1) if LOOP_LAG else None,
        "loop_lag_max": round(max(lag_recent), 1) if lag_recent else None,
        "loop_blocked_sec": round(sum(x for x in lag_recent if x > 200) / 1000, 1),
        "history": hist,
    }


def db_history() -> list[dict]:
    return list(DB_HIST)
