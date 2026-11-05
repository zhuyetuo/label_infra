/**
 * 设备自检：一段连续采样（每个样本带板子时间戳 + 电脑收到的时间）算出一份报告。
 * 纯函数，不碰浏览器 API；页面和导出的 HTML 报告用的是同一份结果。
 *
 * 口径：
 *   - 采样率 / 帧间隔 / 时间漂移 / 底噪全部按**板子时间戳**算。蓝牙晚到、成批到不影响这些数。
 *   - 丢帧 = 板子时间戳上的缝。**分不清是蓝牙丢的还是板子没发**（0x08 没有样本序号）；
 *     缝出现时电脑这边是否也卡了一下，只能当线索。要分清得固件加序号 / 计数（报告里写给嵌入式）。
 *   - 板子时钟快慢：板上时间 − 电脑时间，每 2 秒取最大的那个（蓝牙只会让样本晚到），Theil–Sen 拟合斜率。
 *     电脑时间一般有 NTP，当作真实时间。
 *   - 底噪：要项圈**静置**。短时噪声用一阶差分估（去掉慢漂移），稳定性看每 10 秒均值怎么走。
 */

export interface StSample { host: number; dev: number | null; ax: number; ay: number; az: number }
export type StStatus = "ok" | "warn" | "fail" | "info";
export interface StItem { group: string; name: string; value: string; status: StStatus; note?: string }

export interface StReport {
  meta: { device: string; kind: string; startedAt: number; durationS: number; expectHz: number; staticClaimed: boolean; n: number; droppedHead: number };
  rate: { periodMs: number; sensorHz: number; byDevHz: number; byHostHz: number; blocks: { t: number; hz: number; sensorHz: number }[] };
  iv: { mean: number; std: number; jitterStd: number; min: number; max: number; p1: number; p5: number; p50: number; p95: number; p99: number;
    within10: number; dup: number; alternating: number; hist: { ms: number; n: number }[] };
  gaps: { n: number; lost: number; lossPct: number; maxMs: number; perMin: number; withHostStall: number; sizes: Record<string, number>;
    list: { t: number; ms: number; missing: number; hostGapMs: number }[] };
  clock: { offStartMs: number; offEndMs: number; ppm: number | null; ppmErr: number | null; jitterMs: number | null; fitS: number; pts: { t: number; off: number }[] };
  noise: { isStatic: boolean; axes: { name: string; mean: number; std: number; short: number; p2p: number; blockRange: number; slopePerMin: number }[];
    magMean: number; magStd: number; blocks: { t: number; ax: number; ay: number; az: number }[] };
  behav: { n: number; perMin: number };
  items: StItem[];
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const linSlope = (t: number[], y: number[]) => {
  const mt = mean(t), my = mean(y);
  const sxx = t.reduce((s, x) => s + (x - mt) ** 2, 0);
  return sxx > 0 ? t.reduce((s, x, i) => s + (x - mt) * (y[i] - my), 0) / sxx : 0;
};

/** Theil–Sen 斜率 + 残差 MAD 估的误差（不怕蓝牙卡顿那几个大坑） */
function robustSlope(pts: { t: number; off: number }[]): { slope: number | null; err: number | null; jitter: number | null } {
  if (pts.length < 10) return { slope: null, err: null, jitter: null };
  const step = Math.max(1, Math.floor(pts.length / 150));
  const sub = pts.filter((_, i) => i % step === 0);
  const sl: number[] = [];
  for (let i = 0; i < sub.length; i++) for (let j = i + 1; j < sub.length; j++) {
    const dt = sub[j].t - sub[i].t;
    if (dt >= 10) sl.push((sub[j].off - sub[i].off) / dt);
  }
  if (!sl.length) return { slope: null, err: null, jitter: null };
  const slope = q(sl, 0.5);
  const icpt = q(pts.map((p) => p.off - slope * p.t), 0.5);
  const res = pts.map((p) => Math.abs(p.off - slope * p.t - icpt));
  const sigma = 1.4826 * q(res, 0.5);
  const T = pts[pts.length - 1].t - pts[0].t;
  return { slope, err: T > 0 ? (sigma * Math.sqrt(12)) / (Math.sqrt(pts.length) * T) : null, jitter: sigma };
}

export function analyzeSelfTest(raw: StSample[], opt: { expectHz: number; device: string; kind: string; startedAt: number; staticClaimed: boolean; behavTs?: number[]; timeOrigin: number }): StReport {
  // 板子时间中途跳了（测试中间校时）：只用最后一次跳之后的那段
  let start = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1].dev, b = raw[i].dev;
    if (a != null && b != null && (b - a > 10_000 || b - a < -1000)) start = i;
  }
  const s = raw.slice(start).filter((x) => x.dev != null) as (StSample & { dev: number })[];
  const n = s.length;
  const iv = s.slice(1).map((x, i) => x.dev - s[i].dev);
  const pos = iv.filter((x) => x > 0);
  const P = q(pos, 0.5) || 1000 / opt.expectHz;
  const spanDev = n > 1 ? (s[n - 1].dev - s[0].dev) / 1000 : 0;
  const spanHost = n > 1 ? (s[n - 1].host - s[0].host) / 1000 : 0;

  // ── 采样率：每 10 秒一块（按板子时间）
  // hz = 这 10 秒实际到手几个（含丢帧）；sensorHz = 这 10 秒帧间隔中位数换算的（传感器节奏，不受丢帧影响）
  const blocks: { t: number; hz: number; sensorHz: number }[] = [];
  if (n > 1) {
    const t0 = s[0].dev;
    const cnt = new Map<number, number>();
    const ivs = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const k = Math.floor((s[i].dev - t0) / 10_000);
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
      if (i > 0) { const d = s[i].dev - s[i - 1].dev; if (d > 0) (ivs.get(k) ?? ivs.set(k, []).get(k)!).push(d); }
    }
    const last = Math.floor((s[n - 1].dev - t0) / 10_000);
    for (let k = 0; k < last; k++) {   // 最后一块不完整，不要
      const m = q(ivs.get(k) ?? [], 0.5);
      blocks.push({ t: k * 10, hz: (cnt.get(k) ?? 0) / 10, sensorHz: Number.isFinite(m) && m > 0 ? 1000 / m : NaN });
    }
  }

  // ── 帧间隔
  const normal = iv.filter((x) => x > 0 && x <= P * 1.5);
  let alt = 0;
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i - 1], b = iv[i];
    if ((a > P * 1.15 && b < P * 0.85 && b > 0) || (a < P * 0.85 && a > 0 && b > P * 1.15 && b <= P * 1.5)) alt++;
  }
  const histMap = new Map<number, number>();
  for (const x of iv) { const k = Math.max(0, Math.min(Math.round(x), Math.round(P * 3))); histMap.set(k, (histMap.get(k) ?? 0) + 1); }
  const hist = [...histMap.entries()].sort((a, b) => a[0] - b[0]).map(([ms, c]) => ({ ms, n: c }));

  // ── 丢帧
  const gapList: StReport["gaps"]["list"] = [];
  const sizes: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  let lost = 0, withStall = 0;
  for (let i = 0; i < iv.length; i++) {
    if (iv[i] > P * 1.5) {
      const missing = Math.max(1, Math.round(iv[i] / P) - 1);
      const hostGap = s[i + 1].host - s[i].host;
      lost += missing;
      sizes[missing >= 4 ? "4+" : String(missing)]++;
      if (hostGap > Math.max(300, iv[i])) withStall++;
      gapList.push({ t: (s[i].dev - s[0].dev) / 1000, ms: iv[i], missing, hostGapMs: hostGap });
    }
  }

  // ── 板子时钟
  const bucket = new Map<number, number>();
  for (const x of s) {
    const off = x.dev - (opt.timeOrigin + x.host);
    const k = Math.floor((x.host - s[0].host) / 2000);
    const prev = bucket.get(k);
    if (prev == null || off > prev) bucket.set(k, off);
  }
  const keys = [...bucket.keys()].sort((a, b) => a - b).slice(0, -1);
  const cpts = keys.map((k) => ({ t: k * 2, off: bucket.get(k)! }));
  const fit = cpts.filter((p) => p.t >= 10);   // 开头 10 秒可能有积压
  const rs = robustSlope(fit);
  const fitS = fit.length ? fit[fit.length - 1].t - fit[0].t : 0;

  // ── 底噪 / 稳定性
  const ax = s.map((x) => x.ax), ay = s.map((x) => x.ay), az = s.map((x) => x.az);
  const mag = s.map((x) => Math.hypot(x.ax, x.ay, x.az));
  const nb: { t: number; ax: number; ay: number; az: number }[] = [];
  if (n > 1) {
    const t0 = s[0].dev;
    const acc = new Map<number, { x: number; y: number; z: number; c: number }>();
    for (const x of s) {
      const k = Math.floor((x.dev - t0) / 10_000);
      const a = acc.get(k) ?? { x: 0, y: 0, z: 0, c: 0 };
      a.x += x.ax; a.y += x.ay; a.z += x.az; a.c++;
      acc.set(k, a);
    }
    for (const [k, a] of [...acc.entries()].sort((p, r) => p[0] - r[0])) if (a.c >= 10) nb.push({ t: k * 10, ax: a.x / a.c, ay: a.y / a.c, az: a.z / a.c });
  }
  const axis = (name: "X" | "Y" | "Z", v: number[], key: "ax" | "ay" | "az") => {
    const d = v.slice(1).map((x, i) => x - v[i]);
    const bm = nb.map((b) => b[key]);
    return {
      name, mean: mean(v), std: std(v) * 1000, short: (std(d) / Math.SQRT2) * 1000,
      p2p: v.length ? (Math.max(...v) - Math.min(...v)) * 1000 : NaN,
      blockRange: bm.length ? (Math.max(...bm) - Math.min(...bm)) * 1000 : NaN,
      slopePerMin: bm.length >= 3 ? linSlope(nb.map((b) => b.t / 60), bm) * 1000 : NaN,
    };
  };
  const axes = [axis("X", ax, "ax"), axis("Y", ay, "ay"), axis("Z", az, "az")];
  // 短时噪声大于 30 mg 基本是动了：底噪那几行不下结论
  const isStatic = axes.every((a) => a.short < 30) && std(mag) * 1000 < 50;

  const bt = (opt.behavTs ?? []).filter((t) => n > 1 && t >= s[0].dev && t <= s[n - 1].dev);

  const rep: StReport = {
    meta: { device: opt.device, kind: opt.kind, startedAt: opt.startedAt, durationS: spanHost, expectHz: opt.expectHz, staticClaimed: opt.staticClaimed, n, droppedHead: start },
    rate: { periodMs: P, sensorHz: 1000 / P, byDevHz: spanDev > 0 ? (n - 1) / spanDev : NaN, byHostHz: spanHost > 0 ? (n - 1) / spanHost : NaN, blocks },
    iv: { mean: mean(iv), std: std(iv), jitterStd: std(normal), min: Math.min(...iv), max: Math.max(...iv), p1: q(iv, 0.01), p5: q(iv, 0.05), p50: q(iv, 0.5), p95: q(iv, 0.95), p99: q(iv, 0.99),
      // 不含丢帧的缝：缝在「丢帧」里单独算，这里只看正常的那些间隔准不准
      within10: normal.length ? (normal.filter((x) => Math.abs(x - P) <= P * 0.1).length / normal.length) * 100 : NaN,
      dup: iv.filter((x) => x <= 0).length, alternating: alt, hist },
    gaps: { n: gapList.length, lost, lossPct: n + lost > 0 ? (lost / (n + lost)) * 100 : 0, maxMs: gapList.length ? Math.max(...gapList.map((g) => g.ms)) : 0,
      perMin: spanDev > 0 ? gapList.length / (spanDev / 60) : 0, withHostStall: withStall, sizes, list: gapList.slice(0, 500) },
    clock: { offStartMs: cpts[0]?.off ?? NaN, offEndMs: cpts[cpts.length - 1]?.off ?? NaN, ppm: rs.slope != null ? rs.slope * 1000 : null,
      ppmErr: rs.err != null ? rs.err * 1000 : null, jitterMs: rs.jitter, fitS, pts: cpts },
    noise: { isStatic, axes, magMean: mean(mag), magStd: std(mag) * 1000, blocks: nb },
    behav: { n: bt.length, perMin: spanDev > 0 ? bt.length / (spanDev / 60) : 0 },
    items: [],
  };
  rep.items = judge(rep);
  return rep;
}

const f = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));

function judge(r: StReport): StItem[] {
  const it: StItem[] = [];
  const E = r.meta.expectHz;
  const dev = (r.rate.sensorHz / E - 1) * 100;
  it.push({ group: "采样率", name: "传感器采样率（按帧间隔中位数）", value: `${f(r.rate.sensorHz)} Hz（周期 ${f(r.rate.periodMs, 1)} ms，标称 ${E} Hz，${dev >= 0 ? "+" : ""}${f(dev, 1)}%）`,
    status: Math.abs(dev) <= 2 ? "ok" : Math.abs(dev) <= 5 ? "warn" : "fail",
    note: Math.abs(dev) > 2 ? "跟标称对不上。时间戳可信时（见下面「板子时钟」），就是传感器实际的输出速率：查 ODR 配置 / 传感器内部振荡器" : undefined });
  it.push({ group: "采样率", name: "实际到手（含丢帧，按板子时间）", value: `${f(r.rate.byDevHz)} 个/秒`, status: "info" });
  const bh = r.rate.blocks.map((b) => b.sensorHz).filter(Number.isFinite);
  if (bh.length >= 3) {
    const rng = Math.max(...bh) - Math.min(...bh);
    const got = r.rate.blocks.map((b) => b.hz);
    it.push({ group: "采样率", name: "采样率稳定性（每 10 秒的传感器节奏）", value: `${f(Math.min(...bh))} ~ ${f(Math.max(...bh))} Hz，波动 ${f(rng)} Hz（实际到手 ${f(Math.min(...got), 1)} ~ ${f(Math.max(...got), 1)} 个/秒）`,
      status: rng <= r.rate.sensorHz * 0.02 ? "ok" : rng <= r.rate.sensorHz * 0.05 ? "warn" : "fail",
      note: rng > r.rate.sensorHz * 0.02 ? "传感器节奏本身在变：时钟源不稳 / ODR 被改过 / 读 FIFO 的方式有问题" : "到手个数的波动是丢帧造成的，看「丢帧」" });
  }
  it.push({ group: "帧间隔", name: `在 ${f(r.rate.periodMs, 1)}±10% ms 内（不含丢帧的缝）`, value: `${f(r.iv.within10, 1)}%`, status: r.iv.within10 >= 99 ? "ok" : r.iv.within10 >= 95 ? "warn" : "fail" });
  it.push({ group: "帧间隔", name: "间隔抖动（不含丢帧的缝）", value: `标准差 ${f(r.iv.jitterStd, 2)} ms · p1 ${f(r.iv.p1, 0)} / p50 ${f(r.iv.p50, 0)} / p99 ${f(r.iv.p99, 0)} ms`,
    status: r.iv.jitterStd <= r.rate.periodMs * 0.1 ? "ok" : r.iv.jitterStd <= r.rate.periodMs * 0.2 ? "warn" : "fail" });
  it.push({ group: "帧间隔", name: "一会长一会短（交替）", value: `${r.iv.alternating} 次`, status: r.iv.alternating <= Math.max(3, r.meta.n * 0.005) ? "ok" : "warn",
    note: r.iv.alternating > Math.max(3, r.meta.n * 0.005) ? "间隔长短交替：通常是固件按整 ms 打时间戳（34/35 交替），或者读 FIFO 的节奏跟采样不同步" : undefined });
  it.push({ group: "帧间隔", name: "时间戳没走（0 ms 间隔）", value: `${r.iv.dup} 次`, status: r.iv.dup ? "fail" : "ok", note: r.iv.dup ? "同一个时间戳出现两次：重复发送，或者时间戳分辨率不够" : undefined });
  it.push({ group: "丢帧", name: "丢帧率（时间戳上的缝）", value: `${f(r.gaps.lossPct, 2)}%（${r.gaps.lost} 个，${r.gaps.n} 处，最长 ${f(r.gaps.maxMs, 0)} ms）`,
    status: r.gaps.lossPct <= 0.1 ? "ok" : r.gaps.lossPct <= 1 ? "warn" : "fail" });
  if (r.gaps.n) {
    const pct = (r.gaps.withHostStall / r.gaps.n) * 100;
    it.push({ group: "丢帧", name: "缝出现时电脑这边也卡了", value: `${r.gaps.withHostStall} / ${r.gaps.n} 处（${f(pct, 0)}%）`, status: "info",
      note: pct >= 70 ? "大多伴随蓝牙卡顿：更像是蓝牙 / 发送队列丢的" : pct <= 30 ? "大多不伴随蓝牙卡顿：更像板子那边没发出来（读 FIFO 漏了 / 队列满了丢）" : "两种都有。要分清得固件给 0x08 加样本序号" });
  }
  const c = r.clock;
  if (c.fitS < 60 || c.ppm == null) {
    it.push({ group: "板子时钟", name: "时钟快慢（相对电脑）", value: c.ppm == null ? "-" : `${f(c.ppm, 0)} ppm（±${f(c.ppmErr, 0)}）`, status: "info", note: "测得太短（要 1 分钟以上，测漂移建议 10 分钟+）" });
  } else {
    const sure = Math.abs(c.ppm) > 3 * (c.ppmErr ?? 0);
    const perDay = (c.ppm * 86400) / 1e6;
    it.push({ group: "板子时钟", name: "时钟快慢（相对电脑）", value: `${c.ppm >= 0 ? "+" : ""}${f(c.ppm, 0)} ppm（±${f(c.ppmErr, 0)}，约每天${perDay >= 0 ? "快" : "慢"} ${f(Math.abs(perDay), 1)} 秒）`,
      status: !sure || Math.abs(c.ppm) <= 100 ? "ok" : Math.abs(c.ppm) <= 1000 ? "warn" : "fail",
      note: !sure ? "在测量误差以内，看不出快慢" : Math.abs(c.ppm) > 1000 ? "超过 0.1%：多半不是晶振（±20 ppm），是 RC 时钟或时间戳算法的问题" : undefined });
  }
  it.push({ group: "板子时钟", name: "板子比电脑", value: `开始 ${f(c.offStartMs, 0)} ms → 结束 ${f(c.offEndMs, 0)} ms`, status: Math.abs(c.offEndMs) > 5000 ? "warn" : "info",
    note: Math.abs(c.offEndMs) > 5000 ? "差好几秒：多半没校时" : undefined });
  if (c.jitterMs != null) it.push({ group: "板子时钟", name: "时间戳抖动（扣掉趋势后）", value: `${f(c.jitterMs, 1)} ms`, status: "info", note: "含蓝牙延迟的抖动，只当参考" });
  const nz = r.noise;
  if (!nz.isStatic) {
    it.push({ group: "三轴", name: "底噪 / 稳定性", value: "测试期间项圈动了", status: "info", note: "底噪要静置平放测：短时噪声超过 30 mg，这几项不下结论" });
  } else {
    for (const a of nz.axes) {
      it.push({ group: "三轴", name: `${a.name} 轴底噪（短时）`, value: `${f(a.short, 2)} mg rms（总 std ${f(a.std, 2)} mg，峰峰 ${f(a.p2p, 1)} mg）`,
        status: a.short <= 5 ? "ok" : a.short <= 15 ? "warn" : "fail" });
    }
    for (const a of nz.axes) {
      if (!Number.isFinite(a.blockRange)) continue;
      it.push({ group: "三轴", name: `${a.name} 轴稳定性（每 10 秒均值）`, value: `均值 ${f(a.mean, 4)} g · 漂了 ${f(a.blockRange, 2)} mg · ${f(a.slopePerMin, 2)} mg/分钟`,
        status: a.blockRange <= 5 ? "ok" : a.blockRange <= 20 ? "warn" : "fail" });
    }
    const md = (nz.magMean - 1) * 1000;
    it.push({ group: "三轴", name: "合加速度（静置应为 1 g）", value: `${f(nz.magMean, 4)} g（${md >= 0 ? "+" : ""}${f(md, 1)} mg）`,
      status: Math.abs(md) <= 30 ? "ok" : Math.abs(md) <= 80 ? "warn" : "fail",
      note: Math.abs(md) > 30 ? "偏离 1 g：量程 / 比例因子 / 零偏没校准" : undefined });
  }
  if (r.behav.n) it.push({ group: "行为上报", name: "0x07 当前行为", value: `${r.behav.n} 条，每分钟 ${f(r.behav.perMin, 1)} 条`, status: "info" });
  return it;
}

// ── 图（SVG 字符串：页面和导出的报告用同一份）──────────────────────────────

export function svgLine(series: { name: string; color: string; pts: { x: number; y: number }[] }[], o: { w?: number; h?: number; xLabel?: string; yLabel?: string } = {}): string {
  const W = o.w ?? 640, H = o.h ?? 160, L = 52, R = 10, T = 10, B = 28;
  const all = series.flatMap((s) => s.pts);
  if (!all.length) return "";
  const x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x)) || 1;
  let y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const X = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const fmt = (v: number) => (Math.abs(y1 - y0) < 0.1 ? v.toFixed(4) : Math.abs(y1 - y0) < 10 ? v.toFixed(2) : v.toFixed(0));
  const lines = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.5" points="${s.pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}"/>`).join("");
  const legend = series.length > 1 ? series.map((s, i) => `<text x="${L + 8 + i * 70}" y="${T + 12}" font-size="11" fill="${s.color}">■ ${s.name}</text>`).join("") : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#ccc"/>
<text x="${L - 4}" y="${T + 10}" font-size="10" text-anchor="end" fill="#888">${fmt(y1)}</text>
<text x="${L - 4}" y="${H - B}" font-size="10" text-anchor="end" fill="#888">${fmt(y0)}</text>
<text x="${L}" y="${H - 8}" font-size="10" fill="#888">${x0.toFixed(0)}</text>
<text x="${W - R}" y="${H - 8}" font-size="10" text-anchor="end" fill="#888">${x1.toFixed(0)}${o.xLabel ? " " + o.xLabel : ""}</text>
${o.yLabel ? `<text x="4" y="${T + 10}" font-size="10" fill="#888">${o.yLabel}</text>` : ""}
${lines}${legend}</svg>`;
}

export function svgBars(bars: { x: number; n: number }[], o: { w?: number; h?: number; mark?: number; xLabel?: string } = {}): string {
  const W = o.w ?? 640, H = o.h ?? 140, L = 40, R = 10, T = 10, B = 28;
  if (!bars.length) return "";
  const x0 = Math.min(...bars.map((b) => b.x)), x1 = Math.max(...bars.map((b) => b.x));
  const ymax = Math.max(...bars.map((b) => b.n));
  const bw = Math.max(1, (W - L - R) / (x1 - x0 + 1) - 1);
  const X = (x: number) => L + ((x - x0) / (x1 - x0 + 1)) * (W - L - R);
  // 纵轴用开方：最多的那一档（正常间隔）几万个，丢帧那几档只有几个，线性的话根本看不见
  const Hh = (n: number) => (Math.sqrt(n) / Math.sqrt(ymax || 1)) * (H - T - B);
  const rects = bars.map((b) => `<rect x="${X(b.x).toFixed(1)}" y="${(H - B - Hh(b.n)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Hh(b.n).toFixed(1)}" fill="${o.mark != null && Math.abs(b.x - o.mark) > o.mark * 0.5 ? "#c44e52" : "#4c72b0"}"><title>${b.x} ms：${b.n} 个</title></rect>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
${rects}<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#ccc"/>
<text x="${L}" y="${H - 8}" font-size="10" fill="#888">${x0}</text><text x="${W - R}" y="${H - 8}" font-size="10" text-anchor="end" fill="#888">${x1}${o.xLabel ? " " + o.xLabel : ""}</text>
<text x="4" y="${T + 10}" font-size="10" fill="#888">个数(√)</text></svg>`;
}

export function reportCharts(r: StReport) {
  return {
    rate: svgLine([
      { name: "传感器", color: "#4c72b0", pts: r.rate.blocks.filter((b) => Number.isFinite(b.sensorHz)).map((b) => ({ x: b.t, y: b.sensorHz })) },
      { name: "到手", color: "#dd8452", pts: r.rate.blocks.map((b) => ({ x: b.t, y: b.hz })) },
    ], { xLabel: "秒", yLabel: "Hz" }),
    hist: svgBars(r.iv.hist.map((h) => ({ x: h.ms, n: h.n })), { mark: r.rate.periodMs, xLabel: "ms" }),
    clock: svgLine([{ name: "板子−电脑", color: "#8172b2", pts: r.clock.pts.map((p) => ({ x: p.t, y: p.off - (r.clock.pts[0]?.off ?? 0) })) }], { xLabel: "秒", yLabel: "ms" }),
    axes: svgLine([
      { name: "X", color: "#c44e52", pts: r.noise.blocks.map((b) => ({ x: b.t, y: (b.ax - (r.noise.blocks[0]?.ax ?? 0)) * 1000 })) },
      { name: "Y", color: "#55a868", pts: r.noise.blocks.map((b) => ({ x: b.t, y: (b.ay - (r.noise.blocks[0]?.ay ?? 0)) * 1000 })) },
      { name: "Z", color: "#4c72b0", pts: r.noise.blocks.map((b) => ({ x: b.t, y: (b.az - (r.noise.blocks[0]?.az ?? 0)) * 1000 })) },
    ], { xLabel: "秒", yLabel: "mg" }),
  };
}

// ── 导出 ─────────────────────────────────────────────────────────────────

export function samplesCsv(raw: StSample[], timeOrigin: number): string {
  const head = "dev_ts_ms,host_ts_ms,acc_x_g,acc_y_g,acc_z_g";
  // 电脑时间留到 0.001 ms：取整到 ms 的话，脚本重算的时钟抖动会跟页面差一点
  return [head, ...raw.map((x) => `${x.dev ?? ""},${(timeOrigin + x.host).toFixed(3)},${x.ax.toFixed(6)},${x.ay.toFixed(6)},${x.az.toFixed(6)}`)].join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const STATUS_TXT: Record<StStatus, string> = { ok: "通过", warn: "注意", fail: "不通过", info: "参考" };
const STATUS_COLOR: Record<StStatus, string> = { ok: "#2e7d32", warn: "#b26a00", fail: "#c62828", info: "#555" };

export function reportHtml(r: StReport): string {
  const ch = reportCharts(r);
  const groups = [...new Set(r.items.map((i) => i.group))];
  const rows = groups.map((g) => `<tr><th colspan="3" class="g">${esc(g)}</th></tr>` + r.items.filter((i) => i.group === g).map((i) =>
    `<tr><td>${esc(i.name)}</td><td>${esc(i.value)}${i.note ? `<div class="note">${esc(i.note)}</div>` : ""}</td><td style="color:${STATUS_COLOR[i.status]};font-weight:600">${STATUS_TXT[i.status]}</td></tr>`).join("")).join("");
  const bad = r.items.filter((i) => i.status === "fail").length, warn = r.items.filter((i) => i.status === "warn").length;
  const gapsRows = r.gaps.list.slice(0, 50).map((g) => `<tr><td>${g.t.toFixed(1)}</td><td>${g.ms.toFixed(0)}</td><td>${g.missing}</td><td>${g.hostGapMs.toFixed(0)}</td></tr>`).join("");
  const started = new Date(r.meta.startedAt);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>设备自检报告 ${esc(r.meta.device)}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;background:#fff;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.6}
h1{font-size:22px;margin-bottom:4px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}
th.g{background:#f6f6f8}.note{color:#777;font-size:12px;margin-top:2px}.meta{color:#666;font-size:13px}.sum{font-size:15px;margin:12px 0}
code{background:#f3f3f3;padding:1px 4px;border-radius:3px}</style></head><body>
<h1>设备自检报告</h1>
<div class="meta">设备 <b>${esc(r.meta.device || "-")}</b>（${esc(r.meta.kind)}）· 开始 ${started.toLocaleString()} · 时长 ${(r.meta.durationS / 60).toFixed(1)} 分钟 · ${r.meta.n} 个样本 · 标称 ${r.meta.expectHz} Hz · ${r.meta.staticClaimed ? "测试时静置" : "测试时未声明静置"}</div>
<div class="sum">结论：${bad ? `<b style="color:#c62828">${bad} 项不通过</b>` : "<b style=\"color:#2e7d32\">没有不通过的项</b>"}${warn ? `，${warn} 项需要注意` : ""}</div>
<h2>结果</h2><table><tr><th>项目</th><th>结果</th><th style="width:60px">判定</th></tr>${rows}</table>
<h2>采样率（每 10 秒，按板子时间）</h2>${ch.rate}
<h2>帧间隔分布</h2>${ch.hist}<div class="note">纵轴开方显示；红色 = 离周期 ${r.rate.periodMs.toFixed(1)} ms 超过一半的（丢帧的缝 / 异常）</div>
<h2>板子时钟（板上时间 − 电脑时间，从 0 起）</h2>${ch.clock}<div class="note">每 2 秒取最早到的样本；线平 = 板子时钟准，斜率 = 快慢</div>
${r.noise.blocks.length ? `<h2>三轴每 10 秒均值的变化（相对第一块）</h2>${ch.axes}` : ""}
${r.gaps.list.length ? `<h2>丢帧的缝（前 50 处）</h2><table><tr><th>第几秒</th><th>间隔 ms</th><th>缺几个</th><th>电脑这边间隔 ms</th></tr>${gapsRows}</table>` : ""}
<h2>测法与口径</h2><ul style="font-size:13px">
<li>数据来自 0x08 原始采样镜像（PB_RAW_STREAM=1 固件），经蓝牙收到电脑。采样率、帧间隔、时钟、底噪都按<b>板子时间戳</b>算，蓝牙延迟、成批到不影响。</li>
<li>丢帧 = 板子时间戳上的缝（间隔 &gt; 1.5 个周期）。<b>分不清蓝牙丢的还是板子没发</b>：「电脑这边也卡了」只是线索。</li>
<li>板子时钟以电脑时间为准（一般有 NTP 校时）。</li>
<li>底噪 = 一阶差分估的短时噪声（去掉慢漂移）；稳定性 = 每 10 秒均值的变化。要静置平放测。</li>
</ul>
<h2>给固件的建议（分清丢帧在哪一端）</h2><ul style="font-size:13px">
<li>0x08 每个样本加一个<b>递增序号</b>（uint16 就够）：序号连续而时间戳有缝 = 时间戳问题；序号跳了 = 样本没到电脑。</li>
<li>定期（比如每 10 秒）报一帧<b>内部计数</b>：从 IMU FIFO 读出的样本数、FIFO 溢出次数、交给蓝牙的 0x08 帧数、发送队列满丢掉的帧数。跟电脑收到的个数一对，就知道丢在哪一端。</li>
<li>报一下 IMU 的 ODR 寄存器值和实际用的时钟源，方便核对采样率偏差。</li>
</ul>
<div class="note">原始数据另存为 CSV：dev_ts_ms（板子时间戳）, host_ts_ms（电脑收到的时间）, acc_x/y/z（g）。</div>
</body></html>`;
}
