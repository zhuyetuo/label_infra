import request from "@/utils/request";

/** 跑过的一个 (模型, 版本)：对比页的下拉选项 */
export interface EvalRunOption {
  model_tag: string;
  mode: string;
  model_path: string | null;
  n_samples: number;
  n_segments: number;
  last_run_at: string | null;
}

/** 评测集：冻结下来的一批样本，每次训完模型都拿它跑，指标才可比 */
export interface EvalSet {
  id: number;
  name: string;
  n_samples: number;
  sample_ids: number[];
  note: string | null;
  created_at: string | null;
}

export interface PrfPoint {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface VersionResult {
  model_tag: string;
  mode: string;
  key: string;
  n_samples_with_result: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  mean_iou: number | null;
  hit_conf_mean: number | null;
  fp_conf_mean: number | null;
  curve: PrfPoint[];
}

export interface VersionDiff {
  base: string;
  other: string;
  gained: number;
  lost: number;
  both: number;
  lost_samples: number[];
}

export interface CompareResult {
  versions: VersionResult[];
  diffs: VersionDiff[];
  n_samples: number;
  n_truth: number;
  iou_min: number;
  warnings: string[];
}

export interface EvalRunProgress {
  status: "idle" | "running" | "done" | "error";
  total: number;
  done: number;
  failed: number;
  current: string | null;
  detail: string[];
}

export const listEvalRuns = () => request.get<never, EvalRunOption[]>("/model-eval/runs");
export const listEvalSets = () => request.get<never, EvalSet[]>("/model-eval/sets");
export const createEvalSet = (body: {
  name: string;
  date_from?: string;
  date_to?: string;
  sample_ids?: number[];
  note?: string;
}) => request.post<never, { name: string; n_samples: number }>("/model-eval/sets", body);

export const compareModels = (body: {
  set_id?: number;
  sample_ids?: number[];
  date_from?: string;
  date_to?: string;
  versions: { model_tag: string; mode: string }[];
  label?: string;
  iou_min?: number;
  conf_min?: number;
}) => request.post<never, CompareResult>("/model-eval/compare", body, { timeout: 600_000 });

export const startEvalRun = (body: {
  set_id?: number;
  sample_ids?: number[];
  date_from?: string;
  date_to?: string;
  modes: string[];
}) => request.post<never, { started: boolean; n_samples: number; modes: string[] }>("/model-eval/run", body);

export const getEvalRunProgress = () => request.get<never, EvalRunProgress>("/model-eval/run/progress");
