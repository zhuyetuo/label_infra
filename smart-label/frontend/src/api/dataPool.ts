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
  /** 类别层级：每个节点含它底下全部细类的段数 / 时长；parent = 上一级的名字（根是 null） */
  tree?: (PoolBucket & { parent: string | null })[];
}
export interface PoolFilter {
  project_ids?: number[];
  dog_ids?: number[];
  task_ids?: number[];
  date_from?: string | null;
  date_to?: string | null;
  sample_hz?: number[];
  /** 只要不短于这么多秒的片段 */
  min_sec?: number | null;
  /** 类别名（含细类） */
  label_names?: string[];
}

const toParams = (f: PoolFilter) => ({
  project_ids: f.project_ids?.join(",") || undefined,
  dog_ids: f.dog_ids?.join(",") || undefined,
  task_ids: f.task_ids?.join(",") || undefined,
  date_from: f.date_from || undefined,
  date_to: f.date_to || undefined,
  sample_hz: f.sample_hz?.join(",") || undefined,
  min_sec: f.min_sec || undefined,
  label_names: f.label_names?.join(",") || undefined,
});

export const poolSummary = (f: PoolFilter) =>
  request.get<never, PoolSummary>("/data-pool/summary", { params: toParams(f) });

export interface PoolItem {
  id: number;
  task_id: number;
  project_id: number;
  project_name: string;
  sample_code: string;
  session_date: string | null;
  dog_name: string | null;
  hz: number;
  label_id: number;
  label_name: string;
  start_time_ms: number;
  end_time_ms: number;
  /** manual = 手动加入；approved = 片段审核通过进来的 */
  via: "manual" | "approved";
}
export type PoolSort = "long" | "short" | "new" | "time";

export const poolItems = (f: PoolFilter, sort: PoolSort, page: number, pageSize: number) =>
  request.get<never, { total: number; items: PoolItem[] }>("/data-pool/items", {
    params: { ...toParams(f), sort, page, page_size: pageSize },
  });

/** source：reviewed = 人确认过 / 改过 / 人工加的；approved_tasks = 审核通过的任务整份；
 *  submitted = 已提交 / 通过的任务整份；all = 全部片段（配 task_ids：这个任务看过，整份认） */
export const poolAdd = (body: PoolFilter & { source: "reviewed" | "approved_tasks" | "submitted" | "all" }) =>
  request.post<never, { added: number }>("/data-pool/add", body);

export const poolRemove = (body: PoolFilter & { item_ids?: number[] }) =>
  request.post<never, { removed: number }>("/data-pool/remove", body);
