import { related, trackOf, type TreeLabel } from "@/utils/labelTree";

/** 一条片段跟另一条的重叠 */
export interface OverlapHit {
  other: number;
  /** 重叠多少毫秒 */
  ms: number;
  /** 占本段 / 对方的比例（0~1） */
  pctSelf: number;
  pctOther: number;
  /** dup = 同一个类别重复标了；nested = 父子类别（抓挠 / 抓挠-躯干）压在一起；conflict = 同一轨的不同类别（矛盾） */
  kind: "dup" | "nested" | "conflict";
}

export const OVERLAP_KIND_NAME: Record<OverlapHit["kind"], string> = {
  dup: "同类重复",
  nested: "父子重叠",
  conflict: "类别冲突",
};

/** 重叠不到这么多不算：相邻两段起止差几十毫秒是拖边界时的正常误差 */
export const OVERLAP_MIN_MS = 200;

/**
 * 找出同一轨上互相重叠的片段（不同轨——卧着 + 舔——本来就该同时标，不算）。
 * 返回 片段 id → 跟它重叠的那些。按开始时间扫一遍，O(n log n + 重叠对数)。
 */
export function computeOverlaps<L extends TreeLabel>(
  items: { id: number; label_id: number; start_time_ms: number; end_time_ms: number }[],
  labelMap: Map<number, L>,
  minMs = OVERLAP_MIN_MS,
): Map<number, OverlapHit[]> {
  const out = new Map<number, OverlapHit[]>();
  const sorted = [...items].sort((a, b) => a.start_time_ms - b.start_time_ms);
  const push = (id: number, h: OverlapHit) => {
    const l = out.get(id);
    if (l) l.push(h);
    else out.set(id, [h]);
  };
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.start_time_ms >= a.end_time_ms) break;
      const ms = Math.min(a.end_time_ms, b.end_time_ms) - b.start_time_ms;
      if (ms < minMs) continue;
      if (trackOf(labelMap, a.label_id) !== trackOf(labelMap, b.label_id)) continue;
      const kind: OverlapHit["kind"] =
        a.label_id === b.label_id ? "dup" : related(labelMap, a.label_id, b.label_id) ? "nested" : "conflict";
      const la = Math.max(1, a.end_time_ms - a.start_time_ms), lb = Math.max(1, b.end_time_ms - b.start_time_ms);
      push(a.id, { other: b.id, ms, pctSelf: ms / la, pctOther: ms / lb, kind });
      push(b.id, { other: a.id, ms, pctSelf: ms / lb, pctOther: ms / la, kind });
    }
  }
  return out;
}
