/**
 * 选样计划：① 场所 → ② 犬只 → ③ 时长 × 有/无 → ④ 部位。数字和条形图为主、文字少。
 * 选「全部犬只」时改的是「每只」的数，选某只狗时改的是这只狗的数。
 * 「预览」按计划试挑，每格显示挑到几段（不够标红）；「生成」写进测试集，计划随测试集保存。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { Button, DatePicker, Input, InputNumber, Popconfirm, Popover, Segmented, Select, Space, Tooltip, TreeSelect, message, theme } from "antd";
import { CloseOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listDogs, type Dog } from "@/api/dogs";
import { getLabelTree, planApply, planAvailability, planPreview, planSave, type Plan, type PlanDog, type PlanResult } from "@/api/modelTests";

const SITE_ORDER = ["佛山博朗旺狗场", "公司影棚", "深圳雷诺狗场"];
const SITE_SHORT: Record<string, string> = { 佛山博朗旺狗场: "佛山博朗旺", 公司影棚: "公司影棚", 深圳雷诺狗场: "深圳雷诺" };
const durLabel = (s: number) => (s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`);
const emptyDog = (id: number): PlanDog => ({ dog_id: id, q: {}, p: {} });
const NEG_BLUE = "#4a6fa5";
/** 没抓挠的四类（参考测试说明：4:2:3:1）。颜色、挑什么、为什么 */
const DEFAULT_NEG = [
  { name: "像抓挠的动作", anchors: ["舔", "啃", "蹭", "甩头/抖身"], ratio: 4 },
  { name: "正常活动", anchors: ["活动"], ratio: 2 },
  { name: "休息睡眠", anchors: ["静止/休息"], ratio: 3 },
  { name: "未佩戴", anchors: ["未佩戴"], ratio: 1 },
];
const NEG_COLORS = ["#b0762a", "#3f7f95", "#2f7d72", "#6b7280", "#8e7cc3", "#a3474c"];
const NEG_TIPS: Record<string, string> = {
  像抓挠的动作: "舔、啃、蹭、甩头：项圈也会反复晃，最容易被报成抓挠。模型行不行主要看这一类，凑不齐时优先保它",
  正常活动: "走、跑、转圈、玩：看狗一动起来会不会乱报",
  休息睡眠: "趴着、侧躺睡，偶尔翻身也算：一动不动时报抓挠肯定是错的",
  未佩戴: "项圈摘下来、设备还在录：没戴还报抓挠算硬伤",
};
/** 整批摊（跟后端 split_grid 同一套）：行 = 每只狗的「无」段数，列 = 整批各类目标数 */
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
/** n 段按比例摊（最大余数法，跟后端同一套），加起来正好是 n */
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

export default function ModelTestPlan({ setId, initial, frozen, accent = "#27AE60", existing = 0, onApplied }: {
  setId: number; initial?: Plan | null; frozen?: boolean; accent?: string; existing?: number; onApplied?: () => void;
}) {
  const { token } = theme.useToken();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<Plan>(() => {
    const p = initial ?? { target: "抓挠", durations: [60, 600], parts: [], dogs: [] };
    // 老计划没有分类：抓挠默认四类；用户清空过（[]）就尊重
    return p.neg_cats === undefined || p.neg_cats === null ? { ...p, neg_cats: p.target === "抓挠" ? DEFAULT_NEG : [] } : p;
  });
  const [site, setSite] = useState<string | null>(null);
  const [selDog, setSelDog] = useState<number | null>(null);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply" | "save">("");
  const [newDur, setNewDur] = useState<number | null>(5);

  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const { data: tree } = useQuery({ queryKey: ["mt-label-tree"], queryFn: getLabelTree });
  const filterKey = [plan.target, plan.date_from, plan.date_to, plan.source, plan.seen_mode, (plan.model_ids ?? []).join(",")];
  const { data: avail, isFetching: availLoading } = useQuery({
    queryKey: ["mt-plan-avail", ...filterKey], queryFn: () => planAvailability(plan), staleTime: 60_000,
  });

  // ── 标签树：类别下拉、部位、按部位数可用量 ──
  const kids = useMemo(() => {
    const m = new Map<string | null, string[]>();
    (tree ?? []).forEach((x) => m.set(x.parent, [...(m.get(x.parent) ?? []), x.name]));
    return m;
  }, [tree]);
  const descendants = (name: string): Set<string> => {
    const out = new Set<string>([name]);
    const walk = (n: string, depth: number) => (kids.get(n) ?? []).forEach((c) => { if (depth < 6) { out.add(c); walk(c, depth + 1); } });
    walk(name, 0);
    return out;
  };
  const tops = kids.get(null) ?? [];
  const partOptions = useMemo(() => {
    type Node = { title: string; value: string; children: Node[] };
    const build = (p: string, d: number): Node[] => (d > 4 ? [] : (kids.get(p) ?? []).map((n) => ({ title: n, value: n, children: build(n, d + 1) })));
    return build(plan.target, 0);
  }, [kids, plan.target]);

  // ── 狗 / 场所 ──
  const allDogs = useMemo(() => (dogs ?? []).filter((d) => SITE_ORDER.includes(d.site ?? ""))
    .sort((a, b) => SITE_ORDER.indexOf(a.site ?? "") - SITE_ORDER.indexOf(b.site ?? "") || a.id - b.id), [dogs]);
  const scopeDogs = allDogs.filter((d) => !site || d.site === site);
  const selected: Dog[] = selDog ? allDogs.filter((d) => d.id === selDog) : scopeDogs;
  const dp = (id: number) => plan.dogs.find((x) => x.dog_id === id) ?? emptyDog(id);
  const qOf = (x: PlanDog, d: number): [number, number] => (x.q[String(d)] as [number, number]) ?? [0, 0];
  const dogTotal = (id: number) => plan.durations.reduce((a, d) => a + qOf(dp(id), d)[0] + qOf(dp(id), d)[1], 0);
  const availOf = (id: number, name?: string) => {
    const m = avail?.by_dog?.[String(id)] ?? {};
    const want = descendants(name ?? plan.target);
    return Object.entries(m).reduce((a, [k, n]) => a + (want.has(k) ? n : 0), 0);
  };

  const update = (fn: (p: Plan) => Plan) => { setPlan(fn); setResult(null); };
  const setForSelected = (fn: (x: PlanDog) => PlanDog) => update((p) => {
    const ids = new Set(selected.map((d) => d.id));
    const others = p.dogs.filter((x) => !ids.has(x.dog_id));
    const changed = selected.map((d) => fn(structuredClone(p.dogs.find((x) => x.dog_id === d.id) ?? emptyDog(d.id))));
    return { ...p, dogs: [...others, ...changed].filter((x) => Object.values(x.q).some(([a, b]) => a || b) || Object.values(x.p).some(Boolean)) };
  });
  /** 选中的几只狗这个数是不是一样：一样就显示它，可以一起改 */
  const same = (get: (x: PlanDog) => number): number | null => {
    const vs = selected.map((d) => get(dp(d.id)));
    return vs.length && vs.every((v) => v === vs[0]) ? vs[0] : null;
  };
  const sum = (get: (x: PlanDog) => number, ids: number[] = selected.map((d) => d.id)) => ids.reduce((a, id) => a + get(dp(id)), 0);
  const got = (id: number, d: number, k: 0 | 1) => result?.report?.[String(id)]?.q?.[String(d)]?.[k];
  const gotSum = (d: number, k: 0 | 1) => (result ? selected.reduce((a, x) => a + (got(x.id, d, k) ?? 0), 0) : null);
  const gotPart = (part: string) => (result ? selected.reduce((a, x) => a + (result.report?.[String(x.id)]?.p?.[part] ?? 0), 0) : null);
  const dogShort = (id: number) => {
    if (!result) return 0;
    const r = result.report?.[String(id)];
    return plan.durations.reduce((a, d) => a + qOf(dp(id), d)[0] + qOf(dp(id), d)[1] - (r?.q?.[String(d)]?.[0] ?? 0) - (r?.q?.[String(d)]?.[1] ?? 0), 0);
  };

  const total = sum((x) => plan.durations.reduce((a, d) => a + qOf(x, d)[0] + qOf(x, d)[1], 0));
  const allTotal = sum((x) => plan.durations.reduce((a, d) => a + qOf(x, d)[0] + qOf(x, d)[1], 0), allDogs.map((d) => d.id));
  const hours = plan.dogs.reduce((a, x) => a + plan.durations.reduce((b, d) => b + (qOf(x, d)[0] + qOf(x, d)[1]) * d, 0), 0) / 3600;
  const posTotal = sum((x) => plan.durations.reduce((a, d) => a + qOf(x, d)[0], 0));
  const negTotal = sum((x) => plan.durations.reduce((a, d) => a + qOf(x, d)[1], 0));
  // 「无」按分类整批摊：每种时长先按比例定各类总数，再分到计划里的每只狗（跟后端挑的时候一样）；
  // 看某个场所 / 某只狗时，把那几只狗的那几行加起来
  const negCats = plan.neg_cats ?? [];
  const negGrid = useMemo(() => {
    const out = new Map<number, Map<number, number[]>>();
    const ratios = (plan.neg_cats ?? []).map((c) => c.ratio);
    plan.durations.forEach((d) => {
      const rows = plan.dogs.map((x) => ((x.q[String(d)] as [number, number]) ?? [0, 0])[1]);
      const grid = splitGrid(rows, splitByRatio(rows.reduce((a, b) => a + b, 0), ratios));
      out.set(d, new Map(plan.dogs.map((x, i) => [x.dog_id, grid[i]])));
    });
    return out;
  }, [plan]);
  const negSplit = (d: number): number[] => {
    const tot = negCats.map(() => 0);
    selected.forEach((dog) => (negGrid.get(d)?.get(dog.id) ?? []).forEach((k, j) => { tot[j] += k; }));
    return tot;
  };
  const gotCat = (d: number, name: string) => (result
    ? selected.reduce((a, x) => a + (result.report?.[String(x.id)]?.n?.[String(d)]?.[name] ?? 0), 0) : null);
  const setCat = (j: number, patch: Partial<{ name: string; anchors: string[]; ratio: number }>) =>
    update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).map((c, i) => (i === j ? { ...c, ...patch } : c)) }));
  const otherTree = useMemo(() => {
    type Node = { title: string; value: string; children: Node[] };
    const build = (p: string, d: number): Node[] => (d > 3 ? [] : (kids.get(p) ?? []).map((n) => ({ title: n, value: n, children: build(n, d + 1) })));
    return (kids.get(null) ?? []).filter((t) => t !== plan.target).map((t) => ({ title: t, value: t, children: build(t, 0) }));
  }, [kids, plan.target]);
  const [newCat, setNewCat] = useState<{ name: string; anchors: string[] }>({ name: "", anchors: [] });

  // ── 输入总段数，自动配比 ──
  const [wantTotal, setWantTotal] = useState<number | null>(200);
  // 计划还空着就默认「平均」：「现在比例」要有一版计划才能缩放
  const [autoMode, setAutoMode] = useState<"scale" | "even" | "avail">(() => (initial?.dogs?.length ? "scale" : "even"));
  const autoAllocate = () => {
    const N = Math.max(0, Math.round(wantTotal ?? 0));
    if (!N) return message.warning("先填总段数");
    const durs = plan.durations;
    let mode = autoMode;
    if (mode === "scale" && !plan.dogs.some((x) => durs.some((d) => qOf(x, d)[0] + qOf(x, d)[1] > 0))) {
      mode = "even";
      setAutoMode("even");
      message.info("计划还是空的，先按「平均」配；之后改总数可以用「现在比例」");
    }
    if (mode === "scale") {
      // 现在的计划等比缩放：每只狗 × 时长 × 有/无 一格一格按比例，最大余数补齐，正好 N
      const cells: { id: number; d: number; k: 0 | 1; v: number }[] = [];
      plan.dogs.forEach((x) => durs.forEach((d) => ([0, 1] as const).forEach((k) => cells.push({ id: x.dog_id, d, k, v: qOf(x, d)[k] }))));
      const nv = splitByRatio(N, cells.map((c) => c.v));
      update((p) => ({
        ...p,
        dogs: p.dogs.map((x) => {
          const q: Record<string, [number, number]> = {};
          cells.forEach((c, i) => {
            if (c.id !== x.dog_id) return;
            const cur = q[String(c.d)] ?? [0, 0];
            cur[c.k] = nv[i];
            q[String(c.d)] = cur;
          });
          const oldPos = durs.reduce((a, d) => a + qOf(x, d)[0], 0);
          const newPos = durs.reduce((a, d) => a + (q[String(d)]?.[0] ?? 0), 0);
          const ps = Object.keys(x.p);
          const oldPart = ps.reduce((a, k) => a + (x.p[k] ?? 0), 0);
          const partTotal = oldPos ? Math.min(newPos, Math.round((oldPart / oldPos) * newPos)) : 0;
          const pv = splitByRatio(partTotal, ps.map((k) => x.p[k] ?? 0));
          return { ...x, q, p: Object.fromEntries(ps.map((k, i) => [k, pv[i]])) };
        }).filter((x) => Object.values(x.q).some(([a, b]) => a || b)),
      }));
    } else {
      // 平均 / 按可用量：分给当前场所里的狗（按可用量时没数据的狗不分），每只狗再平均分到各时长、有无各半、各部位均分
      const pool = scopeDogs.filter((d) => mode === "even" || availOf(d.id) > 0);
      if (!pool.length) return message.warning("这个范围里没有可分的狗");
      const perDog = splitByRatio(N, pool.map((d) => (mode === "even" ? 1 : availOf(d.id))));
      update((p) => {
        const keep = p.dogs.filter((x) => !pool.some((d) => d.id === x.dog_id) && !scopeDogs.some((d) => d.id === x.dog_id));
        const made = pool.map((d, i) => {
          const byDur = splitByRatio(perDog[i], durs.map(() => 1));
          const q: Record<string, [number, number]> = {};
          durs.forEach((dd, j) => { const [a, b] = splitByRatio(byDur[j], [1, 1]); q[String(dd)] = [a, b]; });
          const pos = durs.reduce((a, dd) => a + q[String(dd)][0], 0);
          const pv = splitByRatio(p.parts.length ? pos : 0, p.parts.map(() => 1));
          return { dog_id: d.id, q, p: Object.fromEntries(p.parts.map((k, j) => [k, pv[j]])) };
        }).filter((x) => Object.values(x.q).some(([a, b]) => a || b));
        return { ...p, dogs: [...keep, ...made] };
      });
    }
    setSelDog(null);
  };
  const multi = selected.length > 1;

  const run = async (kind: "preview" | "apply" | "save") => {
    if (!plan.dogs.length && kind !== "save") return message.warning("先给狗配上段数");
    setBusy(kind);
    try {
      if (kind === "save") { await planSave(setId, plan); message.success("计划已保存"); return; }
      const r = kind === "preview" ? await planPreview(setId, plan) : await planApply(setId, plan);
      setResult(r);
      if (kind === "apply") {
        message.success(`已加进测试集 ${r.added ?? r.n_picked} 段`);
        qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
        qc.invalidateQueries({ queryKey: ["model-test-sets"] });
        onApplied?.();
      }
    } finally { setBusy(""); }
  };

  // ── 样式（跟随明暗主题） ──
  const line = token.colorBorderSecondary;
  const muted = token.colorTextSecondary;
  const card = (on: boolean): CSSProperties => ({
    background: on ? token.colorPrimaryBg : token.colorBgContainer, border: `1px solid ${on ? accent : line}`, borderRadius: 8,
    padding: 16, textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "flex-end", cursor: "pointer", width: "100%",
  });
  const chip = (on: boolean, dim: boolean): CSSProperties => ({
    background: on ? accent : token.colorBgContainer, color: on ? "#fff" : dim ? token.colorTextQuaternary : token.colorText,
    border: `1px solid ${on ? accent : line}`, padding: "5px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", position: "relative",
  });
  const big: CSSProperties = { fontSize: 26, fontWeight: 700, lineHeight: 1.1 };
  const eyebrow: CSSProperties = { fontSize: 12, letterSpacing: ".08em", color: accent, fontWeight: 700 };
  const h3: CSSProperties = { fontSize: 15, fontWeight: 700, margin: 0 };
  const Got = ({ want, have }: { want: number; have: number | null | undefined }) =>
    have == null ? null : <span style={{ fontSize: 12, color: have < want ? token.colorError : token.colorSuccess }}>{have < want ? `挑到 ${have}` : "✓"}</span>;
  // 普通函数、不是组件：写成组件的话每次重渲染都会换一个新组件，输入框打一个字就丢焦点
  const num = (key: string, value: number | null, onChange: (v: number) => void) => (
    <InputNumber key={key} size="small" min={0} max={500} value={value ?? undefined} placeholder={value == null ? "不同" : undefined}
      disabled={frozen} style={{ width: 64 }} onChange={(v) => onChange(Number(v ?? 0))} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* 条件：一行 */}
      <Space wrap size={[12, 8]} style={{ fontSize: 13 }}>
        <Select size="small" style={{ width: 110 }} value={plan.target} options={tops.map((t) => ({ value: t, label: t }))}
          onChange={(v) => update((p) => ({ ...p, target: v, parts: [], neg_cats: v === "抓挠" ? DEFAULT_NEG : [],
            dogs: p.dogs.map((x) => ({ ...x, p: {} })) }))} />
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
      </Space>

      {/* 输入总段数，自动配比 */}
      {!frozen && (
        <Space wrap size={[10, 8]} style={{ fontSize: 13, padding: "10px 14px", border: `1px dashed ${line}`, borderRadius: 8 }}>
          <span style={{ fontWeight: 700 }}>总数</span>
          <InputNumber size="small" min={1} max={5000} value={wantTotal ?? undefined} onChange={(v) => setWantTotal(v)} addonAfter="段" style={{ width: 120 }} />
          {[200, 300, 500].map((n) => <Button key={n} size="small" type={wantTotal === n ? "primary" : "default"} ghost={wantTotal === n} onClick={() => setWantTotal(n)}>{n}</Button>)}
          <span style={{ color: muted }}>按</span>
          <Tooltip title={autoMode === "scale" ? "把现在的计划等比放大 / 缩小，每只狗、每个时长、有无、部位的比例都不变"
            : autoMode === "even" ? `平均分给${site ? SITE_SHORT[site] : "全部场所"}的狗，每只狗再平均分到各时长，有无各半，部位均分`
              : `按每只狗可用的${plan.target}片段多少分（${site ? SITE_SHORT[site] : "全部场所"}，没数据的狗不分），每只狗内部同「平均」`}>
            <Segmented size="small" value={autoMode} onChange={(v) => setAutoMode(v as typeof autoMode)}
              options={[{ value: "scale", label: "现在比例" }, { value: "even", label: "平均" }, { value: "avail", label: "按可用量" }]} />
          </Tooltip>
          <Button size="small" type="primary" onClick={autoAllocate}>自动配</Button>
        </Space>
      )}

      {/* ① 场所 */}
      <div>
        <div style={{ ...h3, fontSize: 17, marginBottom: 10 }}>① 场所</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {SITE_ORDER.map((s) => {
            const ds = allDogs.filter((d) => d.site === s);
            const n = sum((x) => plan.durations.reduce((a, d) => a + qOf(x, d)[0] + qOf(x, d)[1], 0), ds.map((d) => d.id));
            const inc = ds.filter((d) => dogTotal(d.id) > 0).length;
            return (
              <button key={s} type="button" style={card(site === s)} onClick={() => { setSite(site === s ? null : s); setSelDog(null); }}>
                <div><div style={{ fontWeight: 700, fontSize: 15 }}>{SITE_SHORT[s]}</div>
                  <div style={{ fontSize: 12, color: muted }}>{inc} / {ds.length} 只纳入</div></div>
                <div style={big}>{n}<span style={{ fontSize: 12, fontWeight: 400, color: muted }}> 段</span></div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ② 犬只 + 详情 */}
      <div style={{ display: "grid", gridTemplateColumns: "240px minmax(0, 1fr)", border: `1px solid ${line}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: 20, background: token.colorFillQuaternary, borderRight: `1px solid ${line}` }}>
          <div style={{ ...h3, marginBottom: 12 }}>② 犬只</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            <button type="button" style={chip(selDog == null, false)} onClick={() => setSelDog(null)}>全部犬只</button>
            {scopeDogs.map((d) => {
              const n = dogTotal(d.id), a = availOf(d.id), short = dogShort(d.id);
              return (
                <Tooltip key={d.id} title={`${d.size ?? "?"}型 · 可用${plan.target} ${a} 条${short > 0 ? ` · 少 ${short} 段` : ""}`}>
                  <button type="button" style={chip(selDog === d.id, !a)} onClick={() => setSelDog(d.id)}>
                    {d.name}{n > 0 && <span style={{ marginLeft: 5, fontWeight: 700, opacity: 0.85 }}>{n}</span>}
                    {short > 0 && <span style={{ position: "absolute", top: -4, right: -4, width: 8, height: 8, borderRadius: 4, background: token.colorError }} />}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>

        <div style={{ padding: "22px 26px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
            <div>
              <div style={eyebrow}>当前查看</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {selDog ? selected[0]?.name : site ? `${SITE_SHORT[site]} · 全部犬只` : "全部犬只"}
              </div>
              <div style={{ fontSize: 13, color: muted }}>
                {selDog ? `${SITE_SHORT[selected[0]?.site ?? ""] ?? ""} · ${selected[0]?.size ?? "?"}型 · 可用${plan.target} ${availOf(selDog)} 条`
                  : `${selected.filter((d) => dogTotal(d.id) > 0).length} / ${selected.length} 只纳入${multi ? " · 下面改的是每只的数" : ""}`}
                {availLoading && " · 统计可用量…"}
              </div>
            </div>
            <div style={{ textAlign: "right", fontSize: 13, color: muted }}>
              计划片段<div style={{ ...big, fontSize: 34, color: token.colorText }}>{total}</div>段
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${line}`, margin: "18px 0" }} />

          {/* ③ 时长 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={h3}>③ 时长</div>
            <Space size={14} style={{ fontSize: 12, color: muted }}>
              <span><i style={{ display: "inline-block", width: 9, height: 9, background: accent, borderRadius: 2, marginRight: 4 }} />有{plan.target}</span>
              <span><i style={{ display: "inline-block", width: 9, height: 9, background: NEG_BLUE, borderRadius: 2, marginRight: 4 }} />无{plan.target}{negCats.length ? "（按⑤分类上色）" : ""}</span>
              {!frozen && (
                <Popover trigger="click" content={<Space>
                  <InputNumber size="small" min={1} max={60} value={newDur ?? undefined} onChange={(v) => setNewDur(v)} addonAfter="分钟" style={{ width: 120 }} />
                  <Button size="small" type="primary" onClick={() => {
                    const s = Math.round((newDur ?? 0) * 60);
                    if (s > 0 && !plan.durations.includes(s)) update((p) => ({ ...p, durations: [...p.durations, s].sort((a, b) => a - b) }));
                  }}>加</Button></Space>}>
                  <a><PlusOutlined /> 时长</a>
                </Popover>
              )}
            </Space>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 22 }}>
            {plan.durations.map((d) => {
              const yes = sum((x) => qOf(x, d)[0]), no = sum((x) => qOf(x, d)[1]), t = yes + no;
              const setK = (k: 0 | 1, v: number) => setForSelected((x) => { const q = [...qOf(x, d)] as [number, number]; q[k] = v; x.q[String(d)] = q; return x; });
              return (
                <div key={d}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                    <span>{durLabel(d)}</span>
                    <span>{t} 段{!frozen && plan.durations.length > 1 && (
                      <CloseOutlined style={{ marginLeft: 8, fontSize: 11, color: muted, cursor: "pointer" }}
                        onClick={() => update((p) => ({ ...p, durations: p.durations.filter((x) => x !== d),
                          dogs: p.dogs.map((x) => { const q = { ...x.q }; delete q[String(d)]; return { ...x, q }; }) }))} />)}</span>
                  </div>
                  <div style={{ height: 12, display: "flex", borderRadius: 3, overflow: "hidden", background: token.colorFillTertiary }}>
                    <div style={{ width: `${t ? (yes / t) * 100 : 0}%`, background: accent }} />
                    {negCats.length
                      ? negSplit(d).map((k, j) => <div key={j} style={{ width: `${t ? (k / t) * 100 : 0}%`, background: NEG_COLORS[j % NEG_COLORS.length] }} />)
                      : <div style={{ width: `${t ? (no / t) * 100 : 0}%`, background: NEG_BLUE }} />}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, color: muted, gap: 6 }}>
                    <Space size={4}>有 {num(`y${d}`, same((x) => qOf(x, d)[0]), (v) => setK(0, v))}
                      {multi && <span>={yes}</span>}<Got want={yes} have={gotSum(d, 0)} /></Space>
                    <Space size={4}>无 {num(`n${d}`, same((x) => qOf(x, d)[1]), (v) => setK(1, v))}
                      {multi && <span>={no}</span>}<Got want={no} have={gotSum(d, 1)} /></Space>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: `1px solid ${line}`, margin: "18px 0" }} />

          {/* ④ 部位 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={h3}>④ 部位</div>
            <Space size={12} style={{ fontSize: 12, color: muted }}>
              <span>占有{plan.target} {posTotal} 段</span>
              {!frozen && (
                <TreeSelect size="small" style={{ minWidth: 150 }} placeholder={<span><PlusOutlined /> 部位</span>} value={null as never}
                  treeData={partOptions} treeDefaultExpandAll={false}
                  onChange={(v) => { const n = v as unknown as string; if (n && !plan.parts.includes(n)) update((p) => ({ ...p, parts: [...p.parts, n] })); }} />
              )}
            </Space>
          </div>
          {plan.parts.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>不分部位（有{plan.target}的段不限部位）</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20 }}>
              {plan.parts.map((part, i) => {
                const n = sum((x) => x.p[part] ?? 0);
                const pct = posTotal ? (n / posTotal) * 100 : 0;
                const colors = [accent, "#d8a85c", "#72999f", "#8e7cc3", "#c27c7c"];
                const a = selected.reduce((s, d) => s + availOf(d.id, part), 0);
                return (
                  <div key={part}>
                    <div style={{ fontSize: 13, color: muted, display: "flex", justifyContent: "space-between" }}>
                      <span>{part.replace(`${plan.target}-`, "")}</span>
                      {!frozen && <CloseOutlined style={{ fontSize: 11, cursor: "pointer" }}
                        onClick={() => update((p) => ({ ...p, parts: p.parts.filter((x) => x !== part),
                          dogs: p.dogs.map((x) => { const pp = { ...x.p }; delete pp[part]; return { ...x, p: pp }; }) }))} />}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0" }}>
                      <span style={{ fontSize: 23, fontWeight: 700 }}>{n}</span><span style={{ fontSize: 12, color: muted }}>段</span>
                      {num(`p${part}`, same((x) => x.p[part] ?? 0), (v) => setForSelected((x) => { x.p[part] = v; return x; }))}
                      <Got want={n} have={gotPart(part)} />
                    </div>
                    <div style={{ height: 6, background: token.colorFillTertiary, borderRadius: 4, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${Math.min(100, pct)}%`, background: colors[i % colors.length], borderRadius: 4 }} />
                    </div>
                    <div style={{ fontSize: 12, color: muted, marginTop: 5 }}>占 {pct.toFixed(0)}% · 可用 {a}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${line}`, margin: "18px 0" }} />

          {/* ⑤ 没这类的分类 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={h3}>⑤ 没{plan.target}的分类</div>
            <Space size={12} style={{ fontSize: 12, color: muted }}>
              <span>无{plan.target} {negTotal} 段按比例摊</span>
              {!frozen && (
                <Popover trigger="click" content={<Space direction="vertical">
                  <Input size="small" placeholder="分类名，如 进食饮水" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} />
                  <TreeSelect size="small" style={{ width: 240 }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} maxTagCount={3}
                    placeholder="以哪些片段为中心" treeData={otherTree} value={newCat.anchors} onChange={(v) => setNewCat({ ...newCat, anchors: v as string[] })} />
                  <Button size="small" type="primary" disabled={!newCat.name.trim() || !newCat.anchors.length} onClick={() => {
                    update((p) => ({ ...p, neg_cats: [...(p.neg_cats ?? []), { name: newCat.name.trim(), anchors: newCat.anchors, ratio: 1 }] }));
                    setNewCat({ name: "", anchors: [] });
                  }}>加</Button>
                </Space>}>
                  <a><PlusOutlined /> 分类</a>
                </Popover>
              )}
            </Space>
          </div>
          {negCats.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>不分类（无{plan.target}的段以任何别的片段为中心）</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
              {negCats.map((c, j) => {
                const color = NEG_COLORS[j % NEG_COLORS.length];
                const per = plan.durations.map((d) => negSplit(d)[j]);
                const n = per.reduce((a, b) => a + b, 0);
                const g = result ? plan.durations.reduce((a, d) => a + (gotCat(d, c.name) ?? 0), 0) : null;
                return (
                  <div key={c.name} style={{ border: `1px solid ${line}`, borderTop: `5px solid ${color}`, background: `${color}14`, borderRadius: 9, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Tooltip title={NEG_TIPS[c.name] ?? `以 ${c.anchors.join(" / ")} 为中心`}>
                        <b style={{ color, fontSize: 14 }}>{c.name}</b>
                      </Tooltip>
                      {!frozen && <CloseOutlined style={{ fontSize: 11, color: muted, cursor: "pointer" }}
                        onClick={() => update((p) => ({ ...p, neg_cats: (p.neg_cats ?? []).filter((_, i) => i !== j) }))} />}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 24, fontWeight: 700 }}>{n}</span><span style={{ fontSize: 12, color: muted }}>段</span>
                      <Got want={n} have={g} />
                    </div>
                    <div style={{ fontSize: 12, color: muted }}>{plan.durations.map((d, i) => `${durLabel(d)} ${per[i]}`).join(" / ")}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: muted }}>
                      比例 <InputNumber size="small" min={0} max={20} value={c.ratio} disabled={frozen} style={{ width: 56 }}
                        onChange={(v) => setCat(j, { ratio: Number(v ?? 0) })} />
                      <span>{negTotal ? `${((n / Math.max(1, negTotal)) * 100).toFixed(0)}%` : ""}</span>
                    </div>
                    <TreeSelect size="small" style={{ width: "100%", marginTop: 6 }} treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT}
                      maxTagCount={2} disabled={frozen} treeData={otherTree} value={c.anchors}
                      onChange={(v) => setCat(j, { anchors: v as string[] })} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 底部 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: muted }}>
          共 <b style={{ color: token.colorText }}>{allTotal}</b> 段 · 视频约 {hours.toFixed(1)} 小时
          {result && <> · 预览挑到 <b style={{ color: result.n_picked < allTotal ? token.colorError : token.colorSuccess }}>{result.n_picked}</b> 段
            {Object.entries(result.by_source).map(([k, v]) => ` · ${k} ${v}`).join("")}</>}
          {result?.warnings?.length ? <span style={{ color: token.colorWarning }}> · {result.warnings[0]}</span> : null}
        </span>
        <Space>
          <Button disabled={frozen} loading={busy === "save"} onClick={() => run("save")}>保存计划</Button>
          <Button loading={busy === "preview"} onClick={() => run("preview")}>预览</Button>
          {existing > 0 ? (
            <Popconfirm title={`测试集里已有 ${existing} 段，再生成会在此基础上再加 ${allTotal} 段（不跟已有的重叠）`}
              okText="再加一批" onConfirm={() => run("apply")} disabled={frozen || !allTotal}>
              <Button type="primary" disabled={frozen || !allTotal} loading={busy === "apply"}>生成</Button>
            </Popconfirm>
          ) : (
            <Button type="primary" disabled={frozen || !allTotal} loading={busy === "apply"} onClick={() => run("apply")}>生成</Button>
          )}
        </Space>
      </div>
    </div>
  );
}
