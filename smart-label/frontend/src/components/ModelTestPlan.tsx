/**
 * 配比：填一个总数，按维度调比例（场所 / 体型 / 时长 / 有无 / 部位 / 没抓挠的分类），改一个数条形图立刻跟着变。
 * 每只狗分多少是算出来的（不用手填）；「检查够不够」按这份配比在真实数据里试挑一遍（不写库），「生成」写进测试集。
 * 分配：场所 → 狗（体型比例 ×［按可用量］）→ 时长 → 有/无 → 部位，每一层整批摊（最大余数 + 行列都守住），合计正好是总数。
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Checkbox, Collapse, DatePicker, Input, InputNumber, Popconfirm, Popover, Segmented, Select, Space, Spin, Table, Tooltip, TreeSelect, message, theme } from "antd";
import { CloseOutlined, PlusOutlined } from "@ant-design/icons";
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
  { name: "像抓挠的动作", anchors: ["舔", "啃", "蹭", "甩头/抖身"], ratio: 4 },
  { name: "正常活动", anchors: ["活动"], ratio: 2 },
  { name: "休息睡眠", anchors: ["静止/休息"], ratio: 3 },
  { name: "未佩戴", anchors: ["未佩戴"], ratio: 1 },
];
const NEG_TIPS: Record<string, string> = {
  像抓挠的动作: "舔、啃、蹭、甩头：项圈也会反复晃，最容易被报成抓挠。凑不齐时优先保它",
  正常活动: "走、跑、转圈、玩：看狗一动起来会不会乱报",
  休息睡眠: "趴着、侧躺睡：一动不动时报抓挠肯定是错的",
  未佩戴: "项圈摘下来、设备还在录：没戴还报抓挠算硬伤",
};
type Alloc = NonNullable<Plan["alloc"]> & { total?: number; exclude?: number[] };
const DEFAULT_ALLOC: Alloc = { total: 200, site: { 佛山博朗旺狗场: 81, 公司影棚: 13, 深圳雷诺狗场: 6 }, size: { 小: 1, 中: 1, 大: 1 },
  dur: {}, pos: 1, neg: 1, part: {}, dog: "even", exclude: [] };
const durLabel = (s: number) => (s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`);

/** n 按比例摊（最大余数），合计正好 n；跟后端 split_by_ratio 同一套 */
const splitByRatio = (n: number, ratios: number[]): number[] => {
  const tot = ratios.reduce((a, b) => a + b, 0);
  if (n <= 0 || tot <= 0) return ratios.map(() => 0);
  const raw = ratios.map((r) => (n * r) / tot);
  const base = raw.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  raw.map((x, j) => [x - Math.floor(x), j] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, j]) => { if (left > 0) { base[j]++; left--; } });
  return base;
};
/** 整批摊：行合计、列合计都守住；跟后端 split_grid 同一套 */
const splitGrid = (rows: number[], cols: number[]): number[][] => {
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
};

type Seg = { key: string; label: ReactNode; count: number; color: string; weight?: number; onWeight?: (v: number) => void;
  onRemove?: () => void; extra?: ReactNode; got?: number | null };

export default function ModelTestPlan({ setId, initial, frozen, accent = "#27AE60", existing = 0, onApplied }: {
  setId: number; initial?: Plan | null; frozen?: boolean; accent?: string; existing?: number; onApplied?: () => void;
}) {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<Plan>(() => {
    const p = initial ?? { target: "抓挠", durations: [60, 600], parts: [], dogs: [] };
    return {
      ...p,
      neg_cats: p.neg_cats ?? (p.target === "抓挠" ? DEFAULT_NEG : []),
      alloc: { ...DEFAULT_ALLOC, ...(p.alloc ?? {}) } as Alloc,
    };
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

  // ── 由总数 + 比例算出每只狗的配额 ──
  const durs = plan.durations;
  const derived = useMemo(() => {
    const N = Math.max(0, Math.round(alloc.total ?? 0));
    const eligible = allDogs.filter((d) => !excluded.has(d.id) && (alloc.site?.[d.site ?? ""] ?? 0) > 0 && (!avail || availOf(d.id) > 0));
    const sites = SITE_ORDER.filter((s) => eligible.some((d) => d.site === s));
    const perSite = splitByRatio(N, sites.map((s) => alloc.site?.[s] ?? 0));
    const dogN = new Map<number, number>();
    sites.forEach((s, i) => {
      const ds = eligible.filter((d) => d.site === s);
      splitByRatio(perSite[i], ds.map((d) => (alloc.size?.[d.size ?? ""] ?? 1) * (alloc.dog === "avail" ? availOf(d.id) : 1)))
        .forEach((n, j) => dogN.set(ds[j].id, n));
    });
    const ids = eligible.map((d) => d.id).filter((id) => (dogN.get(id) ?? 0) > 0);
    const durG = splitGrid(ids.map((id) => dogN.get(id) ?? 0), splitByRatio(N, durs.map((d) => alloc.dur?.[String(d)] ?? 1)));
    const cells = ids.flatMap((id, i) => durs.map((d, j) => ({ id, d, n: durG[i][j] })));
    const pnG = splitGrid(cells.map((c) => c.n), splitByRatio(N, [alloc.pos ?? 1, alloc.neg ?? 1]));
    const q = new Map<number, Record<string, [number, number]>>();
    cells.forEach((c, i) => {
      const m = q.get(c.id) ?? {};
      m[String(c.d)] = [pnG[i][0], pnG[i][1]];
      q.set(c.id, m);
    });
    const posOf = (id: number) => durs.reduce((a, d) => a + (q.get(id)?.[String(d)]?.[0] ?? 0), 0);
    const posTot = ids.reduce((a, id) => a + posOf(id), 0);
    const partG = plan.parts.length ? splitGrid(ids.map(posOf), splitByRatio(posTot, plan.parts.map((k) => alloc.part?.[k] ?? 1))) : ids.map(() => []);
    return ids.map((id, i) => ({ dog_id: id, q: q.get(id) ?? {}, p: Object.fromEntries(plan.parts.map((k, j) => [k, partG[i][j] ?? 0])) })) as PlanDog[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, allDogs, avail]);
  const planOut: Plan = { ...plan, dogs: derived };

  // ── 汇总 ──
  const byId = new Map(allDogs.map((d) => [d.id, d]));
  const qOf = (x: PlanDog, d: number) => (x.q[String(d)] as [number, number]) ?? [0, 0];
  const sumBy = (key: (d: Dog) => string) => {
    const m: Record<string, number> = {};
    derived.forEach((x) => { const d = byId.get(x.dog_id); if (!d) return; const k = key(d); m[k] = (m[k] ?? 0) + durs.reduce((a, dd) => a + qOf(x, dd)[0] + qOf(x, dd)[1], 0); });
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
  // 没抓挠的分类：每种时长整批摊（跟后端一样），再加起来
  const negByCat = negCats.map(() => 0);
  const negByCatDur: Record<string, number[]> = {};
  durs.forEach((d) => {
    const rows = derived.map((x) => qOf(x, d)[1]);
    const g = splitGrid(rows, splitByRatio(rows.reduce((a, b) => a + b, 0), negCats.map((c) => c.ratio)));
    negByCatDur[String(d)] = negCats.map((_, j) => g.reduce((a, r) => a + r[j], 0));
    negByCatDur[String(d)].forEach((n, j) => { negByCat[j] += n; });
  });
  const hours = derived.reduce((a, x) => a + durs.reduce((b, d) => b + (qOf(x, d)[0] + qOf(x, d)[1]) * d, 0), 0) / 3600;

  // 检查结果按维度汇总
  const rep = result?.report ?? {};
  const gotDur = (d: number, k: 0 | 1) => (result ? Object.values(rep).reduce((a, r) => a + (r.q?.[String(d)]?.[k] ?? 0), 0) : null);
  const gotPart = (k: string) => (result ? Object.values(rep).reduce((a, r) => a + (r.p?.[k] ?? 0), 0) : null);
  const gotCat = (name: string) => (result ? Object.values(rep).reduce((a, r) => a + durs.reduce((b, d) => b + (r.n?.[String(d)]?.[name] ?? 0), 0), 0) : null);
  const shortages = result ? derived.flatMap((x) => {
    const r = rep[String(x.dog_id)];
    return durs.flatMap((d) => ([0, 1] as const).map((k) => {
      const want = qOf(x, d)[k], have = r?.q?.[String(d)]?.[k] ?? 0;
      return want > have ? `${byId.get(x.dog_id)?.name} ${durLabel(d)}${k === 0 ? "有" : "无"}${plan.target} 缺 ${want - have}` : null;
    }).filter(Boolean) as string[]);
  }) : [];

  const run = async (kind: "check" | "apply" | "save") => {
    if (!total && kind !== "save") return message.warning("总数是 0，或者比例都是 0");
    setBusy(kind);
    try {
      if (kind === "save") { await planSave(setId, planOut); message.success("配比已保存"); return; }
      const r = kind === "check" ? await planPreview(setId, planOut) : await planApply(setId, planOut);
      setResult(r);
      if (kind === "apply") {
        message.success(`已加进测试集 ${r.added ?? r.n_picked} 段`);
        qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
        qc.invalidateQueries({ queryKey: ["model-test-sets"] });
        onApplied?.();
      }
    } finally { setBusy(""); }
  };

  // ── 样式 ──
  const line = token.colorBorderSecondary;
  const muted = token.colorTextSecondary;
  const card: CSSProperties = { border: `1px solid ${line}`, borderRadius: 10, padding: "14px 16px", background: token.colorBgContainer };
  const w = (value: number | undefined, onChange: (v: number) => void, width = 52) => (
    <InputNumber size="small" min={0} max={1000} value={value ?? 0} disabled={frozen} style={{ width }}
      onChange={(v) => onChange(Number(v ?? 0))} />
  );
  const Got = ({ want, have }: { want: number; have: number | null | undefined }) =>
    have == null ? null : <span style={{ fontSize: 12, fontWeight: 600, color: have < want ? token.colorError : token.colorSuccess }}>{have < want ? `挑到 ${have}` : "✓"}</span>;

  /** 一个维度：标题 + 实时条形图 + 每块的段数 / 占比 / 比例输入。
   *  普通函数、不是组件：写成组件的话每次重渲染都换一个新组件，输入框打一个字就丢焦点 */
  const dimRow = ({ title, segs, extra, hint }: { title: string; segs: Seg[]; extra?: ReactNode; hint?: string }) => {
    const t = segs.reduce((a, s) => a + s.count, 0) || 1;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: 14, alignItems: "start", padding: "12px 0", borderTop: `1px solid ${line}` }}>
        <div style={{ fontWeight: 700, fontSize: 14, paddingTop: 2 }}>
          {hint ? <Tooltip title={hint}><span style={{ borderBottom: `1px dashed ${muted}` }}>{title}</span></Tooltip> : title}
        </div>
        <div>
          <div style={{ height: 22, display: "flex", borderRadius: 5, overflow: "hidden", background: token.colorFillTertiary }}>
            {segs.map((s) => (
              <div key={s.key} style={{ width: `${(s.count / t) * 100}%`, background: s.color, color: "#fff", fontSize: 12, fontWeight: 600,
                lineHeight: "22px", paddingLeft: 6, whiteSpace: "nowrap", overflow: "hidden", transition: "width .25s" }}>
                {s.count / t > 0.08 ? s.count : ""}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", marginTop: 8, alignItems: "center" }}>
            {segs.map((s) => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
                {s.label}<b style={{ fontSize: 15 }}>{s.count}</b><span style={{ color: muted }}>{((s.count / t) * 100).toFixed(0)}%</span>
                {s.onWeight && <Tooltip title="比例：改了上面的条立刻变">{w(s.weight, s.onWeight)}</Tooltip>}
                {s.extra}
                <Got want={s.count} have={s.got} />
                {s.onRemove && !frozen && <CloseOutlined style={{ fontSize: 10, color: muted, cursor: "pointer" }} onClick={s.onRemove} />}
              </span>
            ))}
            {extra}
          </div>
        </div>
      </div>
    );
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 顶部：总数 + 条件 + 操作 */}
      <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        <Space size={12} wrap>
          <span style={{ fontSize: 13, color: muted }}>总数</span>
          <InputNumber min={1} max={5000} value={alloc.total ?? 0} disabled={frozen} onChange={(v) => setAlloc({ total: Number(v ?? 0) })}
            style={{ width: 120, fontSize: 22, fontWeight: 700 }} size="large" addonAfter="段" />
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
            <Popconfirm title={`测试集里已有 ${existing} 段，再生成会再加 ${total} 段（不跟已有的重叠）`} okText="再加一批"
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
      {busy === "check" && (
        <div style={{ ...card, color: muted }}><Spin size="small" /> 正在按这份配比在真实数据里试挑（{total} 段，约 20 秒）…</div>
      )}
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

      {/* 维度 */}
      <div style={{ ...card, paddingTop: 4, paddingBottom: 4 }}>
        {dimRow({ title: "场所", segs: SITE_ORDER.map((s) => ({
          key: s, label: SITE_SHORT[s], count: bySite[s] ?? 0, color: SITE_COLORS[s], weight: alloc.site?.[s] ?? 0,
          onWeight: (v) => setAlloc({ site: { ...(alloc.site ?? {}), [s]: v } }),
        })) })}
        {dimRow({ title: "体型", hint: "体型比例在每个场所内部起作用（小型犬只在影棚和雷诺）；实际比例以条上为准",
          segs: SIZES.map((s) => ({
            key: s, label: `${s}型`, count: bySize[s] ?? 0, color: SIZE_COLORS[s], weight: alloc.size?.[s] ?? 1,
            onWeight: (v) => setAlloc({ size: { ...(alloc.size ?? {}), [s]: v } }),
          })),
          extra: <Segmented size="small" value={alloc.dog ?? "even"} onChange={(v) => setAlloc({ dog: v as Alloc["dog"] })}
            options={[{ value: "even", label: "同体型的狗平均" }, { value: "avail", label: "按可用量" }]} /> })}
        {dimRow({ title: "时长", segs: durs.map((d, i) => ({
          key: String(d), color: DUR_COLORS[i % DUR_COLORS.length], count: byDur[String(d)] ?? 0, weight: alloc.dur?.[String(d)] ?? 1,
          label: (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              {/* 分钟数输完（回车 / 点别处）才生效，免得边打边变 */}
              <InputNumber key={`m${d}`} size="small" min={0.5} max={60} step={1} defaultValue={d / 60} disabled={frozen} style={{ width: 58 }}
                onPressEnter={(e) => changeDur(d, Number((e.target as HTMLInputElement).value))}
                onBlur={(e) => changeDur(d, Number(e.target.value))} />分钟
            </span>),
          onWeight: (v) => setAlloc({ dur: { ...(alloc.dur ?? {}), [String(d)]: v } }),
          onRemove: durs.length > 1 ? () => update((p) => ({ ...p, durations: p.durations.filter((x) => x !== d) })) : undefined,
          got: result ? (gotDur(d, 0) ?? 0) + (gotDur(d, 1) ?? 0) : null,
        })),
          extra: !frozen && (
            <Popover trigger="click" content={<Space>
              <InputNumber size="small" min={0.5} max={60} value={newMin ?? undefined} onChange={(v) => setNewMin(v)} addonAfter="分钟" style={{ width: 120 }} />
              <Button size="small" type="primary" onClick={() => {
                const s = Math.round((newMin ?? 0) * 60);
                if (s > 0 && !durs.includes(s)) update((p) => ({ ...p, durations: [...p.durations, s].sort((a, b) => a - b) }));
              }}>加</Button></Space>}>
              <a style={{ fontSize: 13 }}><PlusOutlined /> 时长</a>
            </Popover>) })}
        {dimRow({ title: `有 / 无${plan.target}`, segs: [
          { key: "pos", label: `有${plan.target}`, count: posTotal, color: accent, weight: alloc.pos ?? 1, onWeight: (v) => setAlloc({ pos: v }),
            got: result ? durs.reduce((a, d) => a + (gotDur(d, 0) ?? 0), 0) : null },
          { key: "neg", label: `无${plan.target}`, count: negTotal, color: NEG_BLUE, weight: alloc.neg ?? 1, onWeight: (v) => setAlloc({ neg: v }),
            got: result ? durs.reduce((a, d) => a + (gotDur(d, 1) ?? 0), 0) : null },
        ] })}
      </div>

      {/* 类别：有 → 部位（小类），无 → 分类 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 14 }}>
        <div style={{ ...card, borderTop: `5px solid ${accent}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>有{plan.target} <span style={{ fontSize: 22, color: accent }}>{posTotal}</span> 段</span>
            {!frozen && (
              <TreeSelect size="small" style={{ minWidth: 150 }} placeholder={<span><PlusOutlined /> 部位（小类）</span>} value={null as never}
                treeData={subtree(plan.target)}
                onChange={(v) => { const n = v as unknown as string; if (n && !plan.parts.includes(n)) update((p) => ({ ...p, parts: [...p.parts, n] })); }} />
            )}
          </div>
          <div style={{ fontSize: 12, color: muted, margin: "2px 0 10px" }}>可用 {allDogs.reduce((a, d) => a + availOf(d.id), 0)} 条</div>
          {plan.parts.length === 0 ? <div style={{ fontSize: 13, color: muted }}>不分部位</div> : plan.parts.map((k, i) => {
            const n = byPart[k] ?? 0, c = PART_COLORS[i % PART_COLORS.length];
            return (
              <div key={k} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{k.replace(`${plan.target}-`, "")}</span>
                  <b style={{ fontSize: 16 }}>{n}</b><Got want={n} have={gotPart(k)} />
                  <Tooltip title="比例">{w(alloc.part?.[k] ?? 1, (v) => setAlloc({ part: { ...(alloc.part ?? {}), [k]: v } }), 48)}</Tooltip>
                  {!frozen && <CloseOutlined style={{ fontSize: 10, color: muted, cursor: "pointer" }} onClick={() => update((p) => ({ ...p, parts: p.parts.filter((x) => x !== k) }))} />}
                </div>
                <div style={{ height: 7, background: token.colorFillTertiary, borderRadius: 4, overflow: "hidden", marginTop: 4 }}>
                  <div style={{ width: `${posTotal ? (n / posTotal) * 100 : 0}%`, height: "100%", background: c, transition: "width .25s" }} />
                </div>
                <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>占 {posTotal ? ((n / posTotal) * 100).toFixed(0) : 0}% · 可用 {allDogs.reduce((a, d) => a + availOf(d.id, k), 0)}</div>
              </div>
            );
          })}
        </div>

        <div style={{ ...card, borderTop: `5px solid ${NEG_BLUE}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>无{plan.target} <span style={{ fontSize: 22, color: NEG_BLUE }}>{negTotal}</span> 段</span>
            {!frozen && (
              <Popover trigger="click" content={<Space direction="vertical">
                <Input size="small" placeholder="分类名，如 进食饮水" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
                <TreeSelect size="small" style={{ width: 240 }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} maxTagCount={3}
                  placeholder="以哪些动作为中心" treeData={otherTree} value={newCat.anchors} onChange={(v) => setNewCat({ ...newCat, anchors: v as string[] })} />
                <Button size="small" type="primary" disabled={!newCat.name.trim() || !newCat.anchors.length} onClick={() => {
                  update((p) => ({ ...p, neg_cats: [...(p.neg_cats ?? []), { name: newCat.name.trim(), anchors: newCat.anchors, ratio: 1 }] }));
                  setNewCat({ name: "", anchors: [] });
                }}>加</Button></Space>}>
                <a style={{ fontSize: 13 }}><PlusOutlined /> 分类</a>
              </Popover>
            )}
          </div>
          <div style={{ height: 10, display: "flex", borderRadius: 4, overflow: "hidden", margin: "8px 0 12px", background: token.colorFillTertiary }}>
            {negCats.map((c, j) => <div key={c.name} style={{ width: `${negTotal ? (negByCat[j] / negTotal) * 100 : 0}%`, background: NEG_COLORS[j % NEG_COLORS.length], transition: "width .25s" }} />)}
          </div>
          {negCats.length === 0 ? <div style={{ fontSize: 13, color: muted }}>不分类（以任何别的动作为中心）</div> : negCats.map((c, j) => {
            const color = NEG_COLORS[j % NEG_COLORS.length];
            return (
              <div key={c.name} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <i style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
                  <Tooltip title={NEG_TIPS[c.name]}><span style={{ flex: 1, fontWeight: 600, color }}>{c.name}</span></Tooltip>
                  <b style={{ fontSize: 16 }}>{negByCat[j]}</b>
                  <span style={{ color: muted, fontSize: 12 }}>{negTotal ? ((negByCat[j] / negTotal) * 100).toFixed(0) : 0}%</span>
                  <Got want={negByCat[j]} have={gotCat(c.name)} />
                  <Tooltip title="比例">{w(c.ratio, (v) => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).map((x, i) => (i === j ? { ...x, ratio: v } : x)) })), 48)}</Tooltip>
                  {!frozen && <CloseOutlined style={{ fontSize: 10, color: muted, cursor: "pointer" }}
                    onClick={() => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).filter((_, i) => i !== j) }))} />}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                  <TreeSelect size="small" variant="borderless" style={{ flex: 1 }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT}
                    maxTagCount={4} disabled={frozen} treeData={otherTree} value={c.anchors}
                    onChange={(v) => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).map((x, i) => (i === j ? { ...x, anchors: v as string[] } : x)) }))} />
                  <span style={{ fontSize: 12, color: muted, whiteSpace: "nowrap" }}>{durs.map((d) => `${durLabel(d)} ${negByCatDur[String(d)]?.[j] ?? 0}`).join(" / ")}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 按狗明细（可展开） */}
      <Collapse size="small" items={[{
        key: "dogs",
        label: <span>按狗明细 · {derived.length} 只狗分到了段数{excluded.size ? ` · 去掉了 ${excluded.size} 只` : ""}</span>,
        children: (
          <Table size="small" rowKey="id" pagination={false} scroll={{ x: true }}
            dataSource={allDogs.map((d) => ({ id: d.id, d, x: derived.find((x) => x.dog_id === d.id) }))}
            columns={[
              { title: "纳入", width: 56, render: (_, r) => <Checkbox checked={!excluded.has(r.id)} disabled={frozen}
                onChange={(e) => setAlloc({ exclude: e.target.checked ? (alloc.exclude ?? []).filter((i) => i !== r.id) : [...(alloc.exclude ?? []), r.id] })} /> },
              { title: "狗", render: (_, r) => <span>{r.d.name}<span style={{ color: muted, fontSize: 12 }}> {SITE_SHORT[r.d.site ?? ""]} · {r.d.size ?? "?"}型</span></span> },
              { title: "可用", render: (_, r) => { const a = availOf(r.id); return <span style={{ color: a ? undefined : token.colorTextQuaternary }}>{a}</span>; } },
              ...durs.flatMap((d) => ([0, 1] as const).map((k) => ({
                title: `${durLabel(d)}·${k === 0 ? "有" : "无"}`, key: `${d}-${k}`,
                render: (_: unknown, r: { id: number; x?: PlanDog }) => {
                  const want = r.x ? qOf(r.x, d)[k] : 0, have = result ? rep[String(r.id)]?.q?.[String(d)]?.[k] ?? 0 : null;
                  return want ? <span>{want}{have != null && have < want && <span style={{ color: token.colorError, fontSize: 12 }}> 挑到{have}</span>}</span> : <span style={{ color: token.colorTextQuaternary }}>-</span>;
                },
              }))),
              ...plan.parts.map((k) => ({ title: k.replace(`${plan.target}-`, ""), key: k, render: (_: unknown, r: { x?: PlanDog }) => r.x?.p[k] || "-" })),
              { title: "合计", render: (_, r) => <b>{r.x ? durs.reduce((a, d) => a + qOf(r.x!, d)[0] + qOf(r.x!, d)[1], 0) : 0}</b> },
            ]} />
        ),
      }]} />
    </div>
  );
}
