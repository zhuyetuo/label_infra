import request from "@/utils/request";
import type { Task } from "@/types";

export const reviewQueue = () => request.get<never, Task[]>("/reviews/queue");

export const claimReview = (id: number) => request.post<never, Task>(`/reviews/${id}/claim`);

/** 审核中途主动放弃认领：任务退回待审核队列，换人接手 */
export const releaseReview = (id: number) => request.post<never, Task>(`/reviews/${id}/release`);

export const decideReview = (id: number, decision: "approved" | "rejected", comment?: string) =>
  request.post<never, Task>(`/reviews/${id}/decision`, { decision, comment });
