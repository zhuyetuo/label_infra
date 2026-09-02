import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ProjectState {
  /** 当前选中的项目，任务页和标签页共用；换页面不会丢，刷新也还在 */
  currentProjectId: number | null;
  setCurrentProjectId: (id: number | null) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      currentProjectId: null,
      setCurrentProjectId: (id) => set({ currentProjectId: id }),
    }),
    { name: "smart-label-project" }
  )
);
