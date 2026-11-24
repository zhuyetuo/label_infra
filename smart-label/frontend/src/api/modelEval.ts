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

/** 评测范围：评测集 / 日期 / 样本 / 项目（单个、多选、全部）。
 *  项目范围不要求人工审过——两版互比不需要正确答案。 */
export interface ScopeParams {
  set_id?: number;
  sample_ids?: number[];
  date_from?: string;
  date_to?: string;
  project_ids?: number[];
  all_projects?: boolean;
}

/** 给了范围就只数这批样本：n_scope = 这批多少个审过的样本，runs 里的 n_samples = 其中跑了几个 */
export const listEvalRuns = (params: ScopeParams = {}) =>
  request.get<never, { n_scope: number | null; runs: EvalRunOption[] }>("/model-eval/runs", {
    // axios 默认把数组拼成 project_ids[]=1，FastAPI 认的是重复键 / 逗号分隔
    params: { ...params, project_ids: params.project_ids?.join(",") },
  });
export const listEvalSets = () => request.get<never, EvalSet[]>("/model-eval/sets");
export const createEvalSet = (body: {
  name: string;
  date_from?: string;
  date_to?: string;
  sample_ids?: number[];
  note?: string;
}) => request.post<never, { id: number; name: string; n_samples: number }>("/model-eval/sets", body);

export const compareModels = (body: {
  set_id?: number;
  sample_ids?: number[];
  date_from?: string;
  date_to?: string;
  versions: { model_tag: string; mode: string }[];
  label?: string;
  iou_min?: number;
  conf_min?: number;
  /** 只算这些时间窗口里的（模型测试集） */
  windows?: { sample_id: number; start_ms: number; end_ms: number }[];
}) => request.post<never, CompareResult>("/model-eval/compare", body, { timeout: 600_000 });

export const startEvalRun = (body: ScopeParams & { modes: string[] }) =>
  request.post<never, { started: boolean; n_samples: number; modes: string[] }>("/model-eval/run", body);

export const getEvalRunProgress = () => request.get<never, EvalRunProgress>("/model-eval/run/progress");

/** 端侧推理服务上挂着的一个模型。跑的是烧进项圈的那份 C，用来回答
 *  "这个模型上板之后会是什么效果"。 */
export interface EdgeModel {
  tag: string;
  /** 跑批时要传的版本字符串，形如 edge:edge_cnn_i8。后端拼好，前端不自己拼——
   *  拼错的表现是"没有这个端侧模型"，而前端看不出哪里错 */
  spec: string;
  /** 同一个模型、不做后处理的版本（edge:<标签>@raw），板子真实会报的样子。
   *  老后端没这个字段，所以可选——hook 那边有兜底拼法 */
  spec_raw?: string;
  /** 整条链都是板上那份 C（模型 + 推理 + 后处理）。没有板子时，
   *  这一列才真正回答"板子会报什么" */
  spec_board?: string;
  classes: string[];
  window: number;
  hz: number;
  stride: number;
  /** 5 = 3 轴（acc + pitch/roll），8 = 6 轴。老服务没这个字段 */
  n_channels?: number;
  kind?: string;
  /** 训练记录里导出来的才有：平台靠它对回「训练记录 #N」 */
  train?: { job_id: number | null; tag: string; axes?: number; sk_macro_f1?: number | null } | null;
  /** 端侧 F1（板上那份 C 在留出集上） */
  edge?: { macro_f1?: number; per_class?: Record<string, Record<string, number>> } | null;
}

/** enabled=false 是没配这个服务（功能关着）；enabled=true 但 models 空
 *  是配了连不上。界面上这两种要分开说——一个是"没开"，一个是"挂了"。 */
export const listEdgeModels = () =>
  request.get<never, { enabled: boolean; models: EdgeModel[] }>("/model-eval/edge-models");

/** AI 服务（imu_train 的 label_service）上挂着的一个模型。
 *
 *  跟 EdgeModel 是**两回事**：那边跑的是烧进项圈的那份 C，这边跑的是
 *  服务器上的 sklearn。只用加速计那种实验模型属于这边——放进端侧组的话，
 *  人会以为它是板子会跑的东西。 */
export interface ServerModel {
  tag: string;
  /** 默认那个 = 界面上「稳定版 / 稳定版v2 / 调试版」用的那份模型。
   *  它的 spec 是 null：再给一个 srv:default 会让同一个东西有两种写法，
   *  而两种写法存进库里是两个不同的 model_tag，对比表里会分成两列 */
  is_default: boolean;
  /** 跑批时要传的版本串（srv:<标签>），默认模型是 null */
  spec: string | null;
  spec_raw: string | null;
  spec_stable: string | null;
  /** 目录名，给人看的 */
  name: string;
  /** 训练记录里训出来、自动登记进来的那几版才有：对回训练记录用 */
  train?: { job_id: number; dataset?: string; axes?: number; classes?: string[]; macro_f1?: number };
  model_path: string;
  /** 还没被用过的模型是懒加载的，这时候类别/几何是 null——
   *  为了列个下拉就把每个 50MB 的 pkl 都加载一遍太贵 */
  loaded: boolean;
  classes: string[] | null;
  hz: number | null;
  window_s: number | null;
  stride_s: number | null;
}

/** AI 服务是老版本（没有 /models 端点）时返回空列表，不是报错——
 *  多模型是可选功能，没有它下拉跟以前一模一样。 */
export const listServerModels = () =>
  request.get<never, { models: ServerModel[] }>("/model-eval/server-models");

// ── 两版互比：不需要人工标注，A/B 互相参照 ─────────────────────────────

export interface ABVersionRef {
  model_tag: string;
  mode: string;
}

export interface ABSeg {
  start_ms: number;
  end_ms: number;
}

export interface ABSegRow {
  kind: "both" | "only_a" | "only_b";
  iou?: number;
  /** 只有一边有的片段：它被认成什么类别 */
  label?: string | null;
  /** 两边都有的片段：各自认的类别 */
  label_a?: string | null;
  label_b?: string | null;
  same_label?: boolean;
  a?: ABSeg;
  b?: ABSeg;
  /** B - A，正数 = B 比 A 晚；类别不同时不算起止差 */
  d_start_ms?: number | null;
  d_end_ms?: number | null;
}

export interface ABSampleDiff {
  sample_id: number;
  sample_code: string;
  project_id?: number | null;
  task_id?: number | null;
  n_a: number;
  n_b: number;
  matched: number;
  only_a: number;
  only_b: number;
  /** 同一时段两边认成了不同类别 */
  label_diff: number;
  boundary_bad: number;
  d_start_mean_ms: number | null;
  d_end_mean_ms: number | null;
  diff_count: number;
  segments: ABSegRow[];
}

export interface ABDiffTotals {
  n_seg_a?: number;
  n_seg_b?: number;
  matched?: number;
  only_a?: number;
  only_b?: number;
  label_diff?: number;
  label_same_ratio?: number | null;
  boundary_bad?: number;
  mean_iou?: number | null;
  d_start_mean_ms?: number | null;
  d_end_mean_ms?: number | null;
  d_start_abs_mean_ms?: number | null;
  d_end_abs_mean_ms?: number | null;
  within_2s_ratio?: number | null;
}

export interface ABDiffResult {
  a: ABVersionRef & { key: string; n_runs: number };
  b: ABVersionRef & { key: string; n_runs: number };
  n_scope: number;
  n_covered: number;
  totals: ABDiffTotals;
  n_diverged: number;
  diverged_samples: ABSampleDiff[];
  iou_min: number;
  edge_2s_ms: number;
  warnings: string[];
}

export const diffModels = (body: ScopeParams & {
  a: ABVersionRef;
  b: ABVersionRef;
  label?: string;
  iou_min?: number;
  max_samples?: number;
}) => request.post<never, ABDiffResult>("/model-eval/diff", body, { timeout: 600_000 });
