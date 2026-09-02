import request from "@/utils/request";
import type { Project } from "@/types";

export const listProjects = () => request.get<never, Project[]>("/projects");

export const createProject = (body: { name: string; description?: string }) =>
  request.post<never, Project>("/projects", body);

export const updateProject = (id: number, body: Partial<Pick<Project, "name" | "description" | "is_active">>) =>
  request.patch<never, Project>(`/projects/${id}`, body);

export const deleteProject = (id: number) => request.delete<never, null>(`/projects/${id}`);
