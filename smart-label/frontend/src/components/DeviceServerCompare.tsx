import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, InputNumber, Select, Space, Statistic, Table, Tag, Tooltip, Typography, message, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import request, { errMsg } from "@/utils/request";
import { listModelVersions, type ModelVersion } from "@/api/training";
import { BEHAV_NAMES, type PcSegment } from "@/utils/imuProtocols";

/**
 * 设备调试页「服务端预测」：把最近 N 秒收到的原始采样送到 AI 服务跑模型，
 * 跟板子自己识别的结果（0x07 当前行为、0x09 片段）放在同一条设备时间轴上比。
 */
export interface DevSample { dev: number | null; ax: number; ay: number; az: number; gx?: number; gy?: number; gz?: number }
export interface BoardEvent { ts: number; cls: number; conf: number }

interface ServerWindow { ts_ms: number | null; label: string; conf: number }
interface ServerSeg { start_ms: number | null; end_ms: number | null; label?: string; conf?: number; mean_conf?: number }
interface ServerResult {
  classes: string[]; window_s: number; stride_s: number; hz_model: number; mode: string; n_windows: number;
  windows: ServerWindow[]; segments?: Record<string, ServerSeg[]>; model_path: string;
  /** 端侧才有：同一批窗口 C 特征 / Python 特征 / sklearn / C 森林 交叉比，查端侧跟服务端为什么不一样 */
  diagnose?: { n: number; error?: string; edge_vs_sk?: number; skC_vs_edge?: number; skC_vs_sk?: number; verdict?: string;
    top?: { idx: number; name: string; c: number; py: number; z: number }[] };
}
interface EdgeModel { tag: string; kind?: string; hz?: number; classes?: string[]; train?: { job_id: number } | null }
interface Span { a: number; b: number; label: string; conf: number }

/** 蓝牙丢的样本板子上是有的：按采样周期把短缝线性补上，喂给服务端的才跟板子看到的一样多 */
function fillGaps(pts: DevSample[]): { pts: DevSample[]; filled: number; periodMs: number } {
  const iv = pts.slice(1).map((p, i) => p.dev! - pts[i].dev!).filter((x) => x > 0).sort((a, b) => a - b);
  const period = iv.length ? iv[Math.floor(iv.length / 2)] : 32;
  const maxFill = Math.round(2000 / period);     // 超过 2 秒的缝不补：那是真断了
  const out: DevSample[] = [];
  let filled = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    out.push(a);
    const b = pts[i + 1];
    if (!b) break;
    const g = Math.round((b.dev! - a.dev!) / period) - 1;
    if (g >= 1 && g <= maxFill) {
      for (let k = 1; k <= g; k++) {
        const f = k / (g + 1), L = (x: number, y: number) => x + (y - x) * f;
        out.push({ dev: a.dev! + (b.dev! - a.dev!) * f, ax: L(a.ax, b.ax), ay: L(a.ay, b.ay), az: L(a.az, b.az),
          ...(a.gx != null && b.gx != null ? { gx: L(a.gx, b.gx), gy: L(a.gy!, b.gy!), gz: L(a.gz!, b.gz!) } : {}) });
      }
      filled += g;
    }
  }
  return { pts: out, filled, periodMs: period };
}

/** 逐窗口：每个窗口画到下一个窗口开始（不按步长画——数据有缝时会一截一截的）；后处理：画片段 */
function spansOf(r: ServerResult | null, post: boolean): Span[] {
  if (!r) return [];
  if (post && r.segments) {
    const out: Span[] = [];
    for (const [label, segs] of Object.entries(r.segments)) for (const g of segs) {
      if (g.start_ms != null && g.end_ms != null) out.push({ a: g.start_ms, b: g.end_ms, label: g.label ?? label, conf: g.mean_conf ?? g.conf ?? 1 });
    }
    return out.sort((x, y) => x.a - y.a);
  }
  const ws = r.windows.filter((w) => w.ts_ms != null) as (ServerWindow & { ts_ms: number })[];
  // 窗口按「结束时刻」放：板子在一个窗口采完才出结果，用开始时刻会显得服务端提前了一个窗口
  const W = r.window_s * 1000, st = r.stride_s * 1000;
  return ws.map((w, i) => ({ a: w.ts_ms + W - st, b: Math.min((ws[i + 1]?.ts_ms ?? w.ts_ms + st) + W - st, w.ts_ms + W + st), label: w.label, conf: w.conf }));
}

const labelAt = (spans: Span[], t: number): Span | null => {
  let best: Span | null = null, bd = Infinity;
  for (const s of spans) {
    if (t >= s.a && t < s.b) return s;
    const d = Math.min(Math.abs(t - s.a), Math.abs(t - s.b));
    if (d < bd) { bd = d; best = s; }
  }
  return bd <= 3000 ? best : null;
};
interface ModelInfo {
  tag: string; name: string; is_default?: boolean; hz?: number | null; classes?: string[] | null; model_path?: string;
  train?: { job_id: number; axes?: number; hz?: number; macro_f1?: number | null; model_type?: string; dataset?: string; classes?: string[] | null };
}

/** 下拉里一行要让人一眼分得清：训练记录号、几轴、采样率、F1。光写目录名的话全是「rf」 */
interface ModelChoice {
  tag: string; label: string; detail: string; axes: number | null; hz: number | null; f1: number | null;
  vid: number | null; jobId: number | null; group: "best" | "acc3" | "acc6" | "other"; isDefault: boolean;
}

const parseJson = (s: string | null | undefined): Record<string, unknown> => {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
};

/** 板子只有加速度、跑 31.25Hz：3 轴 + 同采样率的才是公平的比法，里面 F1 最高的推荐 */
function buildChoices(models: ModelInfo[], versions: ModelVersion[], devHz: number, devAxes: 3 | 6 = 3): ModelChoice[] {
  const byJob = new Map(versions.map((v) => [v.algo_job_id, v]));
  const out: ModelChoice[] = models.map((m) => {
    const t = m.train;
    const v = t ? byJob.get(t.job_id) : undefined;
    const spec = parseJson(v?.dataset_spec);
    const met = parseJson(v?.metrics);
    const axes = t ? Number(t.axes ?? spec.axes ?? 6) : null;
    const hz = t ? Number(t.hz ?? spec.hz ?? 16) : (m.hz ?? null);
    const f1 = typeof t?.macro_f1 === "number" ? t.macro_f1 : typeof met.macro_f1 === "number" ? (met.macro_f1 as number) : null;
    const mt = t?.model_type ?? v?.model_type ?? "";
    const head = m.is_default ? "线上默认模型" : t ? `训练记录 #${v?.id ?? `?（算法 ${t.job_id}，平台上已删）`}` : m.tag;
    const bits = [head, mt, axes ? `${axes}轴` : "", hz ? `${hz}Hz` : "", f1 != null ? `F1 ${f1.toFixed(3)}` : ""].filter(Boolean);
    const sameHz = hz != null && Math.abs(hz - devHz) < 0.01;
    return {
      tag: m.tag, label: bits.join(" · "), axes, hz, f1, vid: v?.id ?? null, jobId: t?.job_id ?? null, isDefault: !!m.is_default,
      group: axes === 3 ? "acc3" : axes === 6 ? "acc6" : "other",
      detail: `${t?.dataset ? `数据集 ${t.dataset}` : ""}${(t?.classes ?? m.classes) ? `　类别 ${(t?.classes ?? m.classes)!.join("/")}` : ""}${sameHz || hz == null ? "" : `　⚠ 训练用 ${hz}Hz，设备是 ${devHz}Hz（会重采样，但不如同采样率训的准）`}`,
    };
  });
  // 公平的比法：轴数跟设备一样（项圈只有加速度 → 3 轴；WitMotion 六轴 → 6 轴）、采样率一样
  const fair = out.filter((c) => c.axes === devAxes && c.hz != null && Math.abs(c.hz - devHz) < 0.01);
  const best = [...fair].sort((a, b) => (b.f1 ?? -1) - (a.f1 ?? -1))[0];
  if (best) best.group = "best";
  const rank = (c: ModelChoice) => (devAxes === 6 ? { best: 0, acc6: 1, other: 2, acc3: 3 } : { best: 0, acc3: 1, other: 2, acc6: 3 })[c.group];
  return out.sort((a, b) => rank(a) - rank(b)
    || Number(b.hz != null && Math.abs(b.hz - devHz) < 0.01) - Number(a.hz != null && Math.abs(a.hz - devHz) < 0.01)
    || (b.f1 ?? -1) - (a.f1 ?? -1));
}

const groupName = (g: ModelChoice["group"], devAxes: 3 | 6): string => ({
  best: `★ 推荐（${devAxes} 轴、跟设备同采样率、F1 最高）`,
  acc3: devAxes === 3 ? "3 轴（只用加速度，跟板子一样）" : "3 轴（只用加速度，不用陀螺仪）",
  other: "其它",
  acc6: devAxes === 3 ? "6 轴（要陀螺仪，板子没有，按 0 喂，结果会偏，不建议）" : "6 轴（加速度 + 陀螺仪，跟设备一样）",
})[g];
const MODEL_KEY = "smart-label:device-debug-model";

// 板子是 4 类；服务端模型类别可能更细，比对时按名字归一下（甩动类并进活动——板子的后处理也是这么做的）
const TO_BOARD: Record<string, string> = { "甩身体": "活动", "甩头/抖身": "活动", "甩动": "活动", "行走": "活动", "奔跑": "活动" };
const norm = (l: string) => TO_BOARD[l] ?? l;
const COLORS: Record<string, string> = { "睡觉": "#4c72b0", "未佩戴": "#8c8c8c", "活动": "#55a868", "抓挠": "#c44e52" };
const colorOf = (l: string) => COLORS[l] ?? "#dd8452";

/**
 * 一条时间轴。**必须定义在组件外面**：写在组件里的话每次渲染都是一个新的组件类型，
 * React 会把整行卸掉重建——页面每秒刷一次采样率，鼠标停在色块上的提示框一秒就没了
 */
function Row({ name, spans, t0, t1 }: { name: string; spans: Span[]; t0: number; t1: number }) {
const { token } = theme.useToken();
return (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
    <div style={{ width: 140, fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>{name}</div>
    <div style={{ position: "relative", flex: 1, height: 22, background: token.colorFillQuaternary, borderRadius: 4, overflow: "hidden" }}>
      {spans.map((s, i) => {
        const l = ((Math.max(s.a, t0) - t0) / (t1 - t0)) * 100, w = ((Math.min(s.b, t1) - Math.max(s.a, t0)) / (t1 - t0)) * 100;
        return w > 0 ? (
          <Tooltip key={i} title={`${s.label} ${s.conf <= 1 ? Math.round(s.conf * 100) : s.conf}% · ${new Date(s.a).toLocaleTimeString()}–${new Date(s.b).toLocaleTimeString()}`}>
            <div style={{ position: "absolute", left: `${l}%`, width: `${w}%`, top: 2, bottom: 2, background: colorOf(norm(s.label)), opacity: 0.85, borderRight: `1px solid ${token.colorBgContainer}` }} />
          </Tooltip>
        ) : null;
      })}
    </div>
  </div>
);
}

export default function DeviceServerCompare({ getSamples, boardEvents, segs, hz, connected, board = true, axes = 3 }: {
  getSamples: () => DevSample[];
  boardEvents: BoardEvent[];
  segs: PcSegment[];
  hz: number;
  connected: boolean;
  /** 设备自己会报识别结果（自制项圈的 0x07 / 0x09）。WitMotion 没有：只比服务端和端侧 */
  board?: boolean;
  /** 设备有几轴：项圈 3（只有加速度），WitMotion 6。推荐模型按它挑 */
  axes?: 3 | 6;
}) {
  const { token } = theme.useToken();
  const { data: models } = useQuery({
    queryKey: ["device-debug-models"],
    queryFn: () => request.get<never, ModelInfo[]>("/device-debug/models"),
    staleTime: 60_000,
  });
  const { data: versions } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions, staleTime: 60_000 });
  const choices = useMemo(() => buildChoices(models ?? [], versions ?? [], hz, axes), [models, versions, hz, axes]);
  // 选过的记住；没选过（或选的那版已经没了）就用推荐的那个
  const [picked, setPickedState] = useState<string | undefined>(() => {
    try { return localStorage.getItem(`${MODEL_KEY}:${axes}`) || undefined; } catch { return undefined; }
  });
  const setModel = (v: string | undefined) => {
    setPickedState(v);
    try { if (v) localStorage.setItem(`${MODEL_KEY}:${axes}`, v); else localStorage.removeItem(`${MODEL_KEY}:${axes}`); } catch { /* ignore */ }
  };
  const recommended = choices.find((c) => c.group === "best");
  const model = picked && choices.some((c) => c.tag === picked) ? picked : recommended?.tag;
  const cur = choices.find((c) => c.tag === model) ?? choices.find((c) => c.isDefault);
  const [post, setPost] = useState(false);   // false = 逐窗口原始；true = 后处理（服务端 viterbi / 端侧走板上那份 C）
  const [secs, setSecs] = useState(60);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ServerResult | null>(null);
  const [edgeRes, setEdgeRes] = useState<ServerResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edgeErr, setEdgeErr] = useState<string | null>(null);
  const [fillInfo, setFillInfo] = useState<{ filled: number; n: number; periodMs: number } | null>(null);
  const [align, setAlign] = useState(true);
  const busyRef = useRef(false);

  // 端侧：服务器上跑的板子那份 C。默认挑跟服务端模型同一条训练记录导出来的那个——「服务版变成端侧」
  const { data: edge } = useQuery({
    queryKey: ["device-debug-edge-models"],
    queryFn: () => request.get<never, { enabled: boolean; models: EdgeModel[] }>("/device-debug/edge-models"),
    staleTime: 60_000,
  });
  const edgeModels = edge?.models ?? [];
  const [edgePicked, setEdgePicked] = useState<string | undefined>(undefined);
  const edgeMatch = cur?.jobId != null ? edgeModels.find((m) => m.train?.job_id === cur.jobId) : undefined;
  const edgeTag = edgePicked === "__off" ? undefined : (edgePicked && edgeModels.some((m) => m.tag === edgePicked) ? edgePicked : edgeMatch?.tag);
  const vidOfJob = (j?: number) => (j == null ? undefined : (versions ?? []).find((v) => v.algo_job_id === j)?.id);
  const edgeLabel = (m: EdgeModel) => `${m.tag}${m.train ? ` · 训练记录 #${vidOfJob(m.train.job_id) ?? "?"}` : ""}${m.kind ? ` · ${m.kind === "sk" ? "sklearn" : `C ${m.kind}`}` : ""}${m.hz ? ` · ${m.hz}Hz` : ""}`;

  const run = async () => {
    if (busyRef.current) return;
    const all = getSamples().filter((s) => s.dev != null);
    if (all.length < hz * 3) { setErr("最近收到的原始采样不够（至少 3 秒）"); return; }
    const end = all[all.length - 1].dev!;
    const raw = all.filter((s) => s.dev! >= end - secs * 1000);
    // 补缝只对带设备时间戳的（项圈）有意义；WitMotion 的时间是接收端的、成批到，补的话会凭空插出样本
    const { pts, filled, periodMs } = board ? fillGaps(raw) : { pts: raw, filled: 0, periodMs: raw.length > 1 ? (raw[raw.length - 1].dev! - raw[0].dev!) / (raw.length - 1) : 0 };
    setFillInfo({ filled, n: pts.length, periodMs });
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setEdgeErr(null);
    const hasGyro = pts.some((s) => s.gx != null);
    // hz 按期望值给（31.25），不按实测：板子也是把收到的样本当 31.25Hz 用的，要比的是同一件事
    const body = {
      t_ms: pts.map((s) => Math.round(s.dev!)), acc: pts.map((s) => [s.ax, s.ay, s.az]),
      gyro: hasGyro ? pts.map((s) => [s.gx ?? 0, s.gy ?? 0, s.gz ?? 0]) : null, hz,
    };
    const msg = errMsg;
    const opt = { timeout: 120_000, silent: true } as const;
    const [a, b] = await Promise.allSettled([
      request.post<never, ServerResult>("/device-debug/infer", { ...body, mode: post ? "viterbi" : "raw", model }, opt),
      edgeTag ? request.post<never, ServerResult>("/device-debug/edge-infer", { ...body, mode: post ? "board" : "raw", model: edgeTag, diagnose: true }, opt)
        : Promise.resolve(null),
    ]);
    if (a.status === "fulfilled") setRes(a.value); else { setErr(msg(a.reason)); if (!auto) message.error(`服务端预测失败：${msg(a.reason)}`); }
    if (b.status === "fulfilled") setEdgeRes(b.value); else { setEdgeErr(msg(b.reason)); setEdgeRes(null); }
    busyRef.current = false;
    setBusy(false);
  };
  useEffect(() => {
    if (!auto || !connected) return;
    void run();
    const t = window.setInterval(() => void run(), Math.max(10, secs / 2) * 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, connected, secs, post, model, edgeTag]);

  const view = useMemo(() => {
    const srv = spansOf(res, post);
    const edg = spansOf(edgeRes, post);
    const any = srv.length ? srv : edg;
    if (!any.length) return null;
    const t0 = Math.min(...[srv, edg].filter((x) => x.length).map((x) => x[0].a));
    const t1 = Math.max(...[srv, edg].filter((x) => x.length).map((x) => x[x.length - 1].b));
    const ev = [...boardEvents].sort((x, y) => x.ts - y.ts);
    // 0x07 是「当前行为」的定时快照（一两秒一条），不是片段。连着一样的并成一块画，
    // 不然一条一个格子，看着像固定间隔的窗口；置信度取这一块里的平均
    const boardRaw: Span[] = [];
    ev.forEach((e, i) => {
      const label = BEHAV_NAMES[e.cls] ?? `?${e.cls}`, b = ev[i + 1]?.ts ?? e.ts + 5000;
      const last = boardRaw[boardRaw.length - 1];
      if (last && last.label === label && Math.abs(last.b - e.ts) < 10_000) {
        const n = (last as Span & { n?: number }).n ?? 1;
        last.conf = (last.conf * n + e.conf) / (n + 1);
        (last as Span & { n?: number }).n = n + 1;
        last.b = b;
      } else boardRaw.push({ a: e.ts, b, label, conf: e.conf });
    });
    const evIn = ev.filter((e) => e.ts >= t0 && e.ts <= t1);
    const agreeAt = (spans: Span[], lag: number) => {
      let n = 0, same = 0;
      for (const e of evIn) {
        const s = labelAt(spans, e.ts - lag);
        if (!s) continue;
        n++;
        if (norm(s.label) === (BEHAV_NAMES[e.cls] ?? "")) same++;
      }
      return n ? same / n : null;
    };
    // 板子报的是「后处理过、隔一会儿报一次」的当前行为，天然比窗口晚几秒。
    // 在 0~15 秒里找让板子和服务端最一致的那个延迟（只往「板子晚」那边找，不会反过来凑数）
    let lag = 0;
    const ref = srv.length ? srv : edg;
    if (evIn.length >= 5) {
      let best = agreeAt(ref, 0) ?? 0;
      for (let L = 500; L <= 15000; L += 500) {
        const v = agreeAt(ref, L) ?? 0;
        if (v > best + 0.02) { best = v; lag = L; }
      }
    }
    const useLag = align ? lag : 0;
    const shift = (sp: Span[]) => sp.map((x) => ({ ...x, a: x.a + useLag, b: x.b + useLag }));
    const srvS = shift(srv), edgS = shift(edg);
    const T0 = t0 + useLag, T1 = t1 + useLag;
    const boardSpans = boardRaw.filter((x) => x.b > T0 && x.a < T1);
    const segSpans = segs.filter((x) => x.startMs != null).map((x) => ({ a: x.startMs!, b: x.startMs! + x.durS * 1000, label: BEHAV_NAMES[x.cls] ?? `?${x.cls}`, conf: x.conf }))
      .filter((x) => x.b > T0 && x.a < T1);
    const pairs = ev.filter((e) => e.ts >= T0 && e.ts <= T1).map((e) => {
      const board = BEHAV_NAMES[e.cls] ?? `?${e.cls}`;
      const s = labelAt(srvS, e.ts), g = labelAt(edgS, e.ts);
      return { ts: e.ts, board, boardConf: e.conf, server: s, edge: g,
        sOk: s ? norm(s.label) === board : null, eOk: g ? norm(g.label) === board : null };
    });
    const rate = (xs: (boolean | null)[]) => { const v = xs.filter((x) => x != null); return v.length ? v.filter(Boolean).length / v.length : null; };
    // 服务端模型 vs 服务器上的端侧：每秒取一个点比（量化 / 移植成 C 带来的差异）
    let se: number | null = null;
    if (srv.length && edg.length) {
      let n = 0, same = 0;
      for (let t = t0; t < t1; t += 1000) {
        const a1 = labelAt(srv, t), b1 = labelAt(edg, t);
        if (a1 && b1) { n++; if (norm(a1.label) === norm(b1.label)) same++; }
      }
      se = n ? same / n : null;
    }
    const cnt: Record<string, number> = {};
    for (const w of res?.windows ?? []) cnt[w.label] = (cnt[w.label] ?? 0) + 1;
    return { t0: T0, t1: T1, srvS, edgS, boardSpans, segSpans, pairs, lag, useLag,
      sAgree: rate(pairs.map((p) => p.sOk)), eAgree: rate(pairs.map((p) => p.eOk)), se, cnt, n: res?.windows.length ?? 0 };
  }, [res, edgeRes, boardEvents, segs, post, align]);


  const pct = (v: number | null | undefined) => (v == null ? "-" : `${Math.round(v * 100)}%`);
  return (
    <Card size="small" title={board ? "服务端预测 · 三方对比" : "服务端预测（服务端模型 / 端侧）"} style={{ marginTop: 12 }}
      extra={
        <Space wrap size={6}>
          <Select size="small" style={{ width: 340 }} popupMatchSelectWidth={false} placeholder="线上默认模型" allowClear
            value={model} onChange={setModel} showSearch optionFilterProp="label"
            options={(["best", "acc3", "other", "acc6"] as const)
              .map((g) => ({ label: groupName(g, axes), options: choices.filter((c) => c.group === g).map((c) => ({
                value: c.tag, label: c.label, title: c.detail,
              })) }))
              .filter((g) => g.options.length)}
            optionRender={(o) => {
              const c = choices.find((x) => x.tag === o.value);
              return (
                <div style={{ lineHeight: 1.35, padding: "2px 0" }}>
                  <div>{c?.label}{c?.group === "best" && <Tag color="gold" style={{ marginLeft: 6 }}>推荐</Tag>}</div>
                  {c?.detail && <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{c.detail}</div>}
                </div>
              );
            }} />
          <Select size="small" style={{ width: 240 }} popupMatchSelectWidth={false} placeholder={edgeModels.length ? "端侧：不跑" : "端侧服务没开"}
            disabled={!edgeModels.length} value={edgeTag ?? "__off"} onChange={setEdgePicked}
            options={[{ value: "__off", label: "端侧：不跑" }, ...edgeModels.map((m) => ({
              value: m.tag, label: `端侧 ${edgeLabel(m)}${m.tag === edgeMatch?.tag ? "（同一版导出的）" : ""}` }))]} />
          <Select size="small" style={{ width: 150 }} value={post ? "post" : "raw"} onChange={(v) => setPost(v === "post")}
            options={[{ value: "raw", label: "逐窗口原始" }, { value: "post", label: "后处理（跟板子一样）" }]} />
          <span style={{ fontSize: 12 }}>最近</span>
          <InputNumber size="small" min={10} max={600} step={10} value={secs} onChange={(v) => v && setSecs(v)} style={{ width: 70 }} />
          <span style={{ fontSize: 12 }}>秒</span>
          <Button size="small" type="primary" loading={busy} disabled={!connected} onClick={run}>跑一次</Button>
          <Tooltip title={`连着的时候每 ${Math.max(10, secs / 2)} 秒自动跑一次`}>
            <Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)}>自动</Checkbox>
          </Tooltip>
        </Space>
      }>
      {err && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={err} />}
      {!res && !err && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {board ? "要原始采样（0x08）。" : "WitMotion 自己不识别行为：这里只比服务端模型和端侧。"}{recommended
            ? <>默认用推荐的「{recommended.label}」：{axes} 轴、跟设备同是 {hz}Hz 训的里面 F1 最高的{board ? "，比出来才公平" : ""}。</>
            : <>还没有 {axes} 轴、{hz}Hz 训的模型：去「模型训练」用 {axes} 轴 + {hz}Hz 训一版。{axes === 3 ? "6 轴模型陀螺仪按 0 喂，结果会偏。" : ""}</>}
        </Typography.Text>
      )}
      {edgeErr && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`端侧：${edgeErr}`} />}
      {!edgeModels.length && edge && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
          {edge.enabled ? "端侧服务上没有模型：训练记录里点「导出到端侧」。" : "没配端侧服务（EDGE_SERVICE_URL），只比服务端和板子。"}
        </Typography.Text>
      )}
      {edgeModels.length > 0 && !edgeMatch && edgeTag && cur?.jobId != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
          这一版（{cur.label}）还没导出到端侧，端侧那行用的是别的模型，差异里混着模型本身的不同。
        </Typography.Text>
      )}
      {view && (
        <>
          <Space size={24} wrap style={{ marginBottom: 8 }} align="start">
            {board && <Statistic title="服务端 vs 板子" value={pct(view.sAgree)} suffix={<span style={{ fontSize: 12 }}>{view.pairs.length} 条 0x07</span>} />}
            {board && edgeRes && <Statistic title="端侧(服务器) vs 板子" value={pct(view.eAgree)} />}
            {edgeRes && res && <Statistic title="服务端 vs 端侧(服务器)" value={pct(view.se)} suffix={<span style={{ fontSize: 12 }}>量化 / 移植差异</span>} />}
            <div style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.7 }}>
              服务端模型 {cur?.label ?? res?.model_path.split("/").slice(-2).join("/") ?? "-"}{res ? ` · ${res.window_s}s 窗 / ${res.stride_s}s 步` : ""}<br />
              {edgeRes && <>端侧 {edgeTag}<br /></>}
              {fillInfo && (board
                ? <>送了 {fillInfo.n} 个样本（采样周期 {fillInfo.periodMs.toFixed(0)} ms），其中 {fillInfo.filled} 个是蓝牙丢的、按前后补上的<br /></>
                : <>送了 {fillInfo.n} 个样本（含角速度），时间用接收端的<br /></>)}
              {board && <>
                <Checkbox checked={align} onChange={(e) => setAlign(e.target.checked)} style={{ fontSize: 12 }}>
                  扣掉板子的上报延迟
                </Checkbox>
                <Tooltip title="板子报的「当前行为」是窗口采完 + 后处理确认之后才发的，天然比数据晚几秒。在 0~15 秒里找让两边最一致的延迟，把服务端那几行往后挪这么多再比。不勾就是原始时刻直接比">
                  <span>估计板子晚 <b>{(view.lag / 1000).toFixed(1)} 秒</b> ⓘ</span>
                </Tooltip>
              </>}
            </div>
          </Space>
          {edgeRes?.diagnose && (() => {
            const d = edgeRes.diagnose!;
            if (d.error) return <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>端侧诊断：{d.error}</Typography.Text>;
            const bad = (d.edge_vs_sk ?? 1) < 0.95;
            return (
              <Alert type={bad ? "warning" : "success"} showIcon style={{ marginBottom: 8 }}
                message={<span>端侧诊断（同一批 {d.n} 个窗口）：<b>{d.verdict}</b></span>}
                description={bad ? (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ marginBottom: 4 }}>
                      端侧 C vs 服务端 sklearn 一致 {pct(d.edge_vs_sk)} · 用 <b>C 算的特征</b>喂 sklearn 后跟端侧一致 {pct(d.skC_vs_edge)}、跟服务端一致 {pct(d.skC_vs_sk)}
                      <Tooltip title="同一批窗口：特征换成 C 算的、森林还用 sklearn 的。如果结果跟着端侧走，说明差在特征；如果还跟服务端一样，说明差在森林导成 C 那一步">
                        <span> ⓘ</span>
                      </Tooltip>
                    </div>
                    <Table size="small" pagination={false} rowKey="idx" dataSource={d.top?.slice(0, 6) ?? []}
                      columns={[
                        { title: "差得最多的特征", dataIndex: "name" },
                        { title: "C 算的（均值）", dataIndex: "c" },
                        { title: "Python 算的（均值）", dataIndex: "py" },
                        { title: "差了几倍离散度", dataIndex: "z" },
                      ]} />
                  </div>
                ) : undefined} />
            );
          })()}
          {board && <Row name="板子 · 当前行为(0x07)" spans={view.boardSpans} t0={view.t0} t1={view.t1} />}
          {!board ? null : view.segSpans.length > 0 ? <Row name="板子 · 片段(0x09)" spans={view.segSpans} t0={view.t0} t1={view.t1} /> : (
            <div style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 12, color: token.colorTextTertiary }}>
              <div style={{ width: 140, flexShrink: 0 }}>板子 · 片段(0x09)</div>
              <div>这段时间里还没有 0x09：板子一个片段<b>结束了</b>才发，正在进行的那段要等它结束（看下面「行为片段」表）</div>
            </div>
          )}
          {edgeRes && <Row name={`端侧(服务器) · ${post ? "板上后处理" : "逐窗口"}`} spans={view.edgS} t0={view.t0} t1={view.t1} />}
          {res && <Row name={`服务端 · ${post ? "稳定版" : "逐窗口"}`} spans={view.srvS} t0={view.t0} t1={view.t1} />}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: token.colorTextTertiary, marginLeft: 148 }}>
            <span>{new Date(view.t0).toLocaleTimeString()}</span><span>{new Date(view.t1).toLocaleTimeString()}</span>
          </div>
          <Space size={10} wrap style={{ marginTop: 6 }}>
            {Object.entries(COLORS).map(([k, c]) => <span key={k} style={{ fontSize: 12 }}><span style={{ display: "inline-block", width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4 }} />{k}</span>)}
            <span style={{ fontSize: 12 }}><span style={{ display: "inline-block", width: 10, height: 10, background: "#dd8452", borderRadius: 2, marginRight: 4 }} />其它</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {board ? "甩动类算作活动 · 想比得公平选「后处理」：板子报的是后处理过的结果，逐窗口原始会更碎" : "甩动类算作活动"}
            </Typography.Text>
          </Space>
          {view.pairs.some((p) => p.sOk === false || p.eOk === false) && (
            <Table size="small" style={{ marginTop: 8 }} rowKey="ts" pagination={{ pageSize: 8, hideOnSinglePage: true }}
              dataSource={view.pairs.filter((p) => p.sOk === false || p.eOk === false)}
              columns={[
                { title: "时刻", render: (_: unknown, p) => new Date(p.ts).toLocaleTimeString() },
                { title: "板子", render: (_: unknown, p) => <Tag color={colorOf(p.board)}>{p.board} {p.boardConf}%</Tag> },
                ...(edgeRes ? [{ title: "端侧(服务器)", render: (_: unknown, p: (typeof view.pairs)[number]) => p.edge
                  ? <Tag color={colorOf(norm(p.edge.label))}>{p.edge.label}{p.edge.conf <= 1 ? ` ${Math.round(p.edge.conf * 100)}%` : ""}</Tag> : "-" }] : []),
                { title: "服务端", render: (_: unknown, p) => p.server
                  ? <Tag color={colorOf(norm(p.server.label))}>{p.server.label}{p.server.conf <= 1 ? ` ${Math.round(p.server.conf * 100)}%` : ""}</Tag> : "-" },
              ]} />
          )}
        </>
      )}
    </Card>
  );
}
