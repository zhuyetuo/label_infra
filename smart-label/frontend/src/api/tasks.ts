import request from "@/utils/request";
import type { Draft, LabelItem, Task, TaskType } from "@/types";

export const listTasks = (projectId?: number) =>
  request.get<never, Task[]>("/tasks", {
    params: projectId == null ? undefined : { project_id: projectId },
  });

export const getTask = (id: number) => request.get<never, Task>(`/tasks/${id}`);

/** 只拉这几个任务的列表行（带片段统计）：改了一个任务只刷那一行，不用整份重拉 */
/** 轻量列表：只有任务本身 + 样本 / 指派人名字，不带片段统计。项目页先用它把每个项目的数秒出来 */
export const listTasksLite = () => request.get<never, Task[]>("/tasks", { params: { lite: true } });

/** 每个项目的完成情况（服务端按项目汇总好）。任务页项目行用，不用为它拉全部任务的统计 */
export interface ProjectProgress { segs: number; seg_pending: number; cands: number; cand_pending: number }
export const getTasksProgress = (mine = false) =>
  request.get<never, Record<string, ProjectProgress>>("/tasks/progress", { params: mine ? { mine: true } : undefined });

/** 某个类别（默认抓挠，含子类）每个项目的片段审核进度：多少段、通过、退回、还没审 */
export interface LabelReviewCounts { n: number; approved: number; returned: number; unreviewed: number; marked?: number }
/** 某项目在这个审核时间段内（可限定是谁）通过的片段：{task_id: {n, by_label}} */
export const getApprovalsInRange = (projectId: number, from?: string | null, to?: string | null, reviewerId?: number | null) =>
  request.get<never, Record<string, { n: number; by_label: Record<string, number> }>>("/tasks/approvals-in-range", {
    params: { project_id: projectId, date_from: from || undefined, date_to: to || undefined, reviewer_id: reviewerId || undefined },
  });
/** 现在重点补什么（全平台一个，管理员在项目页顶部切）。labels：统计哪几个类别（各自含子类） */
export interface LabelFocus {
  /** neg：负例（除了抓挠都是）；title：显示名，负例是「负例·舔」 */
  key: string; name: string; title?: string; neg?: boolean; labels: string[]; hint: string;
  by?: string | null; at?: string | null;
  options: { key: string; name: string; title?: string; neg?: boolean; labels: string[]; hint: string }[];
}
export const getLabelFocus = () => request.get<never, LabelFocus>("/tasks/label-focus", { silent: true } as object);
export const setLabelFocus = (key: string) => request.put<never, LabelFocus>("/tasks/label-focus", { key });
/** label：一个类别，或逗号分隔的几个（合在一起算） */
export const getLabelReview = (label = "抓挠") =>
  request.get<never, { label: string; projects: Record<string, LabelReviewCounts>; total: LabelReviewCounts;
    /** 每个项目打了 🔖 备忘的段数（全部类别），by_kind 按种类拆：compound / boundary / av_mismatch / other */
    marks?: Record<string, { n: number; by_kind: Record<string, number> }>;
    /** 每个项目这几类**待判的疑似片段**（候选，没确认也没排除，当前轮）；cand_total 是全部项目加起来 */
    candidates?: Record<string, number>; cand_total?: number }>(
    "/tasks/label-review", { params: { label }, silent: true } as object);

export const listTasksByIds = (ids: number[]) =>
  request.get<never, Task[]>("/tasks", { params: { ids: ids.join(",") } });

export const createTask = (body: {
  project_id: number;
  sample_id: number;
  task_type: TaskType;
  segment_start_ms?: number;
  segment_end_ms?: number;
  assigned_to?: number;
}) => request.post<never, Task>("/tasks", body);

export const deleteTask = (id: number) => request.delete<never, null>(`/tasks/${id}`);
export const deleteTasksBatch = (task_ids: number[]) =>
  request.post<never, { count: number }>("/tasks/delete-batch", { task_ids });

/** 已通过/已驳回的任务退回重标：轮次+1，上一轮标注内容原样带到新一轮 */
/** 给一条片段标「有问题」（审核 / 管理员）；note 传 null = 清掉（标注员改好了也能清） */
export const setReviewNote = (taskId: number, itemId: number, note: string | null) =>
  request.put<never, LabelItem>(`/tasks/${taskId}/items/${itemId}/review-note`, { note });

export const reopenTask = (id: number, comment?: string) =>
  request.post<never, Task>(`/tasks/${id}/reopen`, { comment });

export const claimTask = (id: number) => request.post<never, Task>(`/tasks/${id}/claim`);

/** 提交之后自己再改：已提交 / 已通过 / 已驳回 → 回到标注中、锁给自己，轮次和片段不变 */
export const editAgain = (id: number) => request.post<never, Task>(`/tasks/${id}/edit-again`);

/** 标注中途主动放弃任务：退回公共池，草稿保留，换人接手能接着标 */
export const releaseTask = (id: number) => request.post<never, Task>(`/tasks/${id}/release`);

/** 一次领完项目里所有待认领（且没预指派给别人）的任务 */
export const claimAllTasks = (projectId: number) =>
  request.post<never, { count: number }>(`/tasks/claim-all`, { project_id: projectId });

/** 一次放弃项目里自己名下所有标注中的任务，草稿保留 */
export const releaseAllTasks = (projectId: number) =>
  request.post<never, { count: number }>(`/tasks/release-all`, { project_id: projectId });

export const heartbeat = (id: number) => request.patch<never, null>(`/tasks/${id}/heartbeat`);

// 每个任务上次拉草稿时服务器的时间。存草稿时带上：这之后别人（管理员在片段弹窗里直接改）
// 动过的片段，服务器不拿这边的旧版本覆盖，并回一个 kept_others，这边据此重新拉
const loadedAt = new Map<number, string>();

/** 存草稿时发现别人刚改过片段：工作台听这个事件重新拉一遍 */
export const DRAFT_STALE_EVENT = "draft-stale";

export const getDraft = async (id: number) => {
  const d = await request.get<never, Draft>(`/tasks/${id}/draft`);
  if (d.server_time) loadedAt.set(id, d.server_time);
  return d;
};

export const saveDraft = async (
  id: number,
  items: {
    label_id: number;
    start_time_ms: number;
    end_time_ms: number;
    origin_item_id?: number;
    source_type?: "ai_generated" | "human_added";
    ai_confidence?: number | null;
    ai_confirmed?: boolean;
    uncertain?: boolean;
    uncertain_reason?: string | null;
    marks?: string;
    mark_note?: string;
  }[]
) => {
  const r = await request.put<never, { kept_others?: number } | null>(`/tasks/${id}/draft`, {
    items,
    loaded_at: loadedAt.get(id) ?? null,
  });
  if (r?.kept_others) window.dispatchEvent(new CustomEvent(DRAFT_STALE_EVENT, { detail: { taskId: id, n: r.kept_others } }));
  return r;
};

export const submitTask = (id: number) => request.post<never, Task>(`/tasks/${id}/submit`);

/** 批量给一批样本各建一个长任务，不用逐个点；已经建过任务的样本会跳过 */
export const bulkCreateTasks = (body: {
  project_id: number;
  sample_ids: number[];
  task_type: TaskType;
  assigned_to?: number;
  // 可以是 stable/viterbi/raw，也可以是端侧模型 edge:<标签>
  infer_mode?: string | null;
}) =>
  request.post<never, { created: number; skipped: number; skipped_sample_ids: number[] }>(
    "/tasks/bulk",
    body,
    // 一天上千个样本，插完要几十秒；全局超时是 15s，不放宽的话请求会被
    // axios 掐断——服务端其实还在建，前端却报错，看着像失败了
    { timeout: 300_000 }
  );
