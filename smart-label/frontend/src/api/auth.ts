import request from "@/utils/request";
import type { UserInfo } from "@/stores/authStore";

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  must_change_password: boolean;
}

export const login = (username: string, password: string) =>
  request.post<never, TokenPair>("/auth/login", { username, password });

export const bootstrapAdmin = (username: string, display_name: string, password: string) =>
  request.post<never, null>("/auth/bootstrap-admin", { username, display_name, password });

export const bootstrapStatus = () => request.get<never, { needs_bootstrap: boolean }>("/auth/bootstrap-status");

export const getMe = () => request.get<never, UserInfo>("/users/me");

export const changePassword = (old_password: string, new_password: string) =>
  request.post<never, null>("/auth/change-password", { old_password, new_password });
