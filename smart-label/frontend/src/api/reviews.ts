import request from "@/utils/request";
import type { Task } from "@/types";

export const reviewQueue = () => request.get<never, Task[]>("/reviews/queue");

export const claimReview = (id: number) => request.post<never, Task>(`/reviews/${id}/claim`);

/** 审核中途主动放弃认领：任务退回待审核队列，换人接手 */
export const releaseReview = (id: number) => request.post<never, Task>(`/reviews/${id}/release`);

export const decideReview = (id: number, decision: "approved" | "rejected", comment?: string) =>
  request.post<never, Task>(`/reviews/${id}/decision`, { decision, comment });

/** 超级管理员一键通过待审核任务；projectId 不给 = 全部项目。别的审核员正在审的会跳过 */
export interface BulkApproveResult {
  approved: number;
  skipped: number;
  /** 别的审核员正在审 */
  skipped_locked: number;
  /** 还有 AI 片段没人确认 / 改过 */
  skipped_unconfirmed: number;
  /** 还有疑似片段没判 */
  skipped_cand_pending: number;
}
export const bulkApprove = (projectId?: number) =>
  request.post<never, BulkApproveResult>("/reviews/bulk-approve", projectId != null ? { project_id: projectId } : {});

/** 已通过的退回待审核，原样（轮次、片段、标注员都不变）。taskIds 给了就是这几条；
 *  否则按项目（不给 = 全部项目），onlyBulk 时只退「批量通过」的 */
export const unapprove = (opts: { taskIds?: number[]; projectId?: number; onlyBulk?: boolean }) =>
  request.post<never, { reverted: number }>("/reviews/unapprove", {
    task_ids: opts.taskIds,
    project_id: opts.projectId,
    only_bulk: opts.onlyBulk ?? true,
  });

export interface ApprovedSummary {
  project_id: number;
  project_name: string;
  approved: number;
  bulk_approved: number;
}
export const approvedSummary = () => request.get<never, ApprovedSummary[]>("/reviews/approved-summary");
