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
  { key: "device", name: "设备", hint: "颈圈松动 / 未佩戴这类设备状态，跟行为轨可以同时标，不进行为类别；两者之间互斥" },
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


/**
 * 标签的旧名 → 现在叫什么。
 *
 * 候选行上的 label_name 是**写进去那一刻**的名字：IMU 那边送上来的、以及老数据里
 * 的，都还叫「舔身体」；而项目标签早就改叫「舔」了。后果不是"名字不好看"——
 * 按 display_name 去找颜色、找子部位全都落空：下拉里那一条是灰的、
 * 「确认是舔身体」底下一个部位按钮都没有，而旁边的「抓挠」（没改过名）一切正常。
 *
 * 跟后端 grooming_labels.NAME_ALIASES 是同一张表。两个仓库解耦，各留一份；
 * 这张表只有三条，而且不会再长——新标签一开始就用新名。
 */
const NAME_ALIASES: Record<string, string> = {
  舔身体: "舔",
  啃身体: "啃",
  蹭身体: "蹭",
};

/** 一个（可能是旧名的）标签名对应项目里的哪条标签。找不到返回 undefined */
export function findLabel<T extends { display_name: string }>(
  labels: T[],
  name: string,
): T | undefined {
  return labels.find((l) => l.display_name === name)
    ?? (NAME_ALIASES[name] ? labels.find((l) => l.display_name === NAME_ALIASES[name]) : undefined);
}

/** 这个名字现在该显示成什么（旧名换成新名，其余原样） */
export const currentName = (name: string): string => NAME_ALIASES[name] ?? name;

/**
 * 想标成 want，但项目里不一定有这个标签——往上找最近的一个真有的。
 *
 * 为什么要有这个：搜的那个下拉列的是**所有已知动作名**（那张中文标签→英文描述的表，
 * 跨项目通用），而「标成」只能用**这个项目里真有的标签**。项目 A 建过「舔-后爪」，
 * 项目 B 没有，于是在 B 里选了描述之后「标成」就空着，人还以为是坏了。
 *
 * 找法跟 queryFor 一套：原名 → 去掉左/右 → 一级级往上（舔-左后爪 → 舔-后爪 → 舔）。
 * 退到父级不是凑合：部位标错了要改一条，而整批写不进去是一个都拿不到。
 * 退了必须说出来（返回 exact=false），不然人会以为自己选的就是那个部位。
 */
export function nearestName(names: string[], want: string): { name: string; exact: boolean } | null {
  // 旧名新名两头都要认：项目里存的可能还是「舔身体」，想标的是「舔」，反过来也有
  const has = (s: string) =>
    names.find((n) => n === s || NAME_ALIASES[s] === n || NAME_ALIASES[n] === s);
  const tries: string[] = [];
  const push = (s: string) => {
    if (s && !tries.includes(s)) tries.push(s);
  };
  push(want);
  const noLR = want
    .replace(/-([左右])/, "-")
    .replace(/-(前|后)([左右])/, "-$1")
    .replace(/^([左右])/, "");
  push(noLR);
  for (const base of [noLR, want]) {
    // 一级一级往上：舔-左后爪 → 舔-后爪 → 舔
    let i = base.lastIndexOf("-");
    while (i > 0) {
      push(base.slice(0, i));
      i = base.lastIndexOf("-", i - 1);
    }
  }
  for (const k of tries) {
    const hit = has(k);
    if (hit) return { name: hit, exact: k === want };
  }
  return null;
}
