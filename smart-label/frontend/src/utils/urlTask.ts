import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

// 把"当前打开的标注工作台是哪个任务"记到 URL 的 ?task=ID 里：刷新页面/分享链接
// 都能直接回到这个任务，而不是回到列表从头找。工作台本身是个由 state 驱动的
// Modal，state 一刷新就没了，URL 是唯一能扛住刷新的地方。
//
// 用法：useUrlTask(tasks, openTaskId, (task) => 打开工作台)
//   - tasks 列表加载完、URL 里有 task 且还没打开时，自动调 open 打开
//   - openTaskId 变化时同步写/清 URL 参数（用 replace，不往历史栈里塞一堆）
export function useUrlTask<T extends { id: number }>(
  tasks: T[] | undefined,
  openTaskId: number | null,
  open: (task: T) => void
): void {
  const [params, setParams] = useSearchParams();
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current || !tasks) return;
    const raw = params.get("task");
    if (!raw) {
      restored.current = true;
      return;
    }
    const task = tasks.find((t) => t.id === Number(raw));
    restored.current = true;
    if (task) open(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  useEffect(() => {
    if (!restored.current) return;
    const current = params.get("task");
    const next = openTaskId == null ? null : String(openTaskId);
    if (current === next) return;
    const p = new URLSearchParams(params);
    if (next == null) p.delete("task");
    else p.set("task", next);
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskId]);
}
