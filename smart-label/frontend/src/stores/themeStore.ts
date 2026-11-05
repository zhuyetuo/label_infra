import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 界面主题：明亮（默认）/ 暗黑。记在本机。
 * 切换时同时在 <html> 上写 data-theme：几张 uPlot 图（日常统计 / 跟踪表 / 阈值曲线）自己画坐标轴，
 * 认的就是这个属性，跟着换深浅色
 */
export type ThemeMode = "light" | "dark";

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

export const applyThemeAttr = (m: ThemeMode) => {
  document.documentElement.setAttribute("data-theme", m);
  document.documentElement.style.colorScheme = m;     // 原生滚动条、表单控件也跟着变
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "light",
      setMode: (m) => { applyThemeAttr(m); set({ mode: m }); },
    }),
    { name: "smart-label-theme", onRehydrateStorage: () => (s) => applyThemeAttr(s?.mode ?? "light") },
  ),
);
