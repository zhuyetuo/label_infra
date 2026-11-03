import type { LabelDefinition, Task } from "@/types";

/** 项目片段汇总里的一行：数都含它底下全部细类 */
export interface LabelTotal {
  label: LabelDefinition;
  n: number;
  pending: number;
  tasksN: number;
  okN: number;
  retN: number;
  depth: number;
  hasKids: boolean;
}

/**
 * 按层级汇总各类别：抓挠 = 抓挠 + 头颈耳 + 肩胸 + 躯干…（段数 / 待确认 / 通过 / 退回都加起来，
 * 任务数按含任一细类算）。只摆大类，open 里的展开到下一层。
 * 上级按 parent_id；老标签没挂上级、名字是「抓挠-头颈耳」的按前缀认。
 */
export function buildLabelTotals(labels: LabelDefinition[], tasks: Task[], open: Set<number>, flat = false): LabelTotal[] {
  if (flat) {
    // 「全部标签」：老样子，每个标签一条、只算它自己（不含细类），按项目里标签的顺序
    const out: LabelTotal[] = [];
    for (const l of labels) {
      let n = 0, pending = 0, tasksN = 0, okN = 0, retN = 0;
      for (const t of tasks) {
        const c = t.label_counts?.[l.id];
        if (!c?.n) continue;
        n += c.n; pending += c.ai_pending; tasksN += 1;
        okN += c.approved ?? 0; retN += c.returned ?? 0;
      }
      if (n) out.push({ label: l, n, pending, tasksN, okN, retN, depth: 0, hasKids: false });
    }
    return out;
  }
  const byName = new Map(labels.map((l) => [l.display_name, l]));
  const parentOf = (l: LabelDefinition): number | null => {
    if (l.parent_id != null) return l.parent_id;
    const i = l.display_name.lastIndexOf("-");
    const pl = i > 0 ? byName.get(l.display_name.slice(0, i)) : undefined;
    return pl && pl.id !== l.id ? pl.id : null;
  };
  const kidsOf = new Map<number | null, LabelDefinition[]>();
  for (const l of labels) {
    const pid = parentOf(l);
    kidsOf.set(pid, [...(kidsOf.get(pid) ?? []), l]);
  }
  const subtree = (id: number): number[] => [id, ...(kidsOf.get(id) ?? []).flatMap((k) => subtree(k.id))];
  const memo = new Map<number, Omit<LabelTotal, "depth" | "hasKids">>();
  const totalOf = (l: LabelDefinition) => {
    const hit0 = memo.get(l.id);
    if (hit0) return hit0;
    const ids = subtree(l.id);
    let n = 0, pending = 0, tasksN = 0, okN = 0, retN = 0;
    for (const t of tasks) {
      let hit = false;
      for (const id of ids) {
        const c = t.label_counts?.[id];
        if (!c?.n) continue;
        hit = true;
        n += c.n;
        pending += c.ai_pending;
        okN += c.approved ?? 0;
        retN += c.returned ?? 0;
      }
      if (hit) tasksN += 1;
    }
    const r = { label: l, n, pending, tasksN, okN, retN };
    memo.set(l.id, r);
    return r;
  };
  const out: LabelTotal[] = [];
  const walk = (pid: number | null, depth: number) => {
    for (const l of kidsOf.get(pid) ?? []) {
      const t = totalOf(l);
      if (!t.n) continue;
      const hasKids = (kidsOf.get(l.id) ?? []).some((k) => totalOf(k).n > 0);
      out.push({ ...t, depth, hasKids });
      if (hasKids && open.has(l.id)) walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 选中类别（已展开成含子类的 id 集合）在这个任务里的最长一段 / 合计时长 / 段数 */
export function focusDur(t: Task, ids: Set<number>) {
  let max = 0, sum = 0, n = 0;
  for (const [lid, c] of Object.entries(t.label_counts ?? {})) {
    if (!ids.has(Number(lid))) continue;
    max = Math.max(max, c.max_ms ?? 0);
    sum += c.ms ?? 0;
    n += c.n;
  }
  return { max, sum, n };
}

export const fmtSecShort = (sec: number) =>
  sec >= 60 ? `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒` : `${sec.toFixed(1)}s`;

const FLAT_KEY = "label-summary-flat";
/** 片段汇总的显示方式（按大类 / 全部标签），记在本机，项目页和任务页共用 */
export function loadSummaryFlat(): boolean {
  try {
    return localStorage.getItem(FLAT_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveSummaryFlat(v: boolean) {
  try {
    localStorage.setItem(FLAT_KEY, v ? "1" : "0");
  } catch {
    /* 存不了就只管这一次 */
  }
}
