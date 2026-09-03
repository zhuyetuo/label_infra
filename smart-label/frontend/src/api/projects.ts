import request from "@/utils/request";
import type { Project } from "@/types";

export const listProjects = () => request.get<never, Project[]>("/projects");

export const createProject = (body: { name: string; description?: string }) =>
  request.post<never, Project>("/projects", body);

export const updateProject = (id: number, body: Partial<Pick<Project, "name" | "description" | "is_active">>) =>
  request.patch<never, Project>(`/projects/${id}`, body);

export const deleteProject = (id: number) => request.delete<never, null>(`/projects/${id}`);

/** 把项目下的任务一次性指派给某人；user_id 传 null 表示收回指派 */
export const assignProject = (id: number, userId: number | null, includeClaimed = false) =>
  request.post<never, { assigned: number; skipped: number }>(`/projects/${id}/assign`, {
    user_id: userId,
    include_claimed: includeClaimed,
  });
