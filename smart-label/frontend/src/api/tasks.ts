import request from "@/utils/request";
import type { Draft, LabelItem, Task, TaskType } from "@/types";

export const listTasks = (projectId?: number) =>
  request.get<never, Task[]>("/tasks", {
    params: projectId == null ? undefined : { project_id: projectId },
  });

export const getTask = (id: number) => request.get<never, Task>(`/tasks/${id}`);

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
