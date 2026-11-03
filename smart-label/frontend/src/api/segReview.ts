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
  /** 只看不短于这么多秒的 */
  min_sec?: number | null;
  /** long = 最长的排前面（长片段往往更干净） */
  order?: "time" | "long";
}) => request.get<never, SegQueue>("/segments/queue", { params });

export const segClaim = (body: {
  label_name: string; n: number; source?: "touched" | "all"; project_id?: number | null;
  min_sec?: number | null; order?: "time" | "long";
}) =>
  request.post<never, { claimed: number }>("/segments/claim", body);

export const segRelease = (ids?: number[]) =>
  request.post<never, { released: number }>("/segments/release", { ids: ids ?? null });

/** approved = 通过 / returned = 退回（note 必填）/ pending = 改好了、交回重审 */
export const segDecide = (id: number, decision: "approved" | "returned" | "pending", note?: string) =>
  request.post<never, { id: number; seg_status: SegStatus }>(`/segments/${id}/decide`, { decision, note: note ?? null });

export const segEdit = (id: number, body: { start_time_ms: number; end_time_ms: number; label_id?: number | null }) =>
  request.put<never, { id: number; start_time_ms: number; end_time_ms: number; label_id: number; seg_status: SegStatus }>(
    `/segments/${id}`, body);

/** 删掉一条片段（重复的 / 不要的）。审核员 / 管理员不用认领；从候选来的，候选一起标成排除 */
export const segDelete = (id: number) => request.delete<never, { id: number; deleted: boolean }>(`/segments/${id}`);

/** 一键去重：同类重叠的并成一条、父子压在一起的删粗的；类别冲突不动只报数 */
export const segDedupe = (taskId: number) =>
  request.post<never, { merged: number; removed_parent: number; conflicts_left: number }>("/segments/dedupe", { task_id: taskId });

/** 从 at_ms 拆成两条（类别不变，两条都回到待审）。退回原因是「应该拆成几段」时用 */
export const segSplit = (id: number, atMs: number) =>
  request.post<never, { left: { id: number; start_time_ms: number; end_time_ms: number };
    right: { id: number; start_time_ms: number; end_time_ms: number }; label_id: number }>(
    `/segments/${id}/split`, { at_ms: Math.round(atMs) });

/** 退回给我、还没改好的片段条数（总数 + 按项目）。标注员的红色数字用 */
export const segReturnedSummary = () =>
  request.get<never, { total: number; by_project: Record<number, number> }>("/segments/returned-summary");
