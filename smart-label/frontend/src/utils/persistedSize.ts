// 用户手动拖出来的区域高度（视频区/波形区）记住，下次打开别的任务不用重新拖。
// 包一层 try/catch：隐私模式/存储被禁时 localStorage 会抛错，不能让这个当掉整个页面。
export function getSavedHeight(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? null : Number(raw);
    return n != null && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveHeight(key: string, height: number | null): void {
  try {
    if (height == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(height)));
  } catch {
    // 存不了就算了，不影响当前这次的使用
  }
}

// 同样的道理用来记开关类的偏好（比如波形区滚动锁），下次打开别的任务还是
// 用户上次设的那个状态。
export function getSavedBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function saveBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // 存不了就算了，不影响当前这次的使用
  }
}

// 面板的展开/折叠：每个人的看法不一样（有人主要看波形，有人只看片段列表），
// 记下来，下次打开别的任务还是自己上次那套，不用每个任务重新点一遍。
export function getSavedKeys(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : fallback;
  } catch {
    return fallback;
  }
}

export function saveKeys(key: string, keys: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(keys));
  } catch {
    // 存不了就算了
  }
}

// 记一个纯文本的选择（比如上次用的预标注版本）。跟上面几个一样：存不进去
// （隐私模式/禁用存储）就当没有，不能让它当掉页面。
export function getSavedText(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不了就算了
  }
}
