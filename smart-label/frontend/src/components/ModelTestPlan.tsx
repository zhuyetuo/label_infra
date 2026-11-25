/**
 * 配比：填一个总数，每个维度一个圆环（场所 / 体型 / 时长 / 有无 / 有·部位 / 无·分类），直接填目标百分比，圆环立刻跟着变。
 * 每只狗分多少是算出来的（不用手填）：场所 × 体型同时按目标百分比配（迭代比例拟合，做不到的标出实际），
 * 再分到狗（平均或按可用量）→ 时长 → 有/无 → 部位，每层整批摊，合计正好是总数。
 * 「检查够不够」按这份配比在真实数据里试挑一遍（不写库）；「生成」写进测试集。
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Collapse, DatePicker, Input, InputNumber, Popconfirm, Popover, Segmented, Select, Space, Spin, Tooltip, TreeSelect, message, theme } from "antd";
import { CloseOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listDogs, type Dog } from "@/api/dogs";
import { getLabelTree, planApply, planAvailability, planPreview, planSave, type Plan, type PlanDog, type PlanResult } from "@/api/modelTests";

const SITE_ORDER = ["佛山博朗旺狗场", "公司影棚", "深圳雷诺狗场"];
const SITE_SHORT: Record<string, string> = { 佛山博朗旺狗场: "佛山博朗旺", 公司影棚: "公司影棚", 深圳雷诺狗场: "深圳雷诺" };
const SITE_COLORS: Record<string, string> = { 佛山博朗旺狗场: "#25725a", 公司影棚: "#3f7f95", 深圳雷诺狗场: "#a3474c" };
const SIZES = ["小", "中", "大"];
const SIZE_COLORS: Record<string, string> = { 小: "#d8a85c", 中: "#72999f", 大: "#5b5a86" };
const DUR_COLORS = ["#25725a", "#72999f", "#d8a85c", "#8e7cc3", "#c27c7c"];
const PART_COLORS = ["#2f7d72", "#5b5a86", "#d8a85c", "#72999f", "#c27c7c", "#8e7cc3"];
const NEG_BLUE = "#4a6fa5";
const NEG_COLORS = ["#b0762a", "#3f7f95", "#2f7d72", "#6b7280", "#8e7cc3", "#a3474c"];
const DEFAULT_NEG = [
  { name: "像抓挠的动作", anchors: ["舔", "啃", "蹭", "甩头/抖身"], ratio: 40 },
  { name: "正常活动", anchors: ["活动"], ratio: 20 },
  { name: "休息睡眠", anchors: ["静止/休息"], ratio: 30 },
  { name: "未佩戴", anchors: ["未佩戴"], ratio: 10 },
];
const NEG_TIPS: Record<string, string> = {
  像抓挠的动作: "舔、啃、蹭、甩头：项圈也会反复晃，最容易被报成抓挠。凑不齐时优先保它",
  正常活动: "走、跑、转圈、玩：看狗一动起来会不会乱报",
  休息睡眠: "趴着、侧躺睡：一动不动时报抓挠肯定是错的",
  未佩戴: "项圈摘下来、设备还在录：没戴还报抓挠算硬伤",
};
type Alloc = NonNullable<Plan["alloc"]> & { total?: number; exclude?: number[]; pct?: boolean };
/** 比例都是目标百分比；合计不是 100 时按比例换算 */
const DEFAULT_ALLOC: Alloc = { total: 200, site: { 佛山博朗旺狗场: 81, 公司影棚: 13, 深圳雷诺狗场: 6 }, size: { 小: 34, 中: 33, 大: 33 },
  dur: { "60": 60, "120": 30, "180": 10 }, pos: 50, neg: 50, part: {}, dog: "even", exclude: [], pct: true };
const durLabel = (s: number) => (s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`);

/** n 按比例摊（最大余数），合计正好 n；跟后端 split_by_ratio 同一套 */
function splitByRatio(n: number, ratios: number[]): number[] {
  const tot = ratios.reduce((a, b) => a + b, 0);
  if (n <= 0 || tot <= 0) return ratios.map(() => 0);
  const raw = ratios.map((r) => (n * r) / tot);
  const base = raw.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  raw.map((x, j) => [x - Math.floor(x), j] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, j]) => { if (left > 0) { base[j]++; left--; } });
  return base;
}
/** 整批摊：行合计、列合计都守住；跟后端 split_grid 同一套 */
function splitGrid(rows: number[], cols: number[]): number[][] {
  const total = rows.reduce((a, b) => a + b, 0);
  if (total <= 0 || !cols.length) return rows.map(() => cols.map(() => 0));
  const grid = rows.map((r) => cols.map((c) => Math.floor((r * c) / total)));
  const usedR = grid.map((g) => g.reduce((a, b) => a + b, 0));
  const usedC = cols.map((_, j) => grid.reduce((a, g) => a + g[j], 0));
  const extra: [number, number, number][] = [];
  rows.forEach((r, i) => cols.forEach((c, j) => extra.push([(r * c) / total - Math.floor((r * c) / total), i, j])));
  extra.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  let left = total - usedR.reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 20 && left > 0; pass++) {
    let moved = false;
    for (const [, i, j] of extra) {
      if (left <= 0) break;
      if (usedR[i] < rows[i] && usedC[j] < cols[j]) { grid[i][j]++; usedR[i]++; usedC[j]++; left--; moved = true; }
    }
    if (!moved) break;
  }
  rows.forEach((r, i) => {
    while (usedR[i] < r) {
      let best = 0;
      cols.forEach((c, j) => { if (c - usedC[j] > cols[best] - usedC[best]) best = j; });
      grid[i][best]++; usedR[i]++; usedC[best]++;
    }
  });
  return grid;
}
/** 老计划存的是 1:1:1 这种权重：换成合计 100 的整数百分比 */
const toPct = (vals: number[]): number[] => (vals.some((v) => v > 0) ? splitByRatio(100, vals) : vals);
function migrateAlloc(a: Alloc, durs: number[], parts: string[]): Alloc {
  if (a.pct) return a;
  const conv = (keys: string[], get: (k: string) => number) => {
    const v = toPct(keys.map(get));
    return Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  };
  const [pos, neg] = toPct([a.pos ?? 1, a.neg ?? 1]);
  return {
    ...DEFAULT_ALLOC, ...a, pct: true, pos, neg,
    site: conv(SITE_ORDER, (k) => a.site?.[k] ?? 0),
    size: conv(SIZES, (k) => a.size?.[k] ?? 1),
    dur: conv(durs.map(String), (k) => a.dur?.[k] ?? 1),
    part: conv(parts, (k) => a.part?.[k] ?? 1),
  };
}

type Seg = {
  key: string; label: ReactNode; count: number; color: string;
  target?: number; onTarget?: (v: number) => void; onRemove?: () => void;
  got?: number | null; tip?: ReactNode; sub?: ReactNode; empty?: string;
};

export default function ModelTestPlan({ setId, initial, frozen, accent = "#27AE60", existing = 0, onApplied }: {
  setId: number; initial?: Plan | null; frozen?: boolean; accent?: string; existing?: number; onApplied?: () => void;
}) {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<Plan>(() => {
    const p = initial ?? { target: "抓挠", durations: [60, 120, 180], parts: [], dogs: [] };
    const old = p.alloc as Alloc | undefined;
    const nc = p.neg_cats ?? (p.target === "抓挠" ? DEFAULT_NEG : []);
    const ncPct = old?.pct || !p.neg_cats ? nc : (() => { const v = toPct(nc.map((c) => c.ratio)); return nc.map((c, i) => ({ ...c, ratio: v[i] })); })();
    return { ...p, neg_cats: ncPct, alloc: old ? migrateAlloc({ ...old }, p.durations, p.parts) : { ...DEFAULT_ALLOC } };
  });
  const alloc = (plan.alloc ?? DEFAULT_ALLOC) as Alloc;
  const [result, setResult] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "apply" | "save">("");
  const update = (fn: (p: Plan) => Plan) => { setPlan(fn); setResult(null); };
  const setAlloc = (patch: Partial<Alloc>) => update((p) => ({ ...p, alloc: { ...((p.alloc ?? DEFAULT_ALLOC) as Alloc), ...patch } }));

  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const { data: tree } = useQuery({ queryKey: ["mt-label-tree"], queryFn: getLabelTree });
  const filterKey = [plan.target, plan.date_from, plan.date_to, plan.source, plan.seen_mode, (plan.model_ids ?? []).join(",")];
  const { data: avail, isFetching: availLoading } = useQuery({
    queryKey: ["mt-plan-avail", ...filterKey], queryFn: () => planAvailability(plan), staleTime: 60_000,
  });

  // ── 标签树 ──
  const kids = useMemo(() => {
    const m = new Map<string | null, string[]>();
    (tree ?? []).forEach((x) => m.set(x.parent, [...(m.get(x.parent) ?? []), x.name]));
    return m;
  }, [tree]);
  const descendants = (name: string): Set<string> => {
    const out = new Set<string>([name]);
    const walk = (n: string, d: number) => (kids.get(n) ?? []).forEach((c) => { if (d < 6) { out.add(c); walk(c, d + 1); } });
    walk(name, 0);
    return out;
  };
  type Node = { title: string; value: string; children: Node[] };
  const subtree = (p: string, d = 0): Node[] => (d > 4 ? [] : (kids.get(p) ?? []).map((n) => ({ title: n, value: n, children: subtree(n, d + 1) })));
  const tops = kids.get(null) ?? [];
  const otherTree: Node[] = tops.filter((t) => t !== plan.target).map((t) => ({ title: t, value: t, children: subtree(t) }));

  // ── 狗、可用量 ──
  const allDogs = useMemo(() => (dogs ?? []).filter((d) => SITE_ORDER.includes(d.site ?? ""))
    .sort((a, b) => SITE_ORDER.indexOf(a.site ?? "") - SITE_ORDER.indexOf(b.site ?? "") || SIZES.indexOf(a.size ?? "") - SIZES.indexOf(b.size ?? "") || a.id - b.id), [dogs]);
  const availOf = (id: number, name?: string) => {
    const m = avail?.by_dog?.[String(id)] ?? {};
    const want = descendants(name ?? plan.target);
    return Object.entries(m).reduce((a, [k, n]) => a + (want.has(k) ? n : 0), 0);
  };
  const excluded = new Set(alloc.exclude ?? []);
  const durs = plan.durations;
  // 没填过的时长 / 部位：默认均分
  const durT = (d: number) => alloc.dur?.[String(d)] ?? Math.round(100 / Math.max(1, durs.length));
  const partT = (k: string) => alloc.part?.[k] ?? Math.round(100 / Math.max(1, plan.parts.length));

  // ── 由总数 + 目标百分比算出每只狗的配额 ──
  const derived = useMemo(() => {
    const N = Math.max(0, Math.round(alloc.total ?? 0));
    const eligible = allDogs.filter((d) => !excluded.has(d.id) && (!avail || availOf(d.id) > 0));
    // 场所 × 体型：两边的目标百分比同时尽量满足（迭代比例拟合），有狗的格子才能分
    const sizesOf = (d: Dog) => (SIZES.includes(d.size ?? "") ? d.size! : "中");
    const cellDogs = SITE_ORDER.map((s) => SIZES.map((z) => eligible.filter((d) => d.site === s && sizesOf(d) === z)));
    const siteT = SITE_ORDER.map((s) => alloc.site?.[s] ?? 0);
    const sizeT = SIZES.map((z) => alloc.size?.[z] ?? 0);
    let m: number[][] = cellDogs.map((row, i) => row.map((ds, j): number => (ds.length && siteT[i] > 0 && sizeT[j] > 0 ? 1 : 0)));
    const norm = (v: number[]) => { const t = v.reduce((a, b) => a + b, 0); return v.map((x) => (t ? x / t : 0)); };
    const liveRows = SITE_ORDER.map((_, i) => m[i].some((x) => x > 0));
    const liveCols = SIZES.map((_, j) => m.some((r) => r[j] > 0));
    const rT = norm(siteT.map((t, i) => (liveRows[i] ? t : 0)));
    const cT = norm(sizeT.map((t, j) => (liveCols[j] ? t : 0)));
    for (let it = 0; it < 200; it++) {
      m = m.map((row, i) => { const r = row.reduce((a, b) => a + b, 0); return row.map((x) => (r ? (x * rT[i]) / r : 0)); });
      const cs = SIZES.map((_, j) => m.reduce((a, r) => a + r[j], 0));
      m = m.map((row) => row.map((x, j) => (cs[j] ? (x * cT[j]) / cs[j] : 0)));
    }
    const flat = splitByRatio(N, m.flat());
    const dogN = new Map<number, number>();
    cellDogs.forEach((row, i) => row.forEach((ds, j) => {
      const n = flat[i * SIZES.length + j];
      if (!n || !ds.length) return;
      splitByRatio(n, ds.map((d) => (alloc.dog === "avail" ? availOf(d.id) : 1))).forEach((k, x) => dogN.set(ds[x].id, k));
    }));
    const ids = eligible.map((d) => d.id).filter((id) => (dogN.get(id) ?? 0) > 0);
    const durG = splitGrid(ids.map((id) => dogN.get(id) ?? 0), splitByRatio(N, durs.map(durT)));
    const cells = ids.flatMap((id, i) => durs.map((d, j) => ({ id, d, n: durG[i][j] })));
    const pnG = splitGrid(cells.map((c) => c.n), splitByRatio(N, [alloc.pos ?? 50, alloc.neg ?? 50]));
    const q = new Map<number, Record<string, [number, number]>>();
    cells.forEach((c, i) => { const mm = q.get(c.id) ?? {}; mm[String(c.d)] = [pnG[i][0], pnG[i][1]]; q.set(c.id, mm); });
    const posOf = (id: number) => durs.reduce((a, d) => a + (q.get(id)?.[String(d)]?.[0] ?? 0), 0);
    const posTot = ids.reduce((a, id) => a + posOf(id), 0);
    const partG = plan.parts.length ? splitGrid(ids.map(posOf), splitByRatio(posTot, plan.parts.map(partT))) : ids.map(() => []);
    return ids.map((id, i) => ({ dog_id: id, q: q.get(id) ?? {}, p: Object.fromEntries(plan.parts.map((k, j) => [k, partG[i][j] ?? 0])) })) as PlanDog[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, allDogs, avail]);
  const planOut: Plan = { ...plan, dogs: derived };

  // ── 汇总 ──
  const byId = new Map(allDogs.map((d) => [d.id, d]));
  const qOf = (x: PlanDog, d: number) => (x.q[String(d)] as [number, number]) ?? [0, 0];
  const dogSum = (x: PlanDog) => durs.reduce((a, d) => a + qOf(x, d)[0] + qOf(x, d)[1], 0);
  const sumBy = (key: (d: Dog) => string) => {
    const m: Record<string, number> = {};
    derived.forEach((x) => { const d = byId.get(x.dog_id); if (d) m[key(d)] = (m[key(d)] ?? 0) + dogSum(x); });
    return m;
  };
  const bySite = sumBy((d) => d.site ?? "");
  const bySize = sumBy((d) => d.size ?? "");
  const byDur = Object.fromEntries(durs.map((d) => [String(d), derived.reduce((a, x) => a + qOf(x, d)[0] + qOf(x, d)[1], 0)]));
  const posTotal = derived.reduce((a, x) => a + durs.reduce((b, d) => b + qOf(x, d)[0], 0), 0);
  const negTotal = derived.reduce((a, x) => a + durs.reduce((b, d) => b + qOf(x, d)[1], 0), 0);
  const total = posTotal + negTotal;
  const byPart = Object.fromEntries(plan.parts.map((k) => [k, derived.reduce((a, x) => a + (x.p[k] ?? 0), 0)]));
  const negCats = plan.neg_cats ?? [];
  const negByCat = negCats.map(() => 0);
  durs.forEach((d) => {
    const rows = derived.map((x) => qOf(x, d)[1]);
    const g = splitGrid(rows, splitByRatio(rows.reduce((a, b) => a + b, 0), negCats.map((c) => c.ratio)));
    negCats.forEach((_, j) => { negByCat[j] += g.reduce((a, r) => a + r[j], 0); });
  });
  const hours = derived.reduce((a, x) => a + durs.reduce((b, d) => b + (qOf(x, d)[0] + qOf(x, d)[1]) * d, 0), 0) / 3600;
  const siteAvail = (s: string) => allDogs.filter((d) => d.site === s && !excluded.has(d.id)).reduce((a, d) => a + availOf(d.id), 0);
  const sizeAvail = (z: string) => allDogs.filter((d) => d.size === z && !excluded.has(d.id)).reduce((a, d) => a + availOf(d.id), 0);

  // 检查结果
  const rep = result?.report ?? {};
  const gotDur = (d: number, k: 0 | 1) => (result ? Object.values(rep).reduce((a, r) => a + (r.q?.[String(d)]?.[k] ?? 0), 0) : null);
  const gotPart = (k: string) => (result ? Object.values(rep).reduce((a, r) => a + (r.p?.[k] ?? 0), 0) : null);
  const gotCat = (name: string) => (result ? Object.values(rep).reduce((a, r) => a + durs.reduce((b, d) => b + (r.n?.[String(d)]?.[name] ?? 0), 0), 0) : null);
  const gotBy = (key: (d: Dog) => string, v: string) => (result ? derived.filter((x) => byId.get(x.dog_id) && key(byId.get(x.dog_id)!) === v)
    .reduce((a, x) => a + durs.reduce((b, d) => b + (rep[String(x.dog_id)]?.q?.[String(d)]?.[0] ?? 0) + (rep[String(x.dog_id)]?.q?.[String(d)]?.[1] ?? 0), 0), 0) : null);
  const shortages = result ? derived.flatMap((x) => {
    const r = rep[String(x.dog_id)];
    return durs.flatMap((d) => ([0, 1] as const).map((k) => {
      const want = qOf(x, d)[k], have = r?.q?.[String(d)]?.[k] ?? 0;
      return want > have ? `${byId.get(x.dog_id)?.name} ${durLabel(d)}${k === 0 ? "有" : "无"}${plan.target} 缺 ${want - have}` : null;
    }).filter(Boolean) as string[]);
  }) : [];

  const run = async (kind: "check" | "apply" | "save") => {
    if (!total && kind !== "save") return message.warning("总数是 0，或者目标百分比都是 0");
    setBusy(kind);
    try {
      if (kind === "save") { await planSave(setId, planOut); message.success("配比已保存"); return; }
      const r = kind === "check" ? await planPreview(setId, planOut) : await planApply(setId, planOut);
      setResult(r);
      if (kind === "apply") {
        message.success(`${r.removed ? `删掉原来的 ${r.removed} 段，` : ""}生成 ${r.added ?? r.n_picked} 段`);
        qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
        qc.invalidateQueries({ queryKey: ["model-test-sets"] });
        onApplied?.();
      }
    } finally { setBusy(""); }
  };
  const changeDur = (d: number, minutes: number) => {
    const s = Math.round(minutes * 60);
    if (!Number.isFinite(s) || s <= 0 || s === d) return;
    if (durs.includes(s)) return message.warning(`已经有 ${durLabel(s)} 了`);
    update((p) => {
      const a = (p.alloc ?? DEFAULT_ALLOC) as Alloc;
      const dw = { ...(a.dur ?? {}) };
      if (dw[String(d)] != null) { dw[String(s)] = dw[String(d)]; delete dw[String(d)]; }
      return { ...p, durations: p.durations.map((x) => (x === d ? s : x)).sort((x, y) => x - y), alloc: { ...a, dur: dw } };
    });
  };
  const [newMin, setNewMin] = useState<number | null>(5);
  const [newCat, setNewCat] = useState<{ name: string; anchors: string[] }>({ name: "", anchors: [] });

  // ── 样式 ──
  const line = token.colorBorderSecondary;
  const muted = token.colorTextSecondary;
  const card: CSSProperties = { border: `1px solid ${line}`, borderRadius: 12, padding: "14px 16px", background: token.colorBgContainer };
  const Got = ({ want, have }: { want: number; have: number | null | undefined }) =>
    have == null ? null : <span style={{ fontSize: 12, fontWeight: 600, color: have < want ? token.colorError : token.colorSuccess }}>{have < want ? `挑到${have}` : "✓"}</span>;

  /** 圆环：每块按段数占比；中间写总数 */
  const donut = (segs: Seg[], center: ReactNode) => {
    const R = 44, C = 2 * Math.PI * R;
    const t = segs.reduce((a, s) => a + s.count, 0);
    let acc = 0;
    return (
      <div style={{ position: "relative", width: 108, height: 108, flex: "none" }}>
        <svg viewBox="0 0 120 120" width={108} height={108} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={60} cy={60} r={R} fill="none" stroke={token.colorFillTertiary} strokeWidth={16} />
          {t > 0 && segs.map((s) => {
            const len = (s.count / t) * C;
            const el = (
              <circle key={s.key} cx={60} cy={60} r={R} fill="none" stroke={s.color} strokeWidth={16}
                strokeDasharray={`${Math.max(0, len - (segs.length > 1 && len > 2 ? 1.5 : 0))} ${C}`} strokeDashoffset={-acc}
                style={{ transition: "stroke-dasharray .3s, stroke-dashoffset .3s" }} />
            );
            acc += len;
            return el;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {center}
        </div>
      </div>
    );
  };

  /** 一个维度一张卡：圆环 + 每行（名称、段数、实际 %、目标 % 输入）。普通函数，不是组件（不然输入框会丢焦点） */
  const donutCard = ({ title, segs, extra, hint, foot }: { title: ReactNode; segs: Seg[]; extra?: ReactNode; hint?: string; foot?: ReactNode }) => {
    const t = segs.reduce((a, s) => a + s.count, 0);
    const tgtSum = segs.reduce((a, s) => a + (s.onTarget ? s.target ?? 0 : 0), 0);
    const hasT = segs.some((s) => s.onTarget);
    return (
      <div style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>
            {hint ? <Tooltip title={hint}><span style={{ borderBottom: `1px dashed ${muted}` }}>{title}</span></Tooltip> : title}
          </span>
          {extra}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flex: 1 }}>
          {donut(segs, <><b style={{ fontSize: 20, lineHeight: 1 }}>{t}</b><span style={{ fontSize: 11, color: muted }}>段</span></>)}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {segs.map((s) => {
              const act = t ? (s.count / t) * 100 : 0;
              const want = hasT && tgtSum ? ((s.target ?? 0) / tgtSum) * 100 : null;
              const off = want != null && Math.abs(act - want) > 2.5 && t > 0;
              return (
                <div key={s.key}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <i style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flex: "none" }} />
                    <span style={typeof s.label === "string" || (s.label as { type?: unknown })?.type === "b"
                      ? { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                      : { flex: 1, minWidth: "fit-content", display: "flex", alignItems: "center" }}>
                      {s.tip ? <Tooltip title={s.tip}>{s.label}</Tooltip> : s.label}
                    </span>
                    <b style={{ fontSize: 15, flex: "none" }}>{s.count}</b>
                    <Tooltip title={off ? `目标 ${want!.toFixed(0)}%，受别的维度或可用数据限制，实际 ${act.toFixed(0)}%` : "实际占比"}>
                      <span style={{ width: 34, textAlign: "right", fontSize: 12, color: off ? token.colorWarning : muted, flex: "none" }}>{act.toFixed(0)}%</span>
                    </Tooltip>
                    {s.onTarget && (
                      <Tooltip title="目标 %：改了圆环立刻变">
                        <InputNumber size="small" min={0} max={100} value={s.target ?? 0} disabled={frozen}
                          style={{ width: 88, flex: "none" }} addonAfter="%"
                          onChange={(v) => s.onTarget!(Number(v ?? 0))} />
                      </Tooltip>
                    )}
                    <Got want={s.count} have={s.got} />
                    {s.onRemove && !frozen && <CloseOutlined style={{ fontSize: 10, color: muted, cursor: "pointer", flex: "none" }} onClick={s.onRemove} />}
                  </div>
                  {s.empty && <div style={{ fontSize: 12, color: token.colorError, marginLeft: 16 }}>{s.empty}</div>}
                  {s.sub && <div style={{ fontSize: 12, color: muted, marginLeft: 16, lineHeight: 1.4 }}>{s.sub}</div>}
                </div>
              );
            })}
            {foot}
          </div>
        </div>
        {hasT && (
          <div style={{ fontSize: 12, color: token.colorWarning, marginTop: 8, minHeight: 18, textAlign: "right",
            visibility: tgtSum !== 100 ? "visible" : "hidden" }}>
            目标合计 {tgtSum}%，按比例换算
          </div>
        )}
      </div>
    );
  };

  type NegCat = { name: string; anchors: string[]; ratio: number; anchor_ratios?: Record<string, number> | null };
  /** 分类内各中心动作的比例：没填过的均分 */
  const anchorPct = (cat: NegCat, a: string) => cat.anchor_ratios?.[a] ?? Math.round(100 / Math.max(1, cat.anchors.length));
  const setCat = (j: number, fn: (c: NegCat) => NegCat) =>
    update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).map((x, i) => (i === j ? fn(x as NegCat) : x)) }));
  /** 分类内各动作占比：一根堆叠条，块里写「舔 10」，同一分类颜色深浅区分 */
  const anchorBar = (cat: NegCat, count: number, color: string) => {
    const ws = cat.anchors.map((a) => anchorPct(cat, a));
    const sum = ws.reduce((a, b) => a + b, 0);
    const ns = splitByRatio(count, ws);
    return (
      <div style={{ flex: 1, minWidth: 0, display: "flex", height: 18, borderRadius: 4, overflow: "hidden", background: token.colorFillQuaternary }}>
        {cat.anchors.map((a, i) => ws[i] > 0 && (
          <Tooltip key={a} title={`${a}：${sum ? Math.round((ws[i] / sum) * 100) : 0}% · ${ns[i]} 段`}>
            <div style={{ flex: ws[i], minWidth: 0, background: color, opacity: 1 - (i * 0.55) / Math.max(1, cat.anchors.length - 1),
              color: "#fff", fontSize: 11, lineHeight: "18px", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden",
              textOverflow: "ellipsis", padding: "0 3px", borderRight: i < cat.anchors.length - 1 ? `1px solid ${token.colorBgContainer}` : undefined }}>
              {a} {ns[i]}
            </div>
          </Tooltip>
        ))}
      </div>
    );
  };
  const anchorEditor = (j: number, cat: NegCat, count: number, color: string) => {
    const ws = cat.anchors.map((a) => anchorPct(cat, a));
    const sum = ws.reduce((a, b) => a + b, 0);
    const ns = splitByRatio(count, ws);
    return (
      <Popover trigger="click" title="编辑分类：类别和各自比例" content={
        <div style={{ width: 340, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input size="small" placeholder="分类名称" value={cat.name} disabled={frozen} style={{ flex: 1 }}
              onChange={(e) => setCat(j, (c) => ({ ...c, name: e.target.value }))} />
            <InputNumber size="small" min={0} max={100} value={cat.ratio} disabled={frozen} addonAfter="%" style={{ width: 96, flex: "none" }}
              onChange={(v) => setCat(j, (c) => ({ ...c, ratio: Number(v ?? 0) }))} />
          </div>
          <div style={{ fontSize: 12, color: muted }}>这一类 {count} 段，按下面的比例分给各个动作（某个动作不够时用同类别的动作补）</div>
          {cat.anchors.length > 0 && <div style={{ display: "flex" }}>{anchorBar(cat, count, color)}</div>}
          {cat.anchors.map((a, i) => (
            <div key={a} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{a}</span>
              <b style={{ width: 32, textAlign: "right" }}>{ns[i]}</b>
              <InputNumber size="small" min={0} max={100} value={ws[i]} disabled={frozen} addonAfter="%" style={{ width: 96, flex: "none" }}
                onChange={(v) => setCat(j, (c) => ({ ...c, anchor_ratios: { ...Object.fromEntries(c.anchors.map((x) => [x, anchorPct(c, x)])), [a]: Number(v ?? 0) } }))} />
              {!frozen && <CloseOutlined style={{ fontSize: 10, color: muted, cursor: "pointer" }}
                onClick={() => setCat(j, (c) => ({ ...c, anchors: c.anchors.filter((x) => x !== a) }))} />}
            </div>
          ))}
          {cat.anchors.length > 1 && sum !== 100 && (
            <div style={{ fontSize: 12, color: token.colorWarning }}>合计 {sum}%，按比例换算</div>
          )}
          <TreeSelect size="small" style={{ width: "100%" }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} maxTagCount={0}
            maxTagPlaceholder={() => <span><PlusOutlined /> 增减类别（已选 {cat.anchors.length}）</span>}
            disabled={frozen} treeData={otherTree} value={cat.anchors} placeholder="选择包含的动作类别"
            onChange={(v) => setCat(j, (c) => {
              const anchors = v as string[];
              const keep = Object.fromEntries(anchors.filter((a) => c.anchor_ratios?.[a] != null).map((a) => [a, c.anchor_ratios![a]]));
              return { ...c, anchors, anchor_ratios: Object.keys(keep).length ? keep : null };
            })} />
        </div>}>
        <div style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
          {cat.anchors.length ? anchorBar(cat, count, color) : <span>（未选类别）</span>}
          {!frozen && <EditOutlined style={{ fontSize: 11, flex: "none" }} />}
        </div>
      </Popover>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 总数 + 操作 + 条件 */}
      <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", justifyContent: "space-between" }}>
        <Space size={12} wrap>
          <span style={{ fontSize: 13, color: muted }}>总数</span>
          <InputNumber min={1} max={5000} value={alloc.total ?? 0} disabled={frozen} onChange={(v) => setAlloc({ total: Number(v ?? 0) })}
            style={{ width: 130 }} size="large" addonAfter="段" />
          {[200, 300, 500].map((n) => (
            <Button key={n} size="small" disabled={frozen} type={alloc.total === n ? "primary" : "default"} onClick={() => setAlloc({ total: n })}>{n}</Button>))}
          <span style={{ fontSize: 13, color: muted }}>视频约 {hours.toFixed(1)} 小时</span>
        </Space>
        <Space size={8} wrap>
          <Tooltip title="按这份配比在真实数据里试挑一遍，看每格能不能挑够（不写库，约 20 秒）">
            <Button loading={busy === "check"} onClick={() => run("check")}>检查够不够</Button>
          </Tooltip>
          <Button disabled={frozen} loading={busy === "save"} onClick={() => run("save")}>保存配比</Button>
          {existing > 0 ? (
            <Popconfirm title={`重新生成：先删掉测试集里已有的 ${existing} 段，再按配比生成 ${total} 段`}
              description="只删测试集里的片段记录（勾过的「核对」也一起清掉），任务和标注都不动。删了不能恢复。"
              okText="删掉重新生成" okButtonProps={{ danger: true }}
              onConfirm={() => run("apply")} disabled={frozen || !total}>
              <Button type="primary" disabled={frozen || !total} loading={busy === "apply"}>生成 {total} 段</Button>
            </Popconfirm>
          ) : (
            <Button type="primary" disabled={frozen || !total} loading={busy === "apply"} onClick={() => run("apply")}>生成 {total} 段</Button>
          )}
        </Space>
        <Space size={[10, 6]} wrap style={{ width: "100%", fontSize: 12 }}>
          <Select size="small" style={{ width: 100 }} value={plan.target} options={tops.map((t) => ({ value: t, label: t }))}
            onChange={(v) => update((p) => ({ ...p, target: v, parts: [], neg_cats: v === "抓挠" ? DEFAULT_NEG : [] }))} />
          <DatePicker.RangePicker size="small" allowEmpty={[true, true]}
            value={[plan.date_from ? dayjs(plan.date_from) : null, plan.date_to ? dayjs(plan.date_to) : null] as [Dayjs | null, Dayjs | null]}
            onChange={(v) => update((p) => ({ ...p, date_from: v?.[0]?.format("YYYY-MM-DD") ?? null, date_to: v?.[1]?.format("YYYY-MM-DD") ?? null }))} />
          <Segmented size="small" value={plan.source ?? "any"} onChange={(v) => update((p) => ({ ...p, source: v as Plan["source"] }))}
            options={[{ value: "any", label: "人工+AI" }, { value: "human", label: "人工标过" }, { value: "ai", label: "AI 预标" }]} />
          <Tooltip title="相对 #56 / #61 / #62 的训练数据">
            <Segmented size="small" value={plan.seen_mode ?? "any"}
              onChange={(v) => update((p) => ({ ...p, seen_mode: v as Plan["seen_mode"], model_ids: v === "any" ? null : p.model_ids ?? [56, 61, 62] }))}
              options={[{ value: "any", label: "见没见过都行" }, { value: "unseen", label: "模型没见过" }, { value: "seen", label: "模型见过" }]} />
          </Tooltip>
          {availLoading && <span style={{ color: muted }}><Spin size="small" /> 统计可用量…</span>}
        </Space>
      </div>

      {/* 检查结果 */}
      {busy === "check" && <div style={{ ...card, color: muted }}><Spin size="small" /> 正在按这份配比在真实数据里试挑（{total} 段，约 20 秒）…</div>}
      {result && busy !== "check" && (
        <div style={{ ...card, borderColor: result.n_picked < total ? token.colorWarningBorder : token.colorSuccessBorder,
          background: result.n_picked < total ? token.colorWarningBg : token.colorSuccessBg }}>
          <div style={{ fontSize: 15 }}>
            能挑到 <b style={{ fontSize: 20 }}>{result.n_picked}</b> / {total} 段 · 视频 {result.video_hours} 小时
            {Object.entries(result.by_source).map(([k, v]) => <span key={k} style={{ marginLeft: 12, color: muted }}>{k} {v}</span>)}
          </div>
          {shortages.length > 0 && <div style={{ marginTop: 6, fontSize: 13 }}>缺：{shortages.join("；")}</div>}
          {result.added != null && <div style={{ marginTop: 6, fontSize: 13 }}>已写进测试集，到「片段」里核对。</div>}
        </div>
      )}

      {/* 六个圆环 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))", gap: 14 }}>
        {donutCard({
          title: "场所", segs: SITE_ORDER.map((s) => ({
            key: s, label: SITE_SHORT[s], count: bySite[s] ?? 0, color: SITE_COLORS[s], target: alloc.site?.[s] ?? 0,
            onTarget: (v) => setAlloc({ site: { ...(alloc.site ?? {}), [s]: v } }), got: gotBy((d) => d.site ?? "", s),
            empty: (alloc.site?.[s] ?? 0) > 0 && !(bySite[s] ?? 0) && avail ? (siteAvail(s) ? undefined : "当前条件下没有可用数据") : undefined,
          })),
        })}
        {donutCard({
          title: "体型", hint: "场所和体型的目标同时尽量满足；做不到的（比如小型犬只在影棚和雷诺）实际 % 标橙色",
          segs: SIZES.map((z) => ({
            key: z, label: `${z}型`, count: bySize[z] ?? 0, color: SIZE_COLORS[z], target: alloc.size?.[z] ?? 0,
            onTarget: (v) => setAlloc({ size: { ...(alloc.size ?? {}), [z]: v } }), got: gotBy((d) => d.size ?? "", z),
            empty: (alloc.size?.[z] ?? 0) > 0 && !(bySize[z] ?? 0) && avail ? (sizeAvail(z) ? undefined : "当前条件下没有可用数据") : undefined,
          })),
          extra: <Segmented size="small" value={alloc.dog ?? "even"} onChange={(v) => setAlloc({ dog: v as Alloc["dog"] })}
            options={[{ value: "even", label: "狗平均" }, { value: "avail", label: "按可用量" }]} />,
        })}
        {donutCard({
          title: "时长", segs: durs.map((d, i) => ({
            key: String(d), color: DUR_COLORS[i % DUR_COLORS.length], count: byDur[String(d)] ?? 0, target: durT(d),
            label: (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                {/* 分钟数输完（回车 / 点别处）才生效 */}
                <InputNumber key={`m${d}`} size="small" min={0.5} max={60} defaultValue={d / 60} disabled={frozen} style={{ width: 104 }}
                  addonAfter="分钟"
                  onPressEnter={(e) => changeDur(d, Number((e.target as HTMLInputElement).value))}
                  onBlur={(e) => changeDur(d, Number(e.target.value))} />
              </span>),
            onTarget: (v) => setAlloc({ dur: { ...(alloc.dur ?? {}), [String(d)]: v } }),
            onRemove: durs.length > 1 ? () => update((p) => ({ ...p, durations: p.durations.filter((x) => x !== d) })) : undefined,
            got: result ? (gotDur(d, 0) ?? 0) + (gotDur(d, 1) ?? 0) : null,
          })),
          extra: !frozen && (
            <Popover trigger="click" content={<Space>
              <InputNumber size="small" min={0.5} max={60} value={newMin ?? undefined} onChange={(v) => setNewMin(v)} addonAfter="分钟" style={{ width: 120 }} />
              <Button size="small" type="primary" onClick={() => {
                const s = Math.round((newMin ?? 0) * 60);
                if (s > 0 && !durs.includes(s)) update((p) => {
                  const a = (p.alloc ?? DEFAULT_ALLOC) as Alloc;
                  return { ...p, durations: [...p.durations, s].sort((x, y) => x - y),
                    alloc: { ...a, dur: { ...(a.dur ?? {}), [String(s)]: Math.round(100 / (p.durations.length + 1)) } } };
                });
              }}>加</Button></Space>}>
              <a style={{ fontSize: 13 }}><PlusOutlined /> 时长</a>
            </Popover>),
        })}
        {donutCard({
          title: `有 / 无${plan.target}`, segs: [
            { key: "pos", label: `有${plan.target}`, count: posTotal, color: accent, target: alloc.pos ?? 50, onTarget: (v) => setAlloc({ pos: v }),
              got: result ? durs.reduce((a, d) => a + (gotDur(d, 0) ?? 0), 0) : null },
            { key: "neg", label: `无${plan.target}`, count: negTotal, color: NEG_BLUE, target: alloc.neg ?? 50, onTarget: (v) => setAlloc({ neg: v }),
              got: result ? durs.reduce((a, d) => a + (gotDur(d, 1) ?? 0), 0) : null },
          ],
        })}
        {donutCard({
          title: <span>有{plan.target} · 部位</span>,
          segs: plan.parts.length ? plan.parts.map((k, i) => ({
            key: k, label: k.replace(`${plan.target}-`, ""), count: byPart[k] ?? 0, color: PART_COLORS[i % PART_COLORS.length],
            target: partT(k), onTarget: (v) => setAlloc({ part: { ...(alloc.part ?? {}), [k]: v } }),
            onRemove: () => update((p) => ({ ...p, parts: p.parts.filter((x) => x !== k) })), got: gotPart(k),
            sub: `可用 ${allDogs.filter((d) => !excluded.has(d.id)).reduce((a, d) => a + availOf(d.id, k), 0)}`,
          })) : [{ key: "all", label: "不分部位", count: posTotal, color: accent }],
          extra: !frozen && (
            <TreeSelect size="small" style={{ minWidth: 120 }} placeholder={<span><PlusOutlined /> 部位</span>} value={null as never}
              treeData={subtree(plan.target)}
              onChange={(v) => { const n = v as unknown as string; if (n && !plan.parts.includes(n)) {
                update((p) => ({ ...p, parts: [...p.parts, n],
                  alloc: { ...((p.alloc ?? DEFAULT_ALLOC) as Alloc), part: { ...(((p.alloc ?? DEFAULT_ALLOC) as Alloc).part ?? {}), [n]: Math.round(100 / (p.parts.length + 1)) } } }));
              } }} />),
        })}
        {donutCard({
          title: <span>无{plan.target} · 分类</span>,
          segs: negCats.length ? negCats.map((c, j) => ({
            key: c.name, label: <b style={{ color: NEG_COLORS[j % NEG_COLORS.length] }}>{c.name}</b>, tip: NEG_TIPS[c.name],
            count: negByCat[j], color: NEG_COLORS[j % NEG_COLORS.length], target: c.ratio,
            onTarget: (v) => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).map((x, i) => (i === j ? { ...x, ratio: v } : x)) })),
            onRemove: () => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).filter((_, i) => i !== j) })),
            got: gotCat(c.name), sub: anchorEditor(j, c, negByCat[j], NEG_COLORS[j % NEG_COLORS.length]),
          })) : [{ key: "all", label: "不分类", count: negTotal, color: NEG_BLUE }],
          extra: !frozen && (
            <Popover trigger="click" content={<Space direction="vertical">
              <Input size="small" placeholder="分类名，如 进食饮水" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
              <TreeSelect size="small" style={{ width: 240 }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} maxTagCount={3}
                placeholder="以哪些动作为中心" treeData={otherTree} value={newCat.anchors} onChange={(v) => setNewCat({ ...newCat, anchors: v as string[] })} />
              <Button size="small" type="primary" disabled={!newCat.name.trim() || !newCat.anchors.length} onClick={() => {
                update((p) => ({ ...p, neg_cats: [...(p.neg_cats ?? []), { name: newCat.name.trim(), anchors: newCat.anchors, ratio: 10 }] }));
                setNewCat({ name: "", anchors: [] });
              }}>加</Button></Space>}>
              <a style={{ fontSize: 13 }}><PlusOutlined /> 分类</a>
            </Popover>),
        })}
      </div>

      {/* 当前筛选条件下可用目标动作的真实时长阶梯分布 + 自适应抽样说明 */}
      {avail?.dur_buckets && avail.dur_buckets.some((b) => b.n > 0) && (() => {
        const buckets = avail.dur_buckets;
        const tot = buckets.reduce((a, b) => a + b.n, 0) || 1;
        const maxN = Math.max(1, ...buckets.map((b) => b.n));
        const bColors = ["#faad14", "#52c41a", "#1677ff", "#722ed1", "#eb2f96"];
        return (
          <div style={{
            padding: "10px 14px", borderRadius: 8,
            border: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                可用「{plan.target}」实际时长阶梯分布 <span style={{ fontWeight: 400, color: muted, fontSize: 12 }}>（共 {tot} 段）</span>
              </span>
              <span style={{ fontSize: 12, color: muted }}>
                自适应抽样：≤1 分钟窗优先挑 &lt;30s 短/常规动作；≥3 分钟窗优先挑 ≥30s 长动作，且优先单事件干净窗口
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${buckets.length}, minmax(95px, 1fr))`, gap: 10 }}>
              {buckets.map((b, i) => {
                const pctVal = (b.n / tot) * 100;
                const barW = Math.round((b.n / maxN) * 100);
                const c = bColors[i % bColors.length];
                return (
                  <div key={b.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ fontWeight: 600 }}>{b.label}</span>
                      <span style={{ color: muted }}>{b.n} 段 · {pctVal.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: token.colorFillSecondary, overflow: "hidden" }}>
                      <div style={{ width: `${barW}%`, height: "100%", borderRadius: 3, background: c, transition: "width .25s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* 按狗明细（可展开）：每只狗一个小块——名字 + 段数 + 一根细条（有 / 无 占比）；细节放悬停里，点一下去掉 / 纳入 */}
      <Collapse size="small" items={[{
        key: "dogs",
        label: <span>按狗明细 · {derived.length} 只狗分到了段数{excluded.size ? ` · 去掉了 ${excluded.size} 只` : ""}</span>,
        children: (() => {
          const rows = allDogs.map((d) => ({ d, x: derived.find((x) => x.dog_id === d.id) }));
          const maxSum = Math.max(1, ...rows.map((r) => (r.x ? dogSum(r.x) : 0)));
          const toggle = (id: number) => !frozen &&
            setAlloc({ exclude: excluded.has(id) ? (alloc.exclude ?? []).filter((i) => i !== id) : [...(alloc.exclude ?? []), id] });
          const dot = (c: string) => <i style={{ width: 8, height: 8, borderRadius: 4, background: c, display: "inline-block" }} />;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 14, fontSize: 12, color: muted }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{dot(accent)}有{plan.target}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{dot(NEG_BLUE)}无{plan.target}</span>
                <span style={{ color: token.colorTextQuaternary }}>点狗可去掉 / 纳入</span>
              </div>
              {SITE_ORDER.map((site) => {
                const rs = rows.filter((r) => r.d.site === site);
                if (!rs.length) return null;
                const siteSum = rs.reduce((a, r) => a + (r.x ? dogSum(r.x) : 0), 0);
                return (
                  <div key={site}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, marginBottom: 6 }}>
                      <b style={{ color: SITE_COLORS[site] }}>{SITE_SHORT[site]}</b>
                      <span style={{ color: muted }}>{siteSum}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
                      {rs.map(({ d, x }) => {
                        const on = !excluded.has(d.id);
                        const sum = x ? dogSum(x) : 0;
                        const pos = x ? durs.reduce((a, dd) => a + qOf(x, dd)[0], 0) : 0;
                        const r = rep[String(d.id)];
                        const lack = result && x ? durs.some((dd) => ([0, 1] as const).some((k) => (r?.q?.[String(dd)]?.[k] ?? 0) < qOf(x, dd)[k])) : false;
                        const tip = (
                          <div style={{ fontSize: 12 }}>
                            <div>{d.name} · {d.size ?? "?"}型{d.breed ? ` · ${d.breed}` : ""}</div>
                            <div>可用 {availOf(d.id)} 段</div>
                            {x && durs.map((dd) => (
                              <div key={dd}>{durLabel(dd)}：有 {qOf(x, dd)[0]} / 无 {qOf(x, dd)[1]}
                                {result && ` （挑到 ${r?.q?.[String(dd)]?.[0] ?? 0} / ${r?.q?.[String(dd)]?.[1] ?? 0}）`}</div>
                            ))}
                            {x && plan.parts.some((k) => x.p[k]) && <div>部位：{plan.parts.filter((k) => x.p[k]).map((k) => `${k.replace(`${plan.target}-`, "")} ${x.p[k]}`).join(" · ")}</div>}
                            <div style={{ opacity: 0.6, marginTop: 2 }}>{on ? "点一下去掉" : "点一下纳入"}</div>
                          </div>
                        );
                        return (
                          <Tooltip key={d.id} title={tip}>
                            <div onClick={() => toggle(d.id)} style={{ cursor: frozen ? "default" : "pointer", padding: "6px 8px", borderRadius: 6,
                              background: token.colorFillQuaternary, opacity: on ? (sum ? 1 : 0.45) : 0.25,
                              outline: lack ? `1px solid ${token.colorError}` : undefined,
                              textDecoration: on ? undefined : "line-through" }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{d.name}</span>
                                <span style={{ fontSize: 11, color: SIZE_COLORS[d.size ?? ""] ?? muted }}>{d.size}</span>
                                <b style={{ fontSize: 15, minWidth: 18, textAlign: "right" }}>{sum || "–"}</b>
                              </div>
                              <div style={{ height: 4, marginTop: 5, borderRadius: 2, background: token.colorFillTertiary, overflow: "hidden" }}>
                                <div style={{ width: `${(sum / maxSum) * 100}%`, height: "100%", display: "flex" }}>
                                  <div style={{ flex: pos, background: accent }} />
                                  <div style={{ flex: sum - pos, background: NEG_BLUE }} />
                                </div>
                              </div>
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })(),
      }]} />
    </div>
  );
}
