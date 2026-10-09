import request from "@/utils/request";
import type { Task } from "@/types";

export const reviewQueue = () => request.get<never, Task[]>("/reviews/queue");

export const claimReview = (id: number) => request.post<never, Task>(`/reviews/${id}/claim`);

/** 审核中途主动放弃认领：任务退回待审核队列，换人接手 */
export const releaseReview = (id: number) => request.post<never, Task>(`/reviews/${id}/release`);

export const decideReview = (id: number, decision: "approved" | "rejected", comment?: string) =>
  request.post<never, Task>(`/reviews/${id}/decision`, { decision, comment });

/** 超级管理员一键通过待审核任务；projectId 不给 = 全部项目。别的审核员正在审的会跳过 */
export const bulkApprove = (projectId?: number) =>
  request.post<never, { approved: number; skipped: number }>("/reviews/bulk-approve", projectId != null ? { project_id: projectId } : {});
