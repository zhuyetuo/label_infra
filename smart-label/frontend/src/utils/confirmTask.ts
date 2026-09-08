import { claimTask, getTask, submitTask } from "@/api/tasks";
import { claimReview, decideReview } from "@/api/reviews";
import type { Task } from "@/types";

/**
 * 「看完了，就这样」——一路把任务推到已通过。
 *
 * 皮肤评估那边复看抓挠时，看的其实就是任务上的片段；看完觉得没问题却还要跑去
 * 任务页认领、提交，再去审核页认领、通过，四步分散在两个页面。这里把这一串按
 * 任务当前状态补齐：
 *
 *   待认领/已驳回 → 认领 → 提交 → 认领审核 → 通过
 *
 * 每一步都是原有接口，权限也还是后端说了算（比如非管理员自己标的不能自己审，
 * claim_review 那边会挡下来）。中途某一步已经做过了就跳过，所以重复点也安全。
 */
export async function confirmTaskThrough(task: Task, userId?: number): Promise<Task> {
  let t = task;

  if (t.status === "APPROVED") return t;

  if (t.status === "PENDING_ASSIGN" || t.status === "REJECTED") {
    t = await claimTask(t.id);
  }
  if (t.status === "IN_PROGRESS") {
    // 提交用的是服务端存着的草稿（AI 预标注写进去的那份），这里不覆盖它——
    // 要改片段得在工作台里改完存草稿，再走这一步
    t = await submitTask(t.id);
  }
  if (t.status === "SUBMITTED" && t.reviewer_id !== userId) {
    t = await claimReview(t.id);
  }
  if (t.status === "SUBMITTED") {
    t = await decideReview(t.id, "approved");
  }
  // decideReview 返回的是决策后的任务，但状态字段各接口口径不一定齐，
  // 统一再拉一次，调用方拿到的就是库里真实的样子
  return getTask(t.id);
}
