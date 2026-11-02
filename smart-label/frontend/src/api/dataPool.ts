import request from "@/utils/request";

/** 数据池：人认可的高质量片段库。审核通过的自动在池里，另外能整批手动加入 / 移出 */
export interface PoolBucket {
  name: string;
  n: number;
  hours: number;
}
export interface PoolSummary {
  n: number;
  hours: number;
  /** 审核通过进来的 / 手动加入的 */
  n_approved: number;
  n_manual: number;
  by_root: PoolBucket[];
  by_label: PoolBucket[];
  by_project: PoolBucket[];
  by_dog: PoolBucket[];
  by_hz: PoolBucket[];
}
export interface PoolFilter {
  project_ids?: number[];
  dog_ids?: number[];
  date_from?: string | null;
  date_to?: string | null;
}

export const poolSummary = (f: PoolFilter & { sample_hz?: number[] }) =>
  request.get<never, PoolSummary>("/data-pool/summary", {
    params: {
      project_ids: f.project_ids?.join(",") || undefined,
      dog_ids: f.dog_ids?.join(",") || undefined,
      date_from: f.date_from || undefined,
      date_to: f.date_to || undefined,
      sample_hz: f.sample_hz?.join(",") || undefined,
    },
  });

/** source：reviewed = 人确认过 / 改过 / 人工加的；approved_tasks = 审核通过的任务整份 */
export const poolAdd = (body: PoolFilter & { source: "reviewed" | "approved_tasks" }) =>
  request.post<never, { added: number }>("/data-pool/add", body);

export const poolRemove = (body: PoolFilter & { item_ids?: number[]; label_ids?: number[]; label_names?: string[] }) =>
  request.post<never, { removed: number }>("/data-pool/remove", body);
