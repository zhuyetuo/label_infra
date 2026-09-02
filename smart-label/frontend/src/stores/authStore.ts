import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface UserInfo {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "annotator" | "reviewer";
  must_change_password: boolean;
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
      setAuth: (accessToken, refreshToken, userInfo) => set({ accessToken, refreshToken, userInfo }),
      setUserInfo: (userInfo) => set({ userInfo }),
      clearAuth: () => set({ accessToken: null, refreshToken: null, userInfo: null }),
    }),
    { name: "smart-label-auth" }
  )
);
