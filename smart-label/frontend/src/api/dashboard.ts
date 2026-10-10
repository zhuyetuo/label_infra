import request from "@/utils/request";

/** 标注员的一条提交：谁、哪个任务、几点交的、用了多久、几段 */
export interface AnnotatorWorkRow {
  task_id: number;
  round_no: number;
  status: string;
  user_id: number | null;
  user_name: string | null;
  project_id: number;
  project_name: string;
  sample_code: string | null;
  video_duration_sec: number | null;
  submitted_at: string | null;
  started_at: string | null;
  work_seconds: number | null;
  item_count: number;
  scratch_items: number;
  scratch_pending: number;
  cand_total: number;
  cand_pending: number;
}

/** 一次候选判定（确认 / 排除 / 待定） */
export interface CandidateDecisionRow {
  decided_at: string | null;
  status: string;
  label_name: string;
  task_id: number;
  user_id: number | null;
  user_name: string | null;
  project_id: number;
  project_name: string;
}

export interface AnnotatorWork {
  submissions: AnnotatorWorkRow[];
  candidate_decisions: CandidateDecisionRow[];
}

/** 每个项目的完成度：任务交了几个、抓挠片段还有几段没确认、疑似还有几条没判 */
export interface ProjectProgress {
  project_id: number;
  project_name: string;
  tasks_total: number;
  tasks_submitted: number;
  tasks_approved: number;
  scratch_total: number;
  scratch_pending: number;
  cand_total: number;
  cand_pending: number;
  /** 整个项目每个大类（子类算进父类）的片段：段数、秒数、人确认过的、AI 给的还没人看的、分布在几个任务里。
   *  项目里有但一段都没有的大类也在（n=0） */
  categories?: ProjectCategory[];
  /** 疑似片段按类别 {类别名: {n, pending}} */
  cand_labels?: Record<string, { n: number; pending: number }>;
}

export interface ProjectCategory {
  name: string;
  color: string | null;
  n: number;
  seconds: number;
  confirmed: number;
  pending: number;
  tasks: number;
  /** 细分到具体标签各几段（舔-前左爪 3…） */
  sub: Record<string, number>;
}

export const listProjectProgress = () => request.get<never, ProjectProgress[]>("/dashboard/project-progress");

export const listAnnotatorWork = (dateFrom: string, dateTo: string, userId?: number) =>
  request.get<never, AnnotatorWork>("/dashboard/annotator-work", {
    params: { date_from: dateFrom, date_to: dateTo, ...(userId ? { user_id: userId } : {}) },
  });

/** 人力管理：分配台账 / 效率 / 预估 */
export interface LedgerRow {
  project_id: number;
  project_name: string;
  user_id: number;
  user_name: string;
  tasks_total: number;
  tasks_submitted: number;
  tasks_approved: number;
  scratch_total: number;
  scratch_pending: number;
  cand_total: number;
  cand_pending: number;
  assigned_at: string | null;
  /** 有分配日志（指派/批量导入时记的）；没有的话 assigned_at 退回任务创建时间 */
  assigned_logged: boolean;
  first_touch: string | null;
  last_touch: string | null;
  finished_at: string | null;
  days_used: number | null;
  done: boolean;
}
export interface EffCategory {
  category: string;
  n: number;
  n_timed: number;
  median_seconds: number | null;
  mean_seconds: number | null;
}
/** 一个人一天：有效工时（动作间隔累加，离开超过 10 分钟不算）、确认了多少 */
export interface EffDay {
  day: string;
  actions: number;
  work_seconds: number;
  /** 确认 / 改 / 新加的片段数（同一段按最后一次动手算一次） */
  segments: number;
  /** 判了几条疑似片段（确认 / 排除 / 待定） */
  cands: number;
  /** 交了几个任务 */
  submits: number;
  /** 动过几个任务 */
  tasks: number;
  /** 第一次 / 最后一次动手，HH:MM 本地时间 */
  first: string | null;
  last: string | null;
  /** 片段按大类各几段 */
  categories: Record<string, number>;
  /** 这天动了哪些项目，各做了多少（有效工时按"间隔归后一个动作"分到项目上），工时多的在前 */
  projects: { project: string; segments: number; cands: number; submits: number; work_seconds: number; tasks: number }[];
}
export interface EffUser {
  user_id: number;
  user_name: string;
  categories: EffCategory[];
  days: EffDay[];
  total_actions: number;
  total_work_seconds: number;
}
export interface EstimateRow {
  project_id: number;
  project_name: string;
  user_id: number;
  user_name: string;
  tasks_left: number;
  scratch_pending: number;
  cand_pending: number;
  sec_per_scratch: number | null;
  sec_per_cand: number | null;
  sec_per_task: number | null;
  using_pool: { scratch: boolean; cand: boolean; tasks: boolean };
  hours_left: number | null;
  days_left: number | null;
  missing: string[];
}
export interface UnassignedRow {
  project_id: number;
  project_name: string;
  tasks_left: number;
  scratch_total: number;
  scratch_pending: number;
  cand_total: number;
  cand_pending: number;
  hours_left: number | null;
  days_left: number | null;
  missing: string[];
}
export interface Workforce {
  ledger: LedgerRow[];
  efficiency: EffUser[];
  estimate: EstimateRow[];
  /** 还没分给人的活，按全员速度预估 */
  unassigned: UnassignedRow[];
  pool_rates: Record<string, number | null>;
  gap_max_seconds: number;
}
export const getWorkforce = (dateFrom: string, dateTo: string) =>
  request.get<never, Workforce>("/dashboard/workforce", { params: { date_from: dateFrom, date_to: dateTo } });

export interface DatasetStats {
  projects: { id: number; name: string }[];
  /** 审核通过的任务数 */
  n_tasks: number;
  /** 按时长从多到少；confirmed_seconds = 其中人确认 / 改过 / 自己加的部分 */
  categories: (ProjectCategory & { confirmed_seconds: number })[];
}

/** 可用数据（审核通过）的类别统计。projectIds 空 = 全部启用中的项目（跟导出训练集同一口径） */
export const getDatasetStats = (projectIds: number[] = []) =>
  request.get<never, DatasetStats>("/dashboard/dataset-stats", { params: { project_ids: projectIds.join(",") } });
