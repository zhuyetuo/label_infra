import { Tag } from "antd";
import type { UserRole } from "@/types";

/** 角色 → 颜色：列表里按人上色，超管/管理员/标注员/审核员一眼分开 */
export const ROLE_COLOR: Record<UserRole, string> = {
  super_admin: "purple",
  admin: "geekblue",
  annotator: "green",
  reviewer: "orange",
};
export const ROLE_LABEL: Record<UserRole, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  annotator: "标注员",
  reviewer: "审核员",
};

export function UserTag({ name, role, me }: { name: string; role?: UserRole | null; me?: boolean }) {
  return (
    <Tag color={role ? ROLE_COLOR[role] : undefined} title={role ? ROLE_LABEL[role] : undefined} style={{ marginRight: 0 }}>
      {name}
      {me ? "（我）" : ""}
    </Tag>
  );
}
