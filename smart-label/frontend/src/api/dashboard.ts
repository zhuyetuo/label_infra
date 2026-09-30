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
export interface EffUser {
  user_id: number;
  user_name: string;
  categories: EffCategory[];
  days: { day: string; actions: number; work_seconds: number }[];
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
export interface Workforce {
  ledger: LedgerRow[];
  efficiency: EffUser[];
  estimate: EstimateRow[];
  gap_max_seconds: number;
}
export const getWorkforce = (dateFrom: string, dateTo: string) =>
  request.get<never, Workforce>("/dashboard/workforce", { params: { date_from: dateFrom, date_to: dateTo } });
