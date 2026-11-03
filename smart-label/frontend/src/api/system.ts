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
  };
  services: { name: string; url: string; ok: boolean | null; ms: number | null; error: string | null }[];
}

export const sysStatus = () => request.get<never, SysStatus>("/system/status");

export const sysLogs = (p: { file: string; lines: number; q?: string; level?: string; date?: string }) =>
  request.get<never, { file: string; exists: boolean; lines: string[]; dates: string[] }>("/system/logs", {
    params: { ...p, q: p.q || undefined, level: p.level || undefined, date: p.date || undefined },
  });
