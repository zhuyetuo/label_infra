// 工作台下面几个面板（IMU 波形 / 画面对照 / 已标注片段 / 疑似片段）的顺序和隐藏。
// 每个人常用的不一样：复看抓挠的人整天盯候选面板，标活动的人只看波形和片段列表。
// 顺序和隐藏都记在 localStorage 里（跟展开/折叠一样），下次开别的任务还是自己那套。
import { getSavedKeys, saveKeys } from "@/utils/persistedSize";

export const PANEL_ORDER_KEY = "smart-label:ws-panel-order";
export const PANEL_HIDDEN_KEY = "smart-label:ws-panel-hidden";

export type PanelKey = "imu" | "cross" | "segs" | "cands";
export const DEFAULT_PANEL_ORDER: PanelKey[] = ["imu", "cross", "segs", "cands"];
export const PANEL_TITLES: Record<PanelKey, string> = {
  imu: "IMU 波形",
  cross: "画面对照",
  segs: "已标注片段",
  cands: "疑似片段",
};

function isPanelKey(k: string): k is PanelKey {
  return (DEFAULT_PANEL_ORDER as string[]).includes(k);
}

/** 存的顺序可能缺项（以后加了新面板）或有脏值：认识的按存的顺序，没提到的按默认顺序补在后面 */
export function normalizeOrder(raw: string[]): PanelKey[] {
  const seen = new Set<PanelKey>();
  const out: PanelKey[] = [];
  for (const k of raw) {
    if (isPanelKey(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of DEFAULT_PANEL_ORDER) if (!seen.has(k)) out.push(k);
  return out;
}

export function loadOrder(): PanelKey[] {
  return normalizeOrder(getSavedKeys(PANEL_ORDER_KEY, DEFAULT_PANEL_ORDER));
}

export function saveOrder(order: PanelKey[]): void {
  saveKeys(PANEL_ORDER_KEY, order);
}

export function loadHidden(): PanelKey[] {
  return getSavedKeys(PANEL_HIDDEN_KEY, []).filter(isPanelKey);
}

export function saveHidden(hidden: PanelKey[]): void {
  saveKeys(PANEL_HIDDEN_KEY, hidden);
}

/**
 * 把 key 往上/往下挪一格——按"眼前看得见的"顺序挪，不是按存的全量顺序。
 * 存的顺序里夹着隐藏的、当前任务没有的（比如没跑过画面对照）面板，按全量挪的话
 * 点一下可能只是跟一个看不见的面板换了位置，屏幕上纹丝不动，人会以为按钮坏了。
 */
export function moveAmongShown(order: PanelKey[], shown: PanelKey[], key: PanelKey, dir: "up" | "down"): PanelKey[] {
  const i = shown.indexOf(key);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= shown.length) return order;
  const neighbor = shown[j];
  const rest = order.filter((k) => k !== key);
  const at = rest.indexOf(neighbor);
  if (at < 0) return order;
  rest.splice(dir === "up" ? at : at + 1, 0, key);
  return rest;
}
