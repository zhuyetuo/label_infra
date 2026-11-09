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

export const sysStatus = () => request.get<never, SysStatus>("/system/status", { timeout: 20000 } as never);
/** 终止一条卡住的查询（只给超级管理员） */
export const sysKillQuery = (id: number) => request.post<never, { killed: number }>(`/system/db/kill/${id}`);

export const sysLogs = (p: { file: string; lines: number; q?: string; level?: string; date?: string }) =>
  request.get<never, { file: string; exists: boolean; lines: string[]; dates: string[] }>("/system/logs", {
    params: { ...p, q: p.q || undefined, level: p.level || undefined, date: p.date || undefined },
  });
