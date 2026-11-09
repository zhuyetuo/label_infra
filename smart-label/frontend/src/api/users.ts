import request from "@/utils/request";
import type { AppUser, FeatureDef } from "@/types";

export const listUsers = () => request.get<never, AppUser[]>("/users");

export const createUser = (body: {
  username: string;
  display_name: string;
  email?: string;
  role: AppUser["role"];
  is_outsourced?: boolean;
  remark?: string;
}) => request.post<never, { user: AppUser; temp_password: string }>("/users", body);

export const updateUser = (
  id: number,
  body: Partial<Pick<AppUser, "is_active" | "role" | "is_outsourced" | "remark" | "username" | "display_name" | "permissions">>
) => request.patch<never, AppUser>(`/users/${id}`, body);

/** 能单独开给账号的功能清单 */
export const listFeatures = () => request.get<never, FeatureDef[]>("/users/features");

export const deleteUser = (id: number) => request.delete<never, null>(`/users/${id}`);

/** 超级管理员看某人现在的密码；更新前设的、系统没存就是 null */
export const getTempPassword = (id: number) =>
  request.get<never, { username: string; temp_password: string | null }>(`/users/${id}/temp-password`);

/** 重置密码，返回临时密码 */
export const resetUserPassword = (id: number, password?: string) =>
  request.post<never, { username: string; temp_password: string }>(`/users/${id}/reset-password`, { password: password || null });
