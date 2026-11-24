import request from "@/utils/request";

/** 模型测试集：给模型「考试」的数据。里面的样本不进任何训练导出；冻结后不能增删，补数据复制成新版本 */
export interface TestSet {
  id: number;
  name: string;
  note: string | null;
  frozen: boolean;
  frozen_at: string | null;
  created_at: string | null;
  n_items: number;
  n_samples: number;
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
  kind: "短片段" | "长片段";
  /** 窗口里各大类：段数 / 秒数（待定的不算） */
  labels: Record<string, { n: number; sec: number }>;
  n_uncertain: number;
  /** 窗口里有多少时间标了东西（0~1）。测试数据要窗口内全标 */
  label_cover: number;
  note: string | null;
}

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
export const freezeTestSet = (id: number) => request.post<never, TestSet>(`/model-tests/sets/${id}/freeze`);
export const copyTestSet = (id: number, body: { name: string; note?: string }) =>
  request.post<never, TestSet>(`/model-tests/sets/${id}/copy`, body);
export const getTestItems = (id: number) =>
  request.get<never, { set: TestSet; items: TestItem[]; coverage: Coverage }>(`/model-tests/sets/${id}/items`);
/** 任务当前轮的标注片段（挑事件用） */
export interface TaskSeg { id: number; top: string; label: string; start_ms: number; end_ms: number; uncertain: boolean }
export const getTaskSegments = (taskId: number) =>
  request.get<never, TaskSeg[]>("/model-tests/task-segments", { params: { task_id: taskId } });

/** pad_to_sec：凑够多少秒，围绕起止前后各延长一半（碰到头尾往另一边补），要先给起止 */
export const addTestItems = (id: number, items: { task_id: number; start_ms?: number | null; end_ms?: number | null; note?: string; pad_to_sec?: number | null }[]) =>
  request.post<never, { added: number; skipped: { task_id: number; reason: string }[] }>(`/model-tests/sets/${id}/items`, { items });
export const deleteTestItem = (itemId: number) => request.delete<never, { deleted: number }>(`/model-tests/items/${itemId}`);
export const getTestSeen = (id: number, modelIds?: number[]) =>
  request.get<never, { models: SeenModel[]; n_items: number }>(`/model-tests/sets/${id}/seen`, {
    params: modelIds?.length ? { model_ids: modelIds.join(",") } : undefined,
    timeout: 300_000,
  });
