import { claimTask, getDraft, getTask, releaseTask, saveDraft, submitTask } from "@/api/tasks";
import { claimReview, decideReview } from "@/api/reviews";
import type { Task } from "@/types";

/**
 * 皮肤评估复看抓挠时，看完能下的两种结论。分成两个，是因为它们说的不是一回事：
 *
 * 1. confirmScratchOnly —— 「这几段抓挠我看了，是对的」。只把这个任务里指定类别
 *    （抓挠）的 AI 片段标成"已确认"，不碰活动/睡觉这些别的类别，也不碰「疑似
 *    抓挠」候选（那是另一批还没进正式片段的东西），任务状态也不动。
 * 2. approveWholeTask —— 「整份标注都没问题」。这才是真正的审核通过，认的是全部
 *    类别，任务就此关掉。
 *
 * 之前只有第 2 种、按钮却写着「确认无误」，说大了：复看时看的只有抓挠那几段。
 */

/** 这次确认的结果。光返回一个"确认了几段"的话，0 有好几种意思，提示写不清楚 */
export interface ConfirmScratchResult {
  /** 这次新确认的段数 */
  confirmed: number;
  /** 之前就已经确认过的 */
  already: number;
  /** 标成待定的：不能顺手认成对的，所以不算 */
  uncertain: number;
  /** 这个任务里 AI 标的这一类一共几段 */
  total: number;
}

/** 只确认某几个类别的 AI 片段。 */
export async function confirmScratchOnly(
  task: Task,
  labelIds: number[],
  userId?: number
): Promise<ConfirmScratchResult> {
  if (!labelIds.length) throw new Error("这个项目里没有「抓挠」这个标签");
  // 存草稿要求任务在自己名下且是标注中
  let t = task;
  const claimedHere = t.status === "PENDING_ASSIGN" || t.status === "REJECTED";
  if (claimedHere) t = await claimTask(t.id);
  if (t.status !== "IN_PROGRESS" || t.locked_by !== userId) {
    throw new Error("这个任务不在你名下（已提交或被别人认领），改不了片段");
  }

  const draft = await getDraft(t.id);
  const want = new Set(labelIds);
  const r: ConfirmScratchResult = { confirmed: 0, already: 0, uncertain: 0, total: 0 };
  const items = draft.items.map((i) => {
    // 分开数：0 段可以是"本来就没有抓挠"、"早就确认过了"、"全标成待定了"，
    // 这三种给人的提示完全不一样
    if (want.has(i.label_id) && i.source_type === "ai_generated") {
      r.total += 1;
      if (i.uncertain) r.uncertain += 1;
      else if (i.ai_confirmed) r.already += 1;
      else r.confirmed += 1;
    }
    return {
      label_id: i.label_id,
      start_time_ms: i.start_time_ms,
      end_time_ms: i.end_time_ms,
      origin_item_id: i.id,
      // 待定的不动：那是"看了拿不准"，不能顺手认成对的
      ai_confirmed: want.has(i.label_id) && !i.uncertain ? true : i.ai_confirmed,
      uncertain: i.uncertain,
    };
  });
  await saveDraft(t.id, items);
  // 认领只是为了能存草稿，确认完就还回去（草稿保留）。不管这次是不是这里认领的
  // ——从工作台点「认领并修改」改完再确认也走这条路，不放的话任务就一直挂在
  // 「标注中」，跟同一天别的时段状态不一致，看着像出了问题
  await releaseTask(t.id);
  return r;
}

/**
 * 「整份标注都没问题」——一路把任务推到已通过：
 *
 *   待认领/已驳回 → 认领 → 提交 → 认领审核 → 通过
 *
 * 每一步都是原有接口，权限还是后端说了算（非管理员自己标的不能自己审，
 * claim_review 会挡下来）。中途某一步已经做过了就跳过，重复点也安全。
 */
export async function approveWholeTask(task: Task, userId?: number): Promise<Task> {
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
