import request from "@/utils/request";
import type { AppUser } from "@/types";

export const listUsers = () => request.get<never, AppUser[]>("/users");

export const createUser = (body: {
  username: string;
  display_name: string;
  email?: string;
  role: "admin" | "annotator" | "reviewer";
  is_outsourced?: boolean;
}) => request.post<never, { user: AppUser; temp_password: string }>("/users", body);

export const updateUser = (id: number, body: Partial<Pick<AppUser, "is_active" | "role" | "is_outsourced">>) =>
  request.patch<never, AppUser>(`/users/${id}`, body);
