import request from "@/utils/request";
import type { Draft, Task, TaskType } from "@/types";

export const listTasks = () => request.get<never, Task[]>("/tasks");

export const getTask = (id: number) => request.get<never, Task>(`/tasks/${id}`);

export const createTask = (body: {
  sample_id: number;
  task_type: TaskType;
  segment_start_ms?: number;
  segment_end_ms?: number;
  assigned_to?: number;
}) => request.post<never, Task>("/tasks", body);

export const deleteTask = (id: number) => request.delete<never, null>(`/tasks/${id}`);

export const claimTask = (id: number) => request.post<never, Task>(`/tasks/${id}/claim`);

export const heartbeat = (id: number) => request.patch<never, null>(`/tasks/${id}/heartbeat`);

export const getDraft = (id: number) => request.get<never, Draft>(`/tasks/${id}/draft`);

export const saveDraft = (
  id: number,
  items: { label_id: number; start_time_ms: number; end_time_ms: number; origin_item_id?: number }[]
) => request.put<never, null>(`/tasks/${id}/draft`, { items });

export const submitTask = (id: number) => request.post<never, Task>(`/tasks/${id}/submit`);
