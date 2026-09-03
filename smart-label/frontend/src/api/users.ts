import request from "@/utils/request";
import type { AppUser } from "@/types";

export const listUsers = () => request.get<never, AppUser[]>("/users");

export const createUser = (body: {
  username: string;
  display_name: string;
  email?: string;
  role: AppUser["role"];
  is_outsourced?: boolean;
}) => request.post<never, { user: AppUser; temp_password: string }>("/users", body);

export const updateUser = (id: number, body: Partial<Pick<AppUser, "is_active" | "role" | "is_outsourced">>) =>
  request.patch<never, AppUser>(`/users/${id}`, body);

export const deleteUser = (id: number) => request.delete<never, null>(`/users/${id}`);

/** 重置密码，返回一次性临时密码（系统只存哈希，看不到原密码） */
export const resetUserPassword = (id: number) =>
  request.post<never, { username: string; temp_password: string }>(`/users/${id}/reset-password`);
