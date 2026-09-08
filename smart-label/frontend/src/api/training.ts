import request from "@/utils/request";

/** 从审核通过的任务导出的训练数据集（落在 NAS 的 data_train/<name>/） */
export interface TrainDataset {
  name: string;
  date_from: string;
  date_to: string;
  project_id: number | null;
  include_submitted: boolean;
  /** approved = 整份审完的任务；reviewed = 只取人碰过的片段 */
  scope?: "approved" | "reviewed";
  /** reviewed 模式下跳过了多少条"没人看过的 AI 片段" */
  n_untouched_skipped?: number;
  /** 被判「待定」而挖掉的段数 */
  n_uncertain_excluded?: number;
  /** 采集掉数据挖掉了多少分钟 */
  missing_excluded_min?: number;
  n_tasks: number;
  n_segments: number;
  total_hours: number;
  labels: Record<string, number>;
  warnings: string[];
  exported_at: string;
  export_json: string;
}

export interface ModelVersion {
  id: number;
  algo_job_id: number;
  status: "queued" | "running" | "done" | "failed";
  model_type: string;
  model_version: string | null;
  model_path: string | null;
  error: string | null;
  dataset_spec: string;
  metrics: string | null;
  created_at: string;
  updated_at: string;
}

export const listDatasets = () => request.get<never, TrainDataset[]>("/model-versions/datasets");

export const exportDataset = (body: {
  name: string;
  date_from: string;
  date_to: string;
  project_id?: number | null;
  include_submitted?: boolean;
  scope?: "approved" | "reviewed";
}) => request.post<never, TrainDataset>("/model-versions/datasets", body, { timeout: 600_000 });

export const listModelVersions = () => request.get<never, ModelVersion[]>("/model-versions");

export const submitTrain = (body: {
  dataset: {
    date: string;
    export_json?: string | null;
    extra_date?: string[];
    missing_strategy?: string | null;
    skip_syn?: boolean;
    source_hz?: number | null;
    hz?: number | null;
    clean?: boolean;
  };
  model_type: string;
  tag?: string | null;
}) => request.post<never, ModelVersion>("/model-versions/train", body);

export const refreshModelVersion = (id: number) =>
  request.post<never, ModelVersion>(`/model-versions/${id}/refresh`);

export const activateModel = (id: number) =>
  request.post<never, { model_path: string; classes: string[]; hz: number }>(
    `/model-versions/${id}/activate`,
    undefined,
    { timeout: 120_000 }
  );
