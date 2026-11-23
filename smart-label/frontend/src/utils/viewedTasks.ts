// 任务列表里「我看过哪些任务」只记在本机：打开过工作台就打点，列表把整行淡淡
// 高亮、ID 旁加个小圆点，翻几百个任务时不用靠记忆判断这个点没点开过。
// 换机器/换浏览器不跟随（不涉及服务端），存不下也不影响标注。
const KEY = (uid: number | null) => `smart-label:viewed-tasks:${uid ?? "anon"}`;
// 「上一个看的」单独记一个：全看过之后还得能找回刚才停在哪个任务
const LAST_KEY = (uid: number | null) => `smart-label:last-viewed-task:${uid ?? "anon"}`;
const LIMIT = 3000;

export function loadViewed(uid: number | null): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY(uid));
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function loadLastViewed(uid: number | null): number | null {
  try {
    const raw = localStorage.getItem(LAST_KEY(uid));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markViewed(uid: number | null, taskId: number): void {
  try {
    localStorage.setItem(LAST_KEY(uid), String(taskId));
    const cur = loadViewed(uid);
    cur[taskId] = Date.now();
    const keys = Object.keys(cur);
    if (keys.length > LIMIT) {
      keys.sort((a, b) => cur[a] - cur[b]).slice(0, keys.length - LIMIT).forEach((k) => delete cur[k]);
    }
    localStorage.setItem(KEY(uid), JSON.stringify(cur));
  } catch {
    // 隐私模式/配额满：记不住就算了
  }
}
