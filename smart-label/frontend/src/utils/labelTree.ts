// 层级标签（舔 → 前爪 → 前左爪）的几个小工具。父子关系靠 parent_id；
// 名字里的「舔-前左爪」只是显示习惯，不拿来推断层级。
export interface TreeLabel {
  id: number;
  display_name: string;
  parent_id: number | null;
  sort_order?: number;
  code?: string;
  track?: string | null;
}

/** 互斥轨：同轨的标签时间上互斥，跨轨可以同时标（卧着 + 静止 + 舔前爪）。顺序 = 工作台上的分组顺序、导出折叠的默认优先级 */
export const TRACKS: { key: string; name: string; hint: string }[] = [
  { key: "behavior", name: "行为", hint: "具体在干什么：抓挠 / 舔 / 啃 / 蹭 / 进食 / 饮水 / 嗅闻……一次一件" },
  { key: "motion", name: "运动", hint: "要么静要么动：静止休息（睡眠）/ 活动（行走、奔跑、跳跃……）" },
  { key: "posture", name: "姿态", hint: "任一时刻一种姿态：坐 / 卧 / 站 / 姿态转换" },
  { key: "device", name: "设备", hint: "颈圈松动这类设备状态，跟什么都能同时发生，不进行为类别" },
];
export const TRACK_NAME: Record<string, string> = Object.fromEntries(TRACKS.map((t) => [t.key, t.name]));

/** 一个标签的有效轨：自己填了用自己的，没填往上找上级；都没有就是 ""（没分轨那一轨，互相互斥） */
export function trackOf<T extends TreeLabel>(map: Map<number, T>, id: number): string {
  for (const l of chainOf(map, id).reverse()) {
    if (l.track && TRACK_NAME[l.track]) return l.track;
  }
  return "";
}

/** 两段时间重叠算不算矛盾：同一个 / 父子不算，不同轨不算，其余算 */
export function conflicts<T extends TreeLabel>(map: Map<number, T>, a: number, b: number): boolean {
  if (related(map, a, b)) return false;
  return trackOf(map, a) === trackOf(map, b);
}

export function byId<T extends TreeLabel>(labels: T[]): Map<number, T> {
  return new Map(labels.map((l) => [l.id, l]));
}

/** parent_id → 直接子标签（按排序）。根在 key null 下。上级不在列表里（停用/别的项目）的当根 */
export function childrenMap<T extends TreeLabel>(labels: T[]): Map<number | null, T[]> {
  const ids = new Set(labels.map((l) => l.id));
  const m = new Map<number | null, T[]>();
  for (const l of labels) {
    const p = l.parent_id != null && ids.has(l.parent_id) ? l.parent_id : null;
    const arr = m.get(p) ?? [];
    arr.push(l);
    m.set(p, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  return m;
}

/** 从根到自己：[祖, 父, 自己]。断链就到哪算哪 */
export function chainOf<T extends TreeLabel>(map: Map<number, T>, id: number): T[] {
  const out: T[] = [];
  const seen = new Set<number>();
  let cur: number | null = id;
  while (cur != null && !seen.has(cur)) {
    const l = map.get(cur);
    if (!l) break;
    seen.add(cur);
    out.push(l);
    cur = l.parent_id;
  }
  return out.reverse();
}

/** 自己 + 全部子孙的 id */
export function descendantIds<T extends TreeLabel>(labels: T[], roots: Iterable<number>): Set<number> {
  const cm = childrenMap(labels);
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const i = stack.pop()!;
    if (out.has(i)) continue;
    out.add(i);
    for (const c of cm.get(i) ?? []) stack.push(c.id);
  }
  return out;
}

/** 一个是另一个的祖先（或同一个）：父子重叠不算冲突 */
export function related<T extends TreeLabel>(map: Map<number, T>, a: number, b: number): boolean {
  if (a === b) return true;
  return chainOf(map, a).some((l) => l.id === b) || chainOf(map, b).some((l) => l.id === a);
}

/** 子标签在自己那一层的短名：「舔-前左爪」在「舔」下面显示成「前左爪」。
 *  按名字前缀去掉根的名字（中间层不拼进名字），去不掉就原样 */
export function shortName<T extends TreeLabel>(map: Map<number, T>, l: T): string {
  const chain = chainOf(map, l.id);
  for (const anc of chain.slice(0, -1)) {
    if (l.display_name.startsWith(anc.display_name + "-")) return l.display_name.slice(anc.display_name.length + 1);
  }
  return l.display_name;
}

/** 树形深度优先展开成一列，带层级（给表格/下拉画缩进用） */
export function flatten<T extends TreeLabel>(labels: T[]): { label: T; depth: number }[] {
  const cm = childrenMap(labels);
  const out: { label: T; depth: number }[] = [];
  const walk = (p: number | null, depth: number) => {
    for (const l of cm.get(p) ?? []) {
      out.push({ label: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
