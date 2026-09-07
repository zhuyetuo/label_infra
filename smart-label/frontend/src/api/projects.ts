import request from "@/utils/request";
import type { Project } from "@/types";

export const listProjects = () => request.get<never, Project[]>("/projects");

export const createProject = (body: { name: string; description?: string }) =>
  request.post<never, Project>("/projects", body);

export const updateProject = (id: number, body: Partial<Pick<Project, "name" | "description" | "is_active">>) =>
  request.patch<never, Project>(`/projects/${id}`, body);

export const deleteProject = (id: number) => request.delete<never, null>(`/projects/${id}`);

export interface PrelabelProgress {
  status: "idle" | "running" | "done" | "error";
  project_id: number;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  current_task_id: number | null;
  current_sample_code: string | null;
  detail: string[];
  unmatched_labels: string[];
  error_message: string | null;
  elapsed_sec: number;
  estimated_remaining_sec: number | null;
  ai_wait_sec: number;
  batches_done: number;
  finished_at: number | null;
}

/** 项目下待认领/标注中且没人动过的任务批量跑 AI 预标注（后台），用 status 轮询进度 */
export type InferMode = "stable" | "raw";

export const startProjectPrelabel = (id: number, overwriteAi = false, mode: InferMode = "stable") =>
  request.post<never, { started: boolean; queued: boolean }>(`/projects/${id}/ai-prelabel`, {
    overwrite_ai: overwriteAi,
    mode,
  });

export const getProjectPrelabelStatus = (id: number) =>
  request.get<never, PrelabelProgress>(`/projects/${id}/ai-prelabel/status`);

/** 跑完一次记一条：总耗时、AI 等待耗时、数量，慢了好拿数字去反馈 */
export interface PrelabelRun {
  id: number;
  finished_at: string | null;
  status: string;
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  elapsed_sec: number;
  ai_wait_sec: number;
  batches: number;
  batch_size: number;
  avg_sec_per_task: number | null;
  unmatched_labels: string[];
  error_message: string | null;
}

export const getProjectPrelabelHistory = (id: number) =>
  request.get<never, PrelabelRun[]>(`/projects/${id}/ai-prelabel/history`);

/** 把项目下的任务一次性指派给某人；user_id 传 null 表示收回指派 */
export const assignProject = (id: number, userId: number | null, includeClaimed = false) =>
  request.post<never, { assigned: number; skipped: number }>(`/projects/${id}/assign`, {
    user_id: userId,
    include_claimed: includeClaimed,
  });
