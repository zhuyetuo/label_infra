/**
 * 最近用过的类别，记在 localStorage 里。
 *
 * 为什么值得记：标注一轮下来往往是**同一个二级标签连点几十次**（一整段
 * 「抓挠-头颈耳」逐条确认）。而标签树有上百条、三四级深，每次都要翻或者搜，
 * 这件事本身比判断动作还费时间。
 *
 * 按项目分开存：不同项目用的是不同的标签模板，串了只会给一堆用不上的选项。
 */

const KEY = "seg-recent-labels";
const MAX = 5;

type Store = Record<string, number[]>;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    // 隐私模式/存储被禁时会抛，不能让它当掉整个标注页
    return {};
  }
}

/** 这个项目最近用过的类别 id，最近的在最前 */
export function recentLabels(projectKey: string | number | null | undefined): number[] {
  const list = load()[String(projectKey ?? "-")] ?? [];
  return Array.isArray(list) ? list.filter((x) => typeof x === "number") : [];
}

/** 记一次。已经在里面的挪到最前，不是再加一条 */
export function rememberLabel(projectKey: string | number | null | undefined, id: number) {
  if (!Number.isFinite(id)) return;
  const k = String(projectKey ?? "-");
  const store = load();
  const next = [id, ...(store[k] ?? []).filter((x) => x !== id)].slice(0, MAX);
  store[k] = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // 存不了就算了，这一次还是能正常选
  }
}
