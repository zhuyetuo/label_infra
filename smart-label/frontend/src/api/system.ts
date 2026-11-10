import request from "@/utils/request";

export interface SysStatus {
  cpu: { percent: number | null; count: number | null; load: number[] | null };
  mem: { total?: number; available?: number; swap_total?: number; swap_free?: number };
  disks: { path: string; total: number; used: number; free: number }[];
  uptime_sec: number | null;
  api_rss: number | null;
  db: {
    ok: boolean;
    ms?: number;
    connections?: number | null;
    slow_queries?: { id: number; sec: number; state: string | null; sql: string | null }[];
    error?: string;
    running?: number;
    lock_waits?: number;
    max_connections?: number;
    buffer_pool_bytes?: number;
    bp_hit?: number;
    pool?: { size: number; checked_out: number; overflow: number };
    lock_wait_list?: { sec: number; waiting: string | null; waiting_id: number; blocking: string | null; blocking_id: number }[];
    /** 等表锁（元数据锁）：改表结构在等一个没结束的事务，后面用这张表的查询全排在它后面 */
    mdl_waits?: { table: string; waiting_id: number; waiting: string | null; sec: number; blocking_id: number; blocking: string | null }[];
    /** 开着超过 10 秒没提交的事务（拿着锁不放的多半是它） */
    long_trx?: { id: number; sec: number; state: string; sql: string | null; rows_locked: number }[];
    /** 每 15 秒一个点，一小时 */
    history?: { ts: number; ok: boolean; ms?: number; running?: number; lock_waits?: number; n_slow?: number; error?: string;
      pool?: { size: number; checked_out: number; overflow: number } }[];
  };
  /** 网页（后端）：最近 5 分钟的请求耗时、事件循环被堵的情况；history 一小时每分钟一个点 */
  web?: {
    window_sec: number; requests: number; p50: number | null; p95: number | null; over_3s: number; errors_5xx: number;
    slowest: { route: string; n: number; p95: number | null; max: number }[];
    loop_lag_now: number | null; loop_lag_max: number | null; loop_blocked_sec: number;
    history: { t: number; p95: number | null; n: number; lag_max: number }[];
    /** 后端手上还没返回的请求（超过 1 秒的），等得最久的在前 */
    inflight?: { sec: number; req: string }[];
    inflight_total?: number;
    /** 后端被堵（>200ms）那几次当时在处理的接口：按次数排，嫌疑最大的在前 */
    lag_suspects?: { route: string; n: number; max_lag: number }[];
  };
  services: { name: string; url: string; ok: boolean | null; ms: number | null; error: string | null }[];
  /** GPU 在视觉服务那台机器上：nvidia-smi 每张卡 + 视觉服务里每个模型常驻显存 */
  gpu?: {
    error?: string;
    why?: string | null;
    gpus?: { index: number; name: string; util_pct: number | null; mem_used_mib: number | null; mem_total_mib: number | null; temp_c: number | null; power_w: number | null }[];
    models?: Record<string, { mib: number | null; device?: string }>;
    torch_reserved_mib?: number | null;
    cached_idle_mib?: number | null;
  };
}

export const sysStatus = () => request.get<never, SysStatus>("/system/status", { timeout: 20000, silent: true } as never);
/** 终止一条卡住的查询（只给超级管理员） */
export const sysKillQuery = (id: number) => request.post<never, { killed: number }>(`/system/db/kill/${id}`);

export const sysLogs = (p: { file: string; lines: number; q?: string; level?: string; date?: string }) =>
  request.get<never, { file: string; exists: boolean; lines: string[]; dates: string[] }>("/system/logs", {
    params: { ...p, q: p.q || undefined, level: p.level || undefined, date: p.date || undefined },
  });
