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

/** 复查发现别人通过的这条有问题：撤销通过、领给原来通过它的人重审（管理员） */
export const segSendBackReviewer = (id: number, note?: string) =>
  request.post<never, { id: number; sent_to: number; seg_status: SegStatus }>(`/segments/${id}/send-back-reviewer`, { note: note ?? null });

export const segEdit = (id: number, body: { start_time_ms: number; end_time_ms: number; label_id?: number | null }) =>
  request.put<never, { id: number; start_time_ms: number; end_time_ms: number; label_id: number; seg_status: SegStatus }>(
    `/segments/${id}`, body);

/** 查看标注（只读）里直接补一段：审核员 / 管理员，不用认领，直接落库、算通过 */
export const segCreate = (body: { task_id: number; label_id: number; start_time_ms: number; end_time_ms: number }) =>
  request.post<never, { id: number; start_time_ms: number; end_time_ms: number; label_id: number; seg_status: SegStatus }>(
    "/segments/create", body);

/** 打标记（只看模式也能打，不动类别起止、不改审核状态）。marks 空数组 = 清掉 */
export const segMarks = (id: number, marks: string[], note?: string | null) =>
  request.put<never, { id: number; marks: string | null; mark_note: string | null }>(`/segments/${id}/marks`, { marks, note: note ?? null });

/** 删掉一条片段（重复的 / 不要的）。审核员 / 管理员不用认领；从候选来的，候选一起标成排除 */
export const segDelete = (id: number) => request.delete<never, { id: number; deleted: boolean }>(`/segments/${id}`);

/** 一键去重：同类重叠的并成一条、父子压在一起的删粗的、活动压在具体行为下的挖空切分；类别冲突不动只报数 */
export const segDedupe = (taskId: number) =>
  request.post<never, { merged: number; removed_parent: number; carved_motion?: number; conflicts_left: number }>(
    "/segments/dedupe", { task_id: taskId });

/** 挖空活动：把压在具体行为下面的「活动 / 静止/休息」按重叠处切分成多段 */
export const segCarveMotion = (taskId: number) =>
  request.post<never, { carved: number; created: number; removed: number }>(
    "/segments/carve-motion", { task_id: taskId });

/** 合并相邻同类别片段：把指定的多组同类别片段各自合为起止并集 */
export const segMergeAdjacent = (taskId: number, groups: number[][]) =>
  request.post<never, { groups_merged: number; removed: number }>(
    "/segments/merge-adjacent", { task_id: taskId, groups });

/** 智能检测三轴加速度全为 0（信号中断）的区间，自动切开重叠片段并标出「无信号」 */
export const segTrimZeroSignal = (body: {
  task_id: number;
  start_ms?: number | null;
  end_ms?: number | null;
  item_id?: number | null;
  min_zero_ms?: number;
}) =>
  request.post<never, {
    zero_runs: number;
    items_carved: number;
    items_deleted: number;
    pieces_created: number;
    no_signal_added: number;
  }>("/segments/trim-zero-signal", body);

/** 解决两条重叠/冲突片段：winner 保留，从 loser 中挖掉重叠部分（裁剪 / 拆分 / 删除） */
export const segResolveOverlap = (winnerId: number, loserId: number) =>
  request.post<never, { action: "deleted" | "trimmed" | "split" | "noop"; winner_id: number; loser_id: number; pieces_left: number }>(
    "/segments/resolve-overlap", { winner_id: winnerId, loser_id: loserId });

/** 整个项目一键去重（每个任务各跑一遍上面那套）。只给审核员 / 管理员 */
export const segDedupeProject = (projectId: number) =>
  request.post<never, { tasks: number; tasks_changed: number; merged: number; removed_parent: number; conflicts_left: number }>(
    "/segments/dedupe-project", { project_id: projectId }, { timeout: 300000 } as never);

/** 整个项目一键批量智能处理：去无信号 → 去重 → 合并 → 再去重 → 再合并 */
export const segSmartCleanProject = (projectId: number, maxGapMs = 1500) =>
  request.post<never, {
    tasks: number;
    tasks_changed: number;
    zero_runs: number;
    zero_carved: number;
    zero_deleted: number;
    no_signal_added: number;
    dedupe_merged: number;
    removed_parent: number;
    carved_motion: number;
    adj_groups_merged: number;
    adj_removed: number;
    conflicts_left: number;
  }>("/segments/smart-clean-project", { project_id: projectId, max_gap_ms: maxGapMs }, { timeout: 600000 } as never);

export type SmartCleanScan = {
  scanned_at: string;
  elapsed_sec: number;
  projects_total: number;
  projects_need_clean: number;
  tasks_total: number;
  tasks_need_clean: number;
  n_carve: number;
  n_dedupe: number;
  n_merge: number;
  n_conflicts: number;
  project_ids: number[];
  by_project: { project_id: number; project_name: string; tasks_need: number; n_carve: number; n_dedupe: number; n_merge: number; n_conflicts: number }[];
};

export type SmartCleanProgress = {
  status: "idle" | "running" | "done" | "cancelled" | "error";
  phase?: "idle" | "prescan" | "csv_scan" | "clean";
  scan_total?: number;
  scan_done?: number;
  projects_total: number;
  projects_done: number;
  tasks_total: number;
  tasks_done: number;
  current_project: string | null;
  started_at: number | null;
  finished_at: number | null;
  elapsed_sec: number;
  eta_sec: number | null;
  error: string | null;
  summary: {
    tasks_changed: number;
    zero_runs: number;
    zero_carved: number;
    zero_deleted: number;
    no_signal_added: number;
    carved_motion: number;
    dedupe_merged: number;
    removed_parent: number;
    adj_groups_merged: number;
    adj_removed: number;
    conflicts_left: number;
  };
};

export const segSmartCleanScanGet = () =>
  request.get<never, SmartCleanScan>("/segments/smart-clean/scan");

export const segSmartCleanScanNow = () =>
  request.post<never, SmartCleanScan>("/segments/smart-clean/scan");

export const segSmartCleanStart = (projectIds?: number[] | null, maxGapMs = 1500) =>
  request.post<never, { started: boolean; progress: SmartCleanProgress }>(
    "/segments/smart-clean/start",
    { project_ids: projectIds && projectIds.length ? projectIds : null, max_gap_ms: maxGapMs },
  );

export const segSmartCleanProgress = () =>
  request.get<never, SmartCleanProgress>("/segments/smart-clean/progress");

export const segSmartCleanCancel = () =>
  request.post<never, { cancelled: boolean }>("/segments/smart-clean/cancel");

/** 从 at_ms 拆成两条（类别不变，两条都回到待审）。退回原因是「应该拆成几段」时用 */
export const segSplit = (id: number, atMs: number) =>
  request.post<never, { left: { id: number; start_time_ms: number; end_time_ms: number };
    right: { id: number; start_time_ms: number; end_time_ms: number }; label_id: number }>(
    `/segments/${id}/split`, { at_ms: Math.round(atMs) });

/** 退回给我、还没改好的片段条数（总数 + 按项目）。标注员的红色数字用 */
export const segReturnedSummary = () =>
  request.get<never, { total: number; by_project: Record<number, number> }>("/segments/returned-summary");
