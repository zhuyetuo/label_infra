import request from "@/utils/request";
import type { Task } from "@/types";

export const reviewQueue = () => request.get<never, Task[]>("/reviews/queue");

export const claimReview = (id: number) => request.post<never, Task>(`/reviews/${id}/claim`);

export const decideReview = (id: number, decision: "approved" | "rejected", comment?: string) =>
  request.post<never, Task>(`/reviews/${id}/decision`, { decision, comment });
