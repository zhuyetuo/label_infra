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
  /** 同类别压在一起、并成一段的次数 */
  n_merged_overlaps?: number;
  /** 不同类别压在一起的处数（矛盾标注，要回工作台改） */
  n_label_conflicts?: number;
  /** 因为类别冲突挖掉了多少秒 */
  label_conflict_excluded_sec?: number;
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

/** 导出文件里的片段（用来核对这份数据集到底装了什么） */
export interface DatasetSegment {
  task_id: number;
  sample_code: string;
  label: string;
  start: string;
  end: string;
  seconds: number | null;
}

export const getDatasetSegments = (name: string) =>
  request.get<never, { total: number; truncated: boolean; rows: DatasetSegment[] }>(
    `/model-versions/datasets/${encodeURIComponent(name)}/segments`
  );

/** 数据集体检结果 */
export interface DatasetCheck {
  n_segments: number;
  n_exact_dups: number;
  exact_dups: { task_id: number; label: string; start: string; end: string; count: number }[];
  n_overlaps: number;
  overlaps: {
    task_id: number;
    sample_code: string;
    label_a: string; start_a: string; end_a: string;
    label_b: string; start_b: string; end_b: string;
    overlap_sec: number;
    same_label: boolean;
  }[];
  n_bad_range: number;
  bad_range: DatasetSegment[];
  n_shared_samples: number;
  shared_samples: { sample_code: string; task_ids: number[] }[];
}

export const checkDataset = (name: string) =>
  request.get<never, DatasetCheck>(`/model-versions/datasets/${encodeURIComponent(name)}/check`, {
    timeout: 120_000,
  });

/** 删掉 NAS 上这份导出（data_train/<名字>/）。训练记录不动 */
export const deleteDataset = (name: string) =>
  request.delete<never, null>(`/model-versions/datasets/${encodeURIComponent(name)}`);

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
