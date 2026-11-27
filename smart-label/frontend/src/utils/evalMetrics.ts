import type { VersionResult, WindowDetail } from "@/api/modelEval";

export function segIou(a: [number, number], b: [number, number]): number {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  if (inter <= 0) return 0;
  const union = (a[1] - a[0]) + (b[1] - b[0]) - inter;
  return union > 0 ? inter / union : 0;
}

export interface MatchedPair {
  pi: number;
  ti: number;
  iou: number;
  dStartMs: number;
  dEndMs: number;
  maxEdgeErrMs: number;
}

/** 与后端 model_eval_service.match 一致的贪心 1v1 配对 */
export function matchWindowSegs(
  preds: [number, number, number | null][],
  truths: [number, number][],
  iouMin: number,
): { pairs: MatchedPair[]; fp: number; fn: number } {
  const cand: { v: number; pi: number; ti: number }[] = [];
  for (let pi = 0; pi < preds.length; pi++) {
    const p: [number, number] = [preds[pi][0], preds[pi][1]];
    for (let ti = 0; ti < truths.length; ti++) {
      const v = segIou(p, truths[ti]);
      if (v >= iouMin) cand.push({ v, pi, ti });
    }
  }
  cand.sort((a, b) => b.v - a.v);
  const usedP = new Set<number>();
  const usedT = new Set<number>();
  const pairs: MatchedPair[] = [];
  for (const c of cand) {
    if (usedP.has(c.pi) || usedT.has(c.ti)) continue;
    usedP.add(c.pi);
    usedT.add(c.ti);
    const dStartMs = Math.abs(preds[c.pi][0] - truths[c.ti][0]);
    const dEndMs = Math.abs(preds[c.pi][1] - truths[c.ti][1]);
    pairs.push({
      pi: c.pi,
      ti: c.ti,
      iou: c.v,
      dStartMs,
      dEndMs,
      maxEdgeErrMs: Math.max(dStartMs, dEndMs),
    });
  }
  return { pairs, fp: preds.length - usedP.size, fn: truths.length - usedT.size };
}

/** 基于已拉回的 window_details，0ms 本地重算任意置信度过滤、IoU 阈值 & 边界容差（秒）下的窗口级、事件级与对齐指标 */
export function recomputeVersionAt(
  r: VersionResult,
  iouMin: number,
  edgeTolSec: number,
  confMin = 0,
): VersionResult {
  const details = r.window_details;
  if (!details || !details.length) return r;
  const tolMs = edgeTolSec * 1000;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let iouSum = 0;
  let dStartSum = 0;
  let dEndSum = 0;
  let withinCnt = 0;
  let wTp = 0;
  let wTn = 0;
  let wFp = 0;
  let wFn = 0;

  const nextDetails: WindowDetail[] = details.map((d) => {
    const keptPreds = confMin > 0
      ? d.pred_segs.filter((s) => s[2] == null || s[2] >= confMin)
      : d.pred_segs;
    const hasTruth = d.truth_segs.length > 0;
    const hasPred = keptPreds.length > 0;
    // 片段级检出（须真实重叠 >0ms）：完全不重叠绝不算命中，去掉「1 分钟框凑数」
    const hasOverlap =
      hasTruth &&
      hasPred &&
      keptPreds.some(([ps, pe]) => d.truth_segs.some(([ts, te]) => Math.min(pe, te) > Math.max(ps, ts)));
    const verdict: WindowDetail["verdict"] =
      hasTruth && hasPred
        ? hasOverlap ? "tp" : "fn"
        : !hasTruth && !hasPred
          ? "tn"
          : !hasTruth && hasPred
            ? "fp"
            : "fn";
    if (verdict === "tp") wTp += 1;
    else if (verdict === "tn") wTn += 1;
    else if (verdict === "fp") wFp += 1;
    else wFn += 1;

    const m = matchWindowSegs(keptPreds, d.truth_segs, iouMin);
    tp += m.pairs.length;
    fp += m.fp;
    fn += m.fn;
    let wIouSum = 0;
    let wMaxEdge: number | null = null;
    for (const pair of m.pairs) {
      iouSum += pair.iou;
      wIouSum += pair.iou;
      dStartSum += pair.dStartMs;
      dEndSum += pair.dEndMs;
      if (pair.maxEdgeErrMs <= tolMs) withinCnt += 1;
      if (wMaxEdge == null || pair.maxEdgeErrMs > wMaxEdge) wMaxEdge = pair.maxEdgeErrMs;
    }
    const maxConf = keptPreds.reduce<number | null>((mx, s) => (s[2] != null && (mx == null || s[2] > mx) ? s[2] : mx), null);
    return {
      ...d,
      verdict,
      pred_n: keptPreds.length,
      pred_segs: keptPreds,
      max_conf: maxConf,
      event_tp: m.pairs.length,
      event_fp: m.fp,
      event_fn: m.fn,
      mean_iou: m.pairs.length ? wIouSum / m.pairs.length : null,
      max_edge_err_ms: wMaxEdge,
      edge_aligned: wMaxEdge != null ? wMaxEdge <= tolMs : null,
    };
  });

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const wTotal = wTp + wTn + wFp + wFn;
  const wPrec = wTp + wFp > 0 ? wTp / (wTp + wFp) : 0;
  const wRec = wTp + wFn > 0 ? wTp / (wTp + wFn) : 0;
  const wF1 = wPrec + wRec > 0 ? (2 * wPrec * wRec) / (wPrec + wRec) : 0;
  const nextWindow = r.window
    ? {
        ...r.window,
        n_windows: wTotal,
        tp: wTp,
        tn: wTn,
        fp: wFp,
        fn: wFn,
        accuracy: wTotal > 0 ? (wTp + wTn) / wTotal : 0,
        precision: wPrec,
        recall: wRec,
        f1: wF1,
      }
    : r.window;

  return {
    ...r,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    window: nextWindow,
    mean_iou: tp > 0 ? iouSum / tp : null,
    d_start_abs_mean_ms: tp > 0 ? dStartSum / tp : null,
    d_end_abs_mean_ms: tp > 0 ? dEndSum / tp : null,
    within_2s_ratio: tp > 0 ? withinCnt / tp : null,
    window_details: nextDetails,
  };
}

/** 0ms 本地网格搜索单个模型的最佳置信度门槛（以事件级 F1 最大为主、片段级 F1 为辅） */
export function findBestConfMin(
  r: VersionResult,
  iouMin: number,
  edgeTolSec = 2,
): { bestConf: number; bestEvF1: number; bestWinF1: number } {
  if (!r.window_details?.length) {
    return { bestConf: 0, bestEvF1: r.f1 ?? 0, bestWinF1: r.window?.f1 ?? 0 };
  }
  let bestConf = 0;
  let bestEvF1 = -1;
  let bestWinF1 = -1;
  for (let i = 0; i <= 47; i++) {
    const c = Math.round(i * 2) / 100; // 0.00, 0.02, ..., 0.94
    const res = recomputeVersionAt(r, iouMin, edgeTolSec, c);
    const ev = res.f1 ?? 0;
    const win = res.window?.f1 ?? 0;
    if (ev > bestEvF1 + 1e-6 || (Math.abs(ev - bestEvF1) <= 1e-6 && win > bestWinF1 + 1e-6)) {
      bestConf = c;
      bestEvF1 = ev;
      bestWinF1 = win;
    }
  }
  return { bestConf, bestEvF1, bestWinF1 };
}

export interface IouBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  color: string;
}

export interface IouSweepRow {
  iou: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  meanIou: number | null;
}

export interface EdgeSweepRow {
  tolSec: number;
  aligned: number;
  total: number;
  ratio: number | null;
}

/** 计算所有有重叠配对（IoU > 0.01）的 IoU 分布直方图 + 典型阈值敏感度表 */
export function analyzeIouAndEdge(
  details: WindowDetail[] | null | undefined,
  currentIou: number,
): {
  buckets: IouBucket[];
  totalOverlapped: number;
  totalTruth: number;
  totalPred: number;
  iouSweep: IouSweepRow[];
  edgeSweep: EdgeSweepRow[];
} {
  const buckets: IouBucket[] = [
    { label: "1~10%", min: 0.01, max: 0.1, count: 0, color: "#ef4444" },
    { label: "10~20%", min: 0.1, max: 0.2, count: 0, color: "#f97316" },
    { label: "20~30%", min: 0.2, max: 0.3, count: 0, color: "#f59e0b" },
    { label: "30~50%", min: 0.3, max: 0.5, count: 0, color: "#3b82f6" },
    { label: "50~70%", min: 0.5, max: 0.7, count: 0, color: "#8b5cf6" },
    { label: "70~100%", min: 0.7, max: 1.01, count: 0, color: "#10b981" },
  ];
  const list = details ?? [];
  let totalOverlapped = 0;
  let totalTruth = 0;
  let totalPred = 0;

  for (const d of list) {
    totalTruth += d.truth_segs.length;
    totalPred += d.pred_segs.length;
    const m = matchWindowSegs(d.pred_segs, d.truth_segs, 0.01);
    for (const pair of m.pairs) {
      totalOverlapped += 1;
      const b = buckets.find((x) => pair.iou >= x.min && pair.iou < x.max);
      if (b) b.count += 1;
    }
  }

  const iouLevels = [0.1, 0.2, 0.3, 0.5];
  const iouSweep: IouSweepRow[] = iouLevels.map((iou) => {
    let tp = 0, fp = 0, fn = 0, iouSum = 0;
    for (const d of list) {
      const m = matchWindowSegs(d.pred_segs, d.truth_segs, iou);
      tp += m.pairs.length;
      fp += m.fp;
      fn += m.fn;
      for (const pair of m.pairs) iouSum += pair.iou;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { iou, tp, fp, fn, precision, recall, f1, meanIou: tp > 0 ? iouSum / tp : null };
  });

  // 在当前 IoU 阈值下，看 ±1s / ±2s / ±3s / ±5s 各有多少命中事件达标
  const tolLevels = [1, 2, 3, 5];
  const edgeErrs: number[] = [];
  for (const d of list) {
    const m = matchWindowSegs(d.pred_segs, d.truth_segs, currentIou);
    for (const pair of m.pairs) edgeErrs.push(pair.maxEdgeErrMs);
  }
  const edgeSweep: EdgeSweepRow[] = tolLevels.map((tolSec) => {
    const aligned = edgeErrs.filter((e) => e <= tolSec * 1000).length;
    return {
      tolSec,
      aligned,
      total: edgeErrs.length,
      ratio: edgeErrs.length > 0 ? aligned / edgeErrs.length : null,
    };
  });

  return { buckets, totalOverlapped, totalTruth, totalPred, iouSweep, edgeSweep };
}
