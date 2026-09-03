import { Tag } from "antd";
import type { TaskStatus } from "@/types";

// 状态在任务页、项目页、审核页都要显示，中文名和配色统一放这儿，
// 免得各页面各写一份、颜色还对不上。
export const TASK_STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  PENDING_ASSIGN: { label: "待认领", color: "gold" },
  IN_PROGRESS: { label: "标注中", color: "blue" },
  SUBMITTED: { label: "待审核", color: "purple" },
  APPROVED: { label: "已通过", color: "green" },
  REJECTED: { label: "已驳回", color: "red" },
};

export function TaskStatusTag({ status }: { status: TaskStatus }) {
  const meta = TASK_STATUS_META[status];
  if (!meta) return <Tag>{status}</Tag>;
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

// 角色和标注模式也一并中文化，页面上不该出现 annotator / from_scratch 这种原始值
export const ROLE_META: Record<string, { label: string; color: string }> = {
  admin: { label: "管理员", color: "red" },
  annotator: { label: "标注员", color: "blue" },
  reviewer: { label: "审核员", color: "green" },
};

export function RoleTag({ role }: { role: string }) {
  const meta = ROLE_META[role];
  if (!meta) return <Tag>{role}</Tag>;
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const TASK_TYPE_LABEL: Record<string, string> = {
  from_scratch: "从零标注",
  ai_assisted: "AI预标注+人工修改",
};
