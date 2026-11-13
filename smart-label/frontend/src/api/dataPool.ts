import request from "@/utils/request";

/** 数据池：人认可的高质量片段库。审核通过的自动在池里，另外能整批手动加入 / 移出 */
export interface PoolBucket {
  /** 项目 / 狗的 id（筛选用；狗「未关联」是 null） */
  id?: number | null;
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
  /** 按采集日（YYYY-MM-DD） */
  by_date?: PoolBucket[];
  /** 谁审核通过的（id = 用户；手动加入的是 id=null「手动加入」） */
  by_reviewer?: PoolBucket[];
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
  /** 谁审核通过的 */
  reviewer_ids?: number[];
  /** 审核时间段（YYYY-MM-DD，含两头） */
  reviewed_from?: string | null;
  reviewed_to?: string | null;
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
  reviewer_ids: f.reviewer_ids?.join(",") || undefined,
  reviewed_from: f.reviewed_from || undefined,
  reviewed_to: f.reviewed_to || undefined,
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
  /** 进池时间（手动加入的时间 / 审核通过的时间），"YYYY-MM-DD HH:mm" */
  entered_at?: string | null;
  /** 谁审核通过的（手动加入的没有） */
  reviewed_by?: number | null;
  reviewed_by_name?: string | null;
  /** 什么时候审核通过的 "YYYY-MM-DD HH:mm" */
  reviewed_at?: string | null;
}
export type PoolSort = "long" | "short" | "new" | "time" | "recent";

export const poolItems = (f: PoolFilter, sort: PoolSort, page: number, pageSize: number) =>
  request.get<never, { total: number; items: PoolItem[] }>("/data-pool/items", {
    params: { ...toParams(f), sort, page, page_size: pageSize },
  });

/** source：reviewed = 人确认过 / 改过 / 人工加的；approved_tasks = 审核通过的任务整份；
 *  submitted = 已提交 / 通过的任务整份；all = 全部片段（配 task_ids：这个任务看过，整份认） */
export const poolAdd = (body: PoolFilter & { source: "reviewed" | "approved_tasks" | "submitted" | "all" }) =>
  request.post<never, { added: number }>("/data-pool/add", body);

/** 撤销审核通过（怀疑某人审得不对）：片段回到还没审、出池；send_back = 领给原来通过的人让他重看 */
export const poolRevertApprovals = (body: PoolFilter & { item_ids?: number[]; send_back?: boolean }) =>
  request.post<never, { reverted: number }>("/data-pool/revert-approvals", body);
export const poolRemove = (body: PoolFilter & { item_ids?: number[] }) =>
  request.post<never, { removed: number }>("/data-pool/remove", body);

/** 类别对比：两类片段的原始 IMU 数据逐个维度比 */
export interface CompareFeature {
  key: string;
  name: string;
  hint: string;
  /** P(A > B)：0.5 = 分不开 */
  auc: number;
  /** |AUC-0.5|×2：0 分不开，1 一刀分开 */
  sep: number;
  cut: number;
  cut_acc: number;
  cut_side: string;
  /** 两类的 5% / 25% / 50% / 75% / 95% 分位 */
  qa: number[];
  qb: number[];
  edges: number[];
  /** 直方图（各自归一化成占比） */
  ha: number[];
  hb: number[];
  /** 主要随设备标定 / 放置角度变的维度（跨设备比出来的差多半是换了项圈） */
  device_sensitive?: boolean;
}
export interface CompareResult {
  a: { names: string[]; segments: number; windows: number; samples: number };
  b: { names: string[]; segments: number; windows: number; samples: number };
  win_s: number;
  axes?: number;
  unreadable: string[];
  features: CompareFeature[];
  error?: string;
  warnings?: string[];
}
export interface ComparePreviewSide {
  segments: number; samples: number; total_s: number;
  /** 够一个窗口的 / 比窗口短但 ≥1 秒（整段算一个窗口）/ 不到 1 秒（不用） */
  long: number; short: number; too_short: number;
  /** 大概能切出多少个窗口 */
  windows: number;
}
export const comparePreview = (body: { a: string[]; b: string[]; project_ids?: number[]; pool_only?: boolean; win_s?: number }) =>
  request.post<never, { a: ComparePreviewSide; b: ComparePreviewSide }>("/data-pool/compare-preview", body);
export const classCompare = (body: {
  a: string[]; b: string[]; project_ids?: number[]; pool_only?: boolean; win_s?: number; max_segments?: number;
  /** 3 = 只用加速度计（默认）；6 = 加上陀螺仪 */
  axes?: 3 | 6;
}) => request.post<never, CompareResult>("/data-pool/compare", body, { timeout: 300_000 });

/** 数据盘点：某一类（含细类）的片段各在哪一步 */
export interface InventoryBucket {
  key: string; name: string; usable: boolean; note: string; n: number; seconds: number;
  by_project: { name: string; n: number; seconds: number }[];
}
export interface LabelInventory {
  label: string; labels: string[];
  /** 训练记录用过的数据集：各自这一类有几段 / 多长，被哪几条训练记录用了 */
  datasets: { name: string; versions: number[]; n: number; seconds: number; missing: boolean }[];
  buckets: InventoryBucket[];
  candidates_pending: { n: number; seconds: number };
  totals: Record<"used" | "pool_unused" | "reviewed_unused" | "ai_untouched" | "all", { n: number; seconds: number }>;
}
export const labelInventory = (label: string) =>
  request.get<never, LabelInventory>("/data-pool/inventory", { params: { label }, timeout: 120000 });
