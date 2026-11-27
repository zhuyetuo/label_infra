import request from "@/utils/request";

/** 模型测试集：给模型「考试」的数据。里面的样本不进任何训练导出；冻结后不能增删，补数据复制成新版本 */
export interface TestSet {
  id: number;
  name: string;
  note: string | null;
  frozen: boolean;
  frozen_at: string | null;
  created_at: string | null;
  created_by?: number | null;
  creator_name?: string | null;
  is_demo?: boolean;
  n_items: number;
  n_samples: number;
  n_checked?: number;
  n_seen?: number;
  n_unseen?: number;
  seen_ref?: string | null;
}

export interface TestItem {
  id: number;
  task_id: number;
  sample_id: number;
  sample_code: string | null;
  project_id: number | null;
  project_name: string | null;
  task_status: string | null;
  date: string | null;
  site: string | null;
  dog_id: number | null;
  dog_name: string | null;
  size: string | null;
  /** 人工关联 / 按设备推断 */
  dog_source: "人工" | "推断" | null;
  /** 推断的、而且是 9 月中以前不带场地的老影棚数据：常对不上 */
  dog_unsure: boolean;
  start_ms: number;
  end_ms: number;
  dur_sec: number;
  kind: "短片段" | "中片段" | "长片段";
  /** 窗口里各大类：段数 / 秒数（待定的不算） */
  labels: Record<string, { n: number; sec: number }>;
  n_uncertain: number;
  /** 窗口内还没人工确认/通过的 AI 预标片段数 */
  n_ai_pending?: number;
  /** 窗口内可自动去重的重叠对数（同类重叠 / 父子覆盖 / 行为压运动 / 活动压静止） */
  n_dedupe?: number;
  /** 窗口内同轨异类冲突对数（需人工判断） */
  n_conflict?: number;
  /** 窗口内相邻同类（间隔 ≤1.5s）可合并组数 */
  n_mergeable?: number;
  /** 窗口里有多少时间标了东西（0~1）。测试数据要窗口内全标 */
  label_cover: number;
  /** 窗口里的疑似片段：{类别: {pending/confirmed/rejected/uncertain: 条数}} */
  cands?: Record<string, Record<string, number>>;
  /** 窗口里的细类（抓挠-头颈耳…）：段数 */
  leaf?: Record<string, number>;
  /** 人工核对过这一段 */
  checked?: boolean;
  checked_at?: string | null;
  note: string | null;
}

export interface ComposeBody {
  label_names: string[];
  sites?: string[];
  dog_ids?: number[];
  date_from?: string | null;
  date_to?: string | null;
  source?: "any" | "human" | "ai";
  seen_mode?: "any" | "unseen" | "seen";
  model_ids?: number[];
  per_group?: number;
  max_total?: number;
  pad_sec?: number;
  min_sec?: number;
  seed?: number;
  /** positive = 有这类（以这类片段为中心）；negative = 无这类（整个窗口一次都没有） */
  mode?: "positive" | "negative";
  /** 无这类时以哪类片段为中心；不给 = 任何别的类别 */
  anchor_names?: string[];
  /** 每只狗最多几段 */
  per_dog?: number | null;
}
export interface ComposeStats {
  n_found: number;
  n_picked: number;
  video_hours: number;
  by_dog_label: Record<string, Record<string, number>>;
  available: Record<string, Record<string, number>>;
  dogs: Record<string, { site: string | null; size: string | null }>;
  by_site: Record<string, number>;
  by_source: Record<string, number>;
  by_date: Record<string, number>;
  skipped_unclear?: SkippedUnclear;
}
export const getLabelTree = () => request.get<never, { name: string; parent: string | null }[]>("/model-tests/label-tree");
export const composePreview = (setId: number, body: ComposeBody) =>
  request.post<never, { stats: ComposeStats; warnings: string[] }>(`/model-tests/sets/${setId}/compose/preview`, body, { timeout: 300_000 });
export const composeApply = (setId: number, body: ComposeBody) =>
  request.post<never, { added: number; stats: ComposeStats; warnings: string[] }>(`/model-tests/sets/${setId}/compose`, body, { timeout: 300_000 });
export const checkTestItem = (itemId: number, checked: boolean) =>
  request.post<never, { checked: boolean }>(`/model-tests/items/${itemId}/check`, { checked });
export const checkAllTestItems = (setId: number, checked: boolean) =>
  request.post<never, { updated: number; checked: boolean }>(`/model-tests/sets/${setId}/check-all`, { checked });
export const promoteTestItemToPool = (itemId: number, restoreApproved = false) =>
  request.post<never, { n_pooled: number; removed: number; still_in_other_sets: string[] }>(
    `/model-tests/items/${itemId}/promote-to-pool`,
    { restore_approved: restoreApproved },
  );

export interface Coverage {
  n_items: number;
  total_sec: number;
  /** 体型 → 大类 → {items 有它的段数, n 事件数, sec 秒数} */
  matrix: Record<string, Record<string, { items: number; n: number; sec: number }>>;
  kinds: Record<string, number>;
  dogs: { site: string | null; dog: string | null; sec: number; share: number }[];
  n_dogs: number;
  sites: Record<string, number>;
  dates: Record<string, number>;
  /** 细类（部位）段数 */
  leaf?: Record<string, number>;
  n_checked?: number;
  /** 按实际时长（「1 分钟」「10 分钟」…）× 有抓挠 / 无抓挠 的段数 */
  by_dur?: Record<string, Record<string, number>>;
  warnings: string[];
}

export interface SeenModel {
  model_id: number;
  algo_job_id: number;
  model_version: string | null;
  listed: boolean;
  datasets: string[];
  missing_datasets: string[];
  n_seen: number;
  n_unseen: number;
  seen_item_ids: number[];
}

export const listTestSets = () =>
  request.get<never, { sets: TestSet[]; n_excluded_samples: number }>("/model-tests/sets");
export const createTestSet = (body: { name: string; note?: string }) =>
  request.post<never, TestSet>("/model-tests/sets", body);
export const updateTestSet = (id: number, body: { name?: string; note?: string }) =>
  request.patch<never, TestSet>(`/model-tests/sets/${id}`, body);
export const freezeTestSet = (id: number) => request.post<never, TestSet>(`/model-tests/sets/${id}/freeze`);
export const copyTestSet = (id: number, body: { name: string; note?: string }) =>
  request.post<never, TestSet>(`/model-tests/sets/${id}/copy`, body);
export const getTestItems = (id: number) =>
  request.get<never, { set: TestSet & { plan?: Plan | null }; items: TestItem[]; coverage: Coverage; colors?: Record<string, string> }>(`/model-tests/sets/${id}/items`);
/** 选样计划：每只狗 × 时长 × 有/无 × 部位 */
export interface PlanDog { dog_id: number; q: Record<string, [number, number]>; p: Record<string, number> }
export interface Plan {
  target: string;
  durations: number[];
  parts: string[];
  anchor_names?: string[] | null;
  /** 「无这类」的分类：以哪些片段为中心、占多少比例（每只狗每种时长的「无」按比例摊） */
  neg_cats?: { name: string; anchors: string[]; ratio: number; anchor_ratios?: Record<string, number> | null }[] | null;
  /** 按比例自动配用的比例（只是记下来，下次打开还在） */
  alloc?: {
    site?: Record<string, number>; dur?: Record<string, number>; pos?: number; neg?: number;
    part?: Record<string, number>; dog?: "even" | "avail"; size?: Record<string, number>;
    /** 总段数；不纳入的狗 */
    total?: number; exclude?: number[];
  } | null;
  dogs: PlanDog[];
  date_from?: string | null;
  date_to?: string | null;
  source?: "any" | "human" | "ai";
  seen_mode?: "any" | "unseen" | "seen";
  model_ids?: number[] | null;
  seed?: number;
}
export interface PlanResult {
  report: Record<string, { q: Record<string, [number, number]>; p: Record<string, number>; n?: Record<string, Record<string, number>> }>;
  n_picked: number;
  video_hours: number;
  by_source: Record<string, number>;
  warnings: string[];
  added?: number;
  /** 重新生成时删掉的原有片段数 */
  removed?: number;
}
export interface SkippedUnclear {
  total: number;
  by_reason: Record<string, number>;
  by_site: Record<string, number>;
  by_dog: { dog_id: number | null; dog_name: string; site: string; n: number; reasons: Record<string, number> }[];
  items: {
    task_id: number; sample_code: string; dog_name: string; site: string;
    label: string; start_ms: number; end_ms: number; reason: string; date: string | null;
  }[];
}
export const planAvailability = (plan: Plan) =>
  request.post<never, { by_dog: Record<string, Record<string, number>>; dur_buckets?: { label: string; n: number }[]; skipped_unclear?: SkippedUnclear; warnings: string[] }>("/model-tests/plan/availability", plan, { timeout: 300_000 });
export const planPreview = (setId: number, plan: Plan) =>
  request.post<never, PlanResult>(`/model-tests/sets/${setId}/plan/preview`, plan, { timeout: 600_000 });
export const planSave = (setId: number, plan: Plan) => request.post<never, { saved: boolean }>(`/model-tests/sets/${setId}/plan/save`, plan);
export const planApply = (setId: number, plan: Plan) =>
  request.post<never, PlanResult>(`/model-tests/sets/${setId}/plan/apply`, plan, { timeout: 600_000 });

/** 删测试集：只删测试集和条目，任务 / 标注不动 */
export const deleteTestSet = (id: number) => request.delete<never, { deleted_items: number }>(`/model-tests/sets/${id}`);
/** 任务当前轮的标注片段（挑事件用） */
export interface TaskSeg { id: number; top: string; label: string; start_ms: number; end_ms: number; uncertain: boolean }
export const getTaskSegments = (taskId: number) =>
  request.get<never, TaskSeg[]>("/model-tests/task-segments", { params: { task_id: taskId } });

/** pad_to_sec：凑够多少秒，围绕起止前后各延长一半（碰到头尾往另一边补），要先给起止 */
export const addTestItems = (id: number, items: { task_id: number; start_ms?: number | null; end_ms?: number | null; note?: string; pad_to_sec?: number | null }[]) =>
  request.post<never, { added: number; skipped: { task_id: number; reason: string }[] }>(`/model-tests/sets/${id}/items`, { items });
export const deleteTestItem = (itemId: number) => request.delete<never, { deleted: number; preserved_in_pool?: number }>(`/model-tests/items/${itemId}`);
export const batchRemoveTestItems = (setId: number, item_ids: number[]) =>
  request.post<never, { removed: number; preserved_in_pool: number }>(
    `/model-tests/sets/${setId}/items/remove`, { item_ids });
export const batchPromoteTestItems = (item_ids: number[]) =>
  request.post<never, { moved_windows: number; pooled_segments: number; removed_from_sets: number }>(
    "/model-tests/items/batch-promote", { item_ids });
export const dedupeTestSet = (setId: number, item_ids?: number[]) =>
  request.post<never, { tasks_cleaned: number; removed: number; carved: number; conflicts: number }>(
    `/model-tests/sets/${setId}/dedupe`, { item_ids: item_ids?.length ? item_ids : null }, { timeout: 180_000 });
export const mergeAdjacentTestSet = (setId: number, item_ids?: number[], max_gap_ms = 1500) =>
  request.post<never, { groups_merged: number; removed: number; windows_cleaned: number }>(
    `/model-tests/sets/${setId}/merge-adjacent`,
    { item_ids: item_ids?.length ? item_ids : null, max_gap_ms },
    { timeout: 180_000 },
  );
export const getTestSeen = (id: number, modelIds?: number[]) =>
  request.get<never, { models: SeenModel[]; n_items: number }>(`/model-tests/sets/${id}/seen`, {
    params: modelIds?.length ? { model_ids: modelIds.join(",") } : undefined,
    timeout: 300_000,
  });

/** 发布静态 HTML 测试报告到服务端，返回无需登录即可打开的分享链接 */
export const publishTestReport = (setId: number, html: string, title?: string) =>
  request.post<never, { report_id: string; url: string }>(
    `/model-tests/sets/${setId}/reports`,
    { html, title },
    { timeout: 60_000 },
  );
