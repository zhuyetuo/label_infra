import request from "@/utils/request";

/** 片段审核里的一条片段（跨项目、跨任务） */
export interface SegItem {
  id: number;
  task_id: number;
  task_status: string;
  project_id: number;
  project_name: string;
  sample_code: string;
  label_id: number;
  label_name: string;
  start_time_ms: number;
  end_time_ms: number;
  source_type: "ai_generated" | "human_added";
  ai_confirmed: boolean;
  is_modified: boolean;
  ai_confidence: number | null;
  from_candidate_id: number | null;
  /** pending = 待审 / approved = 通过 / returned = 退回 */
  seg_status: SegStatus;
  /** 退回原因 */
  review_note: string | null;
  review_flag_by_name: string | null;
  seg_reviewed_by_name: string | null;
  seg_reviewed_at: string | null;
  /** 谁领着（没过期的） */
  claimed_by: number | null;
  claimed_by_name: string | null;
  n_boundary_edits: number;
}

export type SegStatus = "pending" | "returned" | "approved";

export interface SegQueue {
  counts: Record<SegStatus, number>;
  /** 我领着的条数 */
  mine: number;
  items: SegItem[];
}

export const segQueue = (params: {
  label_name?: string | null;
  seg_status?: SegStatus | "all";
  /** touched = 只看人碰过的（默认）；all = 含没人看过的 AI 片段 */
  source?: "touched" | "all";
  project_id?: number | null;
  mine?: boolean;
  limit?: number;
}) => request.get<never, SegQueue>("/segments/queue", { params });

export const segClaim = (body: { label_name: string; n: number; source?: "touched" | "all"; project_id?: number | null }) =>
  request.post<never, { claimed: number }>("/segments/claim", body);

export const segRelease = (ids?: number[]) =>
  request.post<never, { released: number }>("/segments/release", { ids: ids ?? null });

/** approved = 通过 / returned = 退回（note 必填）/ pending = 改好了、交回重审 */
export const segDecide = (id: number, decision: "approved" | "returned" | "pending", note?: string) =>
  request.post<never, { id: number; seg_status: SegStatus }>(`/segments/${id}/decide`, { decision, note: note ?? null });

export const segEdit = (id: number, body: { start_time_ms: number; end_time_ms: number; label_id?: number | null }) =>
  request.put<never, { id: number; start_time_ms: number; end_time_ms: number; label_id: number; seg_status: SegStatus }>(
    `/segments/${id}`, body);
