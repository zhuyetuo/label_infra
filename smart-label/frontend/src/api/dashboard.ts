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
}

export const listAnnotatorWork = (dateFrom: string, dateTo: string, userId?: number) =>
  request.get<never, AnnotatorWorkRow[]>("/dashboard/annotator-work", {
    params: { date_from: dateFrom, date_to: dateTo, ...(userId ? { user_id: userId } : {}) },
  });
