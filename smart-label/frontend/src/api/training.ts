import request from "@/utils/request";

/** 从审核通过的任务导出的训练数据集（落在 NAS 的 data_train/<name>/） */
export interface TrainDataset {
  name: string;
  date_from: string;
  date_to: string;
  project_id: number | null;
  include_submitted: boolean;
  /** approved = 整份审完的任务；reviewed = 只取人确认过的片段
   *  （点过「通过」/ 改过 / 人自己画的。只是打开看过没点的不算） */
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
  /** 类别冲突的明细：前端按它把工作台开到出问题的时刻 */
  conflicts?: {
    task_id: number;
    sample_code: string;
    label_a: string;
    label_b: string;
    start_ms: number;
    end_ms: number;
    seconds: number;
  }[];
  /** 互斥轨的折叠（老数据集没有这几个字段） */
  flatten?: boolean;
  track_priority?: string[];
  /** 低优先级轨被高优先级轨盖掉的秒数（卧着舔前爪：那几秒归「舔」，「卧」让出） */
  flattened_sec?: number;
  /** 各轨各导了几段（"-" 是没分轨的） */
  tracks?: Record<string, number>;
  /** 设备轨（颈圈松动）单独导了几段，不进 22 类 */
  n_device_segments?: number;
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
  // 日期和项目都可以不给：项目名跟日期不是一回事（导进来的是日期区间、
  // 还有按狗命名的），只按日期圈不准。两个都给就是"且"，都不给就是全部。
  date_from?: string | null;
  date_to?: string | null;
  project_ids?: number[];
  include_submitted?: boolean;
  scope?: "approved" | "reviewed";
  /** 分了互斥轨的项目：按优先级折叠成一个时刻一个标签（默认 true）；false = 各轨原样导，给分轨训练用 */
  flatten?: boolean;
  /** 折叠优先级，前面的赢；默认 行为 > 运动 > 姿态 */
  track_priority?: string[];
}) => request.post<never, TrainDataset>("/model-versions/datasets", body, { timeout: 600_000 });

/** 导出文件里的片段（用来核对这份数据集到底装了什么） */
export interface DatasetSegment {
  task_id: number;
  sample_code: string;
  /** 根那一级（老字段，含义不变） */
  label: string;
  /** 整条链：[抓挠, 抓挠-躯干]。只显示根的话，跟上面按类别统计出来的
   *  「抓挠-躯干 15」对不上，人会以为二级标签没导进去 */
  labels?: string[];
  start: string;
  end: string;
  seconds: number | null;
  /** 相对 CSV 起点的毫秒；老数据集没有 */
  start_ms?: number | null;
  end_ms?: number | null;
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

/** 大类底下的一个细类（整条链的最后一级）。没打过二级标签的那部分叫
 *  「X（未细分）」，不能省——省了各细类加起来就对不上大类 */
export type LabelStatChild = {
  label: string;
  is_root_only: boolean;
  n_segments: number;
  seconds: number;
  /** 占**本大类**的百分比，不是占全局：要回答的是"抓挠里头颈耳占多少" */
  pct_in_parent: number;
  by_dataset: Record<string, number>;
};

export type LabelStatRow = {
  label: string;
  n_segments: number;
  seconds: number;
  hours: number;
  pct: number;
  by_dataset: Record<string, number>;
  /** 细类摊开。**大类够不等于细类够**——抓挠 1125 秒看着充足，
   *  摊到头颈耳/躯干/肩胸上可能某一类只有几秒。老数据集回不出这个字段。
   *
   *  **不叫 children**：antd 的 Table 会把 dataSource 里的 children 当成树形
   *  子行自动展开，跟下面自己写的明细表叠在一起，每个细类出现两次。 */
  sub_labels?: LabelStatChild[];
};
export type LabelStats = {
  datasets: string[];
  missing: string[];
  total_hours: number;
  total_segments: number;
  rows: LabelStatRow[];
};

/** 按类别统计一批数据集的段数/时长/占比。names 为空 = 全部数据集。 */
export const datasetStats = (names?: string[]) =>
  request.get<never, LabelStats>("/model-versions/dataset-stats", {
    params: names?.length ? { names: names.join(",") } : {},
  });

export const checkDataset = (name: string) =>
  request.get<never, DatasetCheck>(`/model-versions/datasets/${encodeURIComponent(name)}/check`, {
    timeout: 120_000,
  });

/** 删掉 NAS 上这份导出（data_train/<名字>/）。训练记录不动 */
export const deleteDataset = (name: string) =>
  request.delete<never, null>(`/model-versions/datasets/${encodeURIComponent(name)}`);

export const listModelVersions = () => request.get<never, ModelVersion[]>("/model-versions");

/** 训练时那张类别重映射表。`table` 里没有的类别，训练脚本会把那些样本丢掉，
 *  只在训练日志里打一句——界面要靠它写清"这一类最后会变成什么"。 */
export type TrainRemap = {
  available?: boolean;
  error?: string;
  path?: string;
  /** {原始类别名: 训练类别名} */
  table: Record<string, string>;
  /** 训练最终的那几类（活动 / 睡觉 / 抓挠 / 未佩戴），当"映射到"的候选 */
  classes: string[];
};

export const trainRemap = () => request.get<never, TrainRemap>("/model-versions/train-remap");

export const submitTrain = (body: {
  dataset: {
    date: string;
    export_json?: string | null;
    extra_date?: string[];
    /** 一起训练的其它数据集（各带自己的 json 和采样率） */
    extra_datasets?: { date: string; export_json: string; source_hz?: number | null }[];
    /** 类别归并 {原名: 新名}，AI 服务整理数据时改写，不动 NAS 上的导出 */
    label_remap?: Record<string, string>;
    /** 用几轴：6=加速度+陀螺仪，3=只用加速度（端侧没有陀螺仪时用） */
    axes?: number;
    /** 端侧尺寸：限深限棵数，塞得进板子的 flash（端侧主力是 xgb） */
    edge_size?: boolean;
    missing_strategy?: string | null;
    skip_syn?: boolean;
    source_hz?: number | null;
    hz?: number | null;
    clean?: boolean;
  };
  model_type: string;
  tag?: string | null;
}) => request.post<never, ModelVersion>("/model-versions/train", body);

/** 训练日志的一段。offset 是下次该从哪儿接着要——前端只管追加 text、存下 offset */
export type TrainLog = {
  job_id: number;
  status: "queued" | "running" | "done" | "failed";
  offset: number;
  size: number;
  text: string;
  /** 现在跑到哪一步了（日志里最后一行 ▶ 开头的） */
  stage: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
};

export const trainLog = (id: number, offset: number) =>
  request.get<never, TrainLog>(`/model-versions/${id}/log`, { params: { offset } });

/** 删掉这一版：算法机上的模型/预处理数据/日志 + 这边的记录。
 *  还在跑的、正在用的会被拒绝（409），原因在报错里 */
export const deleteModelVersion = (id: number) =>
  request.delete<never, { deleted: string[] }>(`/model-versions/${id}`, { timeout: 90_000 });

/** 停掉这一版的训练（整个进程组一起停）。停了之后状态是失败，就能删了 */
export const cancelModelVersion = (id: number) =>
  request.post<never, ModelVersion>(`/model-versions/${id}/cancel`, undefined, { timeout: 40_000 });

export const refreshModelVersion = (id: number) =>
  request.post<never, ModelVersion>(`/model-versions/${id}/refresh`);

export const activateModel = (id: number) =>
  request.post<never, { model_path: string; classes: string[]; hz: number }>(
    `/model-versions/${id}/activate`,
    undefined,
    { timeout: 120_000 }
  );
