import request from "@/utils/request";
import type { Draft, Task, TaskType } from "@/types";

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

/** 已通过/已驳回的任务退回重标：轮次+1，上一轮标注内容原样带到新一轮 */
export const reopenTask = (id: number, comment?: string) =>
  request.post<never, Task>(`/tasks/${id}/reopen`, { comment });

export const claimTask = (id: number) => request.post<never, Task>(`/tasks/${id}/claim`);

/** 标注中途主动放弃任务：退回公共池，草稿保留，换人接手能接着标 */
export const releaseTask = (id: number) => request.post<never, Task>(`/tasks/${id}/release`);

export const heartbeat = (id: number) => request.patch<never, null>(`/tasks/${id}/heartbeat`);

export const getDraft = (id: number) => request.get<never, Draft>(`/tasks/${id}/draft`);

export const saveDraft = (
  id: number,
  items: { label_id: number; start_time_ms: number; end_time_ms: number; origin_item_id?: number }[]
) => request.put<never, null>(`/tasks/${id}/draft`, { items });

export const submitTask = (id: number) => request.post<never, Task>(`/tasks/${id}/submit`);

/** 批量给一批样本各建一个长任务，不用逐个点；已经建过任务的样本会跳过 */
export const bulkCreateTasks = (body: {
  project_id: number;
  sample_ids: number[];
  task_type: TaskType;
  assigned_to?: number;
}) =>
  request.post<never, { created: number; skipped: number; skipped_sample_ids: number[] }>(
    "/tasks/bulk",
    body
  );
