import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface UserInfo {
  id: number;
  username: string;
  display_name: string;
  role: "super_admin" | "admin" | "annotator" | "reviewer";
  must_change_password: boolean;
  /** 访客：页面跟管理员一样全都能看，但改不了（后端拦掉所有修改） */
  readOnly?: boolean;
  /** 单独开的功能（见后端 app/core/permissions.py）。管理员不看这个，什么都能用 */
  permissions?: string[];
}

/** 这个账号能不能用某项功能：管理员全能用，其他人看单独开的那几项（含编辑就带查看） */
export function hasFeature(user: UserInfo | null, ...keys: string[]): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "super_admin") return true;
  const own = new Set(user.permissions ?? []);
  if (own.has("dogs_edit")) own.add("dogs_view");
  return keys.some((k) => own.has(k));
}

/** 后端 /users/me 返回的 role 可能是 viewer（访客）：前端当管理员显示全部菜单和页面，打上 readOnly */
export function normalizeUserInfo(u: Omit<UserInfo, "role"> & { role: string; read_only?: boolean }): UserInfo {
  if (u.role === "viewer" || u.read_only) return { ...u, role: "admin", readOnly: true };
  return { ...(u as UserInfo), readOnly: false };
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userInfo: UserInfo | null;
  setAuth: (accessToken: string, refreshToken: string, userInfo: UserInfo | null) => void;
  setUserInfo: (userInfo: UserInfo) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      setAuth: (accessToken, refreshToken, userInfo) =>
        set({ accessToken, refreshToken, userInfo: userInfo && normalizeUserInfo(userInfo) }),
      setUserInfo: (userInfo) => set({ userInfo: normalizeUserInfo(userInfo) }),
      clearAuth: () => set({ accessToken: null, refreshToken: null, userInfo: null }),
    }),
    { name: "smart-label-auth" }
  )
);
