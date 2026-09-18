// 层级标签（舔 → 前爪 → 前左爪）的几个小工具。父子关系靠 parent_id；
// 名字里的「舔-前左爪」只是显示习惯，不拿来推断层级。
export interface TreeLabel {
  id: number;
  display_name: string;
  parent_id: number | null;
  sort_order?: number;
  code?: string;
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
