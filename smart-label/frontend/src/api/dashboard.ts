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
