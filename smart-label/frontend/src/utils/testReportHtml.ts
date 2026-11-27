import type { VersionResult } from "@/api/modelEval";
import type { Coverage, TestItem, TestSet } from "@/api/modelTests";
import type { Dog } from "@/api/dogs";
import { analyzeIouAndEdge } from "@/utils/evalMetrics";

export interface ModelArchMeta {
  /** 深度学习 / 机器学习 */
  paradigm: "深度学习" | "机器学习" | "未知架构";
  /** 具体架构名，如 1D-CNN / 随机森林 (RF) / XGBoost */
  archName: string;
  /** 组合短标签，如 深度学习 · 1D-CNN */
  shortTag: string;
  isDL: boolean;
  /** 训练输入规格，如 6轴 · 20Hz · 端侧轻量 */
  extra?: string;
}

export interface ReportEvalRow {
  key: string;
  label?: string;
  group: string;
  n: number;
  version: string;
  modelMeta?: ModelArchMeta;
  /** 该模型独立的后处理参数（置信度 / 最短时长 / 合并间隔） */
  confMin?: number;
  minDurSec?: number;
  mergeGapSec?: number;
  r: VersionResult;
}

export interface ReportErrorCase {
  verdict: "fp" | "fn" | "tp" | "tn";
  boundaryBad: boolean;
  sampleId?: number;
  seekSec?: number;
  winStartSec?: number;
  winEndSec?: number;
  dog: string;
  breed?: string;
  skinLevel?: string;
  site: string;
  size: string;
  winText: string;
  durText: string;
  truthN: number;
  predN: number;
  maxConf: number | null;
  minIou: number | null;
  truthSegs: [number, number][];
  predSegs: [number, number, number | null][];
  winDurMs: number;
  actualLabels: string[];
  tag: string;
  reason: string;
  advice: string;
}

export interface TestReportInput {
  testSet: TestSet;
  coverage?: Coverage | null;
  dogs?: Dog[];
  items: TestItem[];
  evalLabel: string;
  iouMin: number;
  edgeTolSec?: number;
  rows: ReportEvalRow[];
  allCategoryRows?: ReportEvalRow[];
  activeRow?: ReportEvalRow | null;
  errorCases: ReportErrorCase[];
  summaryCounts: {
    total: number;
    err: number;
    fp: number;
    fn: number;
    boundaryBad: number;
    tp: number;
    tn: number;
  };
  reporter?: string;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pct = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "-" : `${(v * 100).toFixed(1)}%`;

const f1 = (p: number | null | undefined, r: number | null | undefined): number | null => {
  if (p == null || r == null || p + r <= 0) return null;
  return (2 * p * r) / (p + r);
};

const fmtSec = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)}m`;
  return `${Math.round(sec)}s`;
};

/** 单个指标的 SVG 环形仪表盘 */
function renderGaugeSvg(value: number | null | undefined, color: string, label: string, sub: string): string {
  const v = value != null && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const r = 34;
  const circ = 2 * Math.PI * r;
  const dash = v != null ? (v * circ).toFixed(1) : "0";
  const txt = v != null ? `${(v * 100).toFixed(1)}%` : "-";
  return `<div class="gauge-card">
    <svg width="88" height="88" viewBox="0 0 88 88" class="gauge-svg">
      <circle cx="44" cy="44" r="${r}" fill="none" stroke="#eef2f7" stroke-width="8" />
      <circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}"
        transform="rotate(-90 44 44)" />
      <text x="44" y="48" text-anchor="middle" font-size="16" font-weight="700" fill="#0f172a">${txt}</text>
    </svg>
    <div class="gauge-label">${esc(label)}</div>
    <div class="gauge-sub">${esc(sub)}</div>
  </div>`;
}

/** 窗口判定分布 SVG 环形图（TP / TN / FP / FN） */
function renderVerdictDonutSvg(tp: number, tn: number, fp: number, fn: number): string {
  const total = Math.max(1, tp + tn + fp + fn);
  const segs = [
    { name: "命中 (TP)", n: tp, color: "#10b981" },
    { name: "正常通过 (TN)", n: tn, color: "#3b82f6" },
    { name: "误报 (FP)", n: fp, color: "#f59e0b" },
    { name: "漏报 (FN)", n: fn, color: "#ef4444" },
  ];
  const r = 46;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segs
    .filter((s) => s.n > 0)
    .map((s) => {
      const len = (s.n / total) * circ;
      const el = `<circle cx="62" cy="62" r="${r}" fill="none" stroke="${s.color}" stroke-width="14"
        stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 62 62)" />`;
      offset += len;
      return el;
    })
    .join("");
  const passRate = (((tp + tn) / total) * 100).toFixed(1);
  const legend = segs
    .map(
      (s) => `<div class="donut-leg-row">
        <span class="dot" style="background:${s.color}"></span>
        <span class="donut-leg-name">${s.name}</span>
        <b>${s.n}</b>
        <span class="muted">(${((s.n / total) * 100).toFixed(1)}%)</span>
      </div>`,
    )
    .join("");
  return `<div class="donut-wrap">
    <svg width="124" height="124" viewBox="0 0 124 124" style="flex:none">
      <circle cx="62" cy="62" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="14" />
      ${arcs}
      <text x="62" y="59" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${passRate}%</text>
      <text x="62" y="75" text-anchor="middle" font-size="11" fill="#64748b">窗口准确率</text>
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

/** 多模型 / 全类别核心指标对比 SVG 分组柱状图（宽幅无截断，带对/误/漏精简附注） */
function renderModelCompareChartSvg(
  rows: ReportEvalRow[],
  showLabel: boolean,
  edgeTolSec = 2,
  labelOnly = false,
): string {
  if (!rows.length) return "";
  const items = rows.slice(0, 10);
  const barH = 14;
  const rowGap = 16;
  const groupH = barH * 3 + 10 + rowGap;
  const topPad = 26;
  const leftPad = labelOnly ? 116 : 210;
  const rightPad = 145;
  const plotW = labelOnly ? 680 : 590;
  const svgW = leftPad + plotW + rightPad;
  const svgH = topPad + items.length * groupH + 10;

  const gridLines = [0, 25, 50, 75, 100]
    .map((p) => {
      const x = leftPad + (p / 100) * plotW;
      return `<line x1="${x}" y1="${topPad - 4}" x2="${x}" y2="${svgH - 10}" stroke="#e2e8f0" stroke-dasharray="${p === 0 ? "" : "3,3"}" />
        <text x="${x}" y="14" text-anchor="middle" font-size="11" fill="#94a3b8">${p}%</text>`;
    })
    .join("");

  const bars = items
    .map((row, idx) => {
      const y0 = topPad + idx * groupH;
      const wObj = row.r.window;
      const wf1 = wObj?.f1 ?? 0;
      const ef1 = f1(row.r.precision, row.r.recall) ?? 0;
      const b2s = row.r.within_2s_ratio ?? 0;
      const rawName = labelOnly
        ? (row.label ?? row.version)
        : showLabel && row.label
          ? `[${row.label}] ${row.version}`
          : row.version;
      const maxChars = labelOnly ? 10 : 22;
      const shortName = rawName.length > maxChars ? `${rawName.slice(0, maxChars - 1)}…` : rawName;
      const subLine = labelOnly
        ? `${wObj ? `准 ${pct(wObj.accuracy)}` : `${row.n}样本`}`
        : `${row.group} · ${row.n}样本`;
      const drawBar = (val: number, dy: number, fill: string, extra: string) => {
        const w = Math.max(3, Math.min(1, val) * plotW);
        return `<rect x="${leftPad}" y="${y0 + dy}" width="${w.toFixed(1)}" height="${barH}" rx="3.5" fill="${fill}" />
          <text x="${(leftPad + w + 6).toFixed(1)}" y="${y0 + dy + 11}" font-size="11" font-weight="700" fill="#1e293b">${(val * 100).toFixed(1)}%<tspan font-weight="400" fill="#64748b" font-size="10">${esc(extra)}</tspan></text>`;
      };
      const wExtra = wObj ? ` (${wObj.tp + wObj.tn}对/${wObj.fp}误/${wObj.fn}漏)` : "";
      const eExtra = ` (${row.r.tp}对/${row.r.fp}误/${row.r.fn}漏)`;
      const bExtra = row.r.d_start_abs_mean_ms != null && row.r.d_end_abs_mean_ms != null
        ? ` (均差 ${(row.r.d_start_abs_mean_ms / 1000).toFixed(1)}s/${(row.r.d_end_abs_mean_ms / 1000).toFixed(1)}s)`
        : "";
      return `<g>
        <text x="${leftPad - 12}" y="${y0 + 21}" text-anchor="end" font-size="13" font-weight="700" fill="#0f172a">${esc(shortName)}</text>
        <text x="${leftPad - 12}" y="${y0 + 37}" text-anchor="end" font-size="10.5" fill="#64748b">${esc(subLine)}</text>
        ${drawBar(wf1, 0, "#2563eb", wExtra)}
        ${drawBar(ef1, barH + 4, "#7c3aed", eExtra)}
        ${drawBar(b2s, (barH + 4) * 2, "#0d9488", bExtra)}
      </g>`;
    })
    .join("");

  return `<div class="chart-box" style="margin-bottom:0">
    <div class="chart-head">
      <span class="chart-title">核心指标横向对比（%）</span>
      <span class="chart-legend">
        <span><i class="dot" style="background:#2563eb"></i>窗口级 F1</span>
        <span><i class="dot" style="background:#7c3aed"></i>事件级 F1</span>
        <span><i class="dot" style="background:#0d9488"></i>±${edgeTolSec}s 起止对齐</span>
      </span>
    </div>
    <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" style="display:block">
      ${gridLines}
      ${bars}
    </svg>
  </div>`;
}

/** 单个窗口双轨迷你时间轴 SVG */
function renderMiniTimelineSvg(c: ReportErrorCase): string {
  const dur = Math.max(1, c.winDurMs);
  const segRects = (segs: [number, number, ...unknown[]][], y: number, fill: string) =>
    segs
      .map(([s, e]) => {
        const x = Math.max(0, Math.min(100, (s / dur) * 100));
        const w = Math.max(2, Math.min(100 - x, ((e - s) / dur) * 100));
        return `<rect x="${x.toFixed(2)}%" y="${y}" width="${w.toFixed(2)}%" height="6" rx="2" fill="${fill}" />`;
      })
      .join("");
  const predColor = c.verdict === "fp" ? "#f59e0b" : "#3b82f6";
  return `<svg width="100%" height="20" style="display:block;min-width:120px">
    <rect x="0" y="2" width="100%" height="6" rx="2" fill="#e2e8f0" />
    ${segRects(c.truthSegs, 2, "#10b981")}
    <rect x="0" y="12" width="100%" height="6" rx="2" fill="#e2e8f0" />
    ${segRects(c.predSegs, 12, predColor)}
  </svg>`;
}

/** 生成独立可离线打开、可打印 PDF、也可分享链接的标准 QA 测试报告 HTML */
export function buildTestReportHtml(input: TestReportInput): string {
  const {
    testSet, coverage, dogs, items, evalLabel, iouMin, edgeTolSec = 2, rows, allCategoryRows, activeRow, errorCases, summaryCounts, reporter,
  } = input;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateCompact = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const genTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const reportCode = `TR-${dateCompact}-S${testSet.id}`;
  const iouPct = Math.round(iouMin * 100);
  const labelTitle = evalLabel === "ALL" ? "全部类别" : evalLabel;
  const primary = activeRow ?? rows[0] ?? null;
  const pw = primary?.r.window;
  const pr = primary?.r;
  const evF1 = f1(pr?.precision, pr?.recall);

  const nChecked = items.filter((i) => i.checked).length;
  const nTotal = items.length || testSet.n_items;
  const totalSec = coverage?.total_sec ?? items.reduce((s, x) => s + (x.dur_sec || 0), 0);
  const nDogs = coverage?.n_dogs ?? new Set(items.map((x) => x.dog_id).filter(Boolean)).size;
  const sitesTxt = Object.entries(coverage?.sites ?? {}).map(([k, v]) => `${k}(${v}段)`).join("、") || "-";

  // 客观 5 档评级标准（透明展示区间，不搞笼统自夸；窗口级与事件级分别定级）
  const gradeOf = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return { code: "-", name: "无数据", cls: "badge-warn", color: "#64748b" };
    if (v >= 0.95) return { code: "S", name: "卓越", cls: "badge-epic", color: "#7c3aed" };
    if (v >= 0.85) return { code: "A", name: "优秀", cls: "badge-pass", color: "#10b981" };
    if (v >= 0.75) return { code: "B", name: "良好", cls: "badge-info", color: "#2563eb" };
    if (v >= 0.6) return { code: "C", name: "一般", cls: "badge-warn", color: "#d97706" };
    return { code: "D", name: "不达标", cls: "badge-fail", color: "#dc2626" };
  };
  const winGrade = gradeOf(pw?.f1);
  const evGrade = gradeOf(evF1);
  const rubricTiers = [
    { code: "D", name: "不达标", range: "< 60%", bar: "#ef4444", grad: "linear-gradient(135deg,#dc2626,#ef4444)", desc: "不可上线，需重点排查" },
    { code: "C", name: "一般", range: "60% ~ 75%", bar: "#f59e0b", grad: "linear-gradient(135deg,#d97706,#f59e0b)", desc: "偏弱，需针对性优化" },
    { code: "B", name: "良好", range: "75% ~ 85%", bar: "#3b82f6", grad: "linear-gradient(135deg,#2563eb,#3b82f6)", desc: "基本可用，仍有提升空间" },
    { code: "A", name: "优秀", range: "85% ~ 95%", bar: "#10b981", grad: "linear-gradient(135deg,#059669,#10b981)", desc: "达到上线交付标准" },
    { code: "S", name: "卓越", range: "≥ 95%", bar: "#8b5cf6", grad: "linear-gradient(135deg,#6d28d9,#a855f7)", desc: "标杆级表现" },
  ];
  // 将 0~100% 映射到 5 段等宽刻度尺（每段占 20% 视觉宽度，避免 60~100% 挤在最右边）
  const scoreToBarPct = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    const x = Math.max(0, Math.min(1, v));
    if (x < 0.6) return (x / 0.6) * 20;
    if (x < 0.75) return 20 + ((x - 0.6) / 0.15) * 20;
    if (x < 0.85) return 40 + ((x - 0.75) / 0.1) * 20;
    if (x < 0.95) return 60 + ((x - 0.85) / 0.1) * 20;
    return 80 + ((x - 0.95) / 0.05) * 20;
  };
  const winPos = scoreToBarPct(pw?.f1);
  const evPos = scoreToBarPct(evF1);
  const rubricHtml = `<div class="rubric-box">
    <div class="rubric-hd">
      <b>客观评级标准（按 F1 分数划档）</b>
      <span class="muted">窗口 F1 <b style="color:#2563eb">${pct(pw?.f1)}（${winGrade.code}·${winGrade.name}）</b> · 事件 F1 <b style="color:#7c3aed">${pct(evF1)}（${evGrade.code}·${evGrade.name}）</b></span>
    </div>
    <div class="rubric-track-wrap">
      ${winPos != null ? `<div class="rubric-pin pin-top" style="left:${Math.max(5, Math.min(95, winPos)).toFixed(1)}%;background:#2563eb">窗口 ${pct(pw?.f1)}</div>` : ""}
      <div class="rubric-spectrum">
        ${rubricTiers.map((t) => `<div style="flex:1;background:${t.grad}"></div>`).join("")}
      </div>
      ${evPos != null ? `<div class="rubric-pin pin-bot" style="left:${Math.max(5, Math.min(95, evPos)).toFixed(1)}%;background:#7c3aed">事件 ${pct(evF1)}</div>` : ""}
    </div>
    <div class="rubric-grid">
      ${rubricTiers
        .map((t) => {
          const hitW = winGrade.code === t.code;
          const hitE = evGrade.code === t.code;
          const hit = hitW || hitE;
          const tags = [
            hitW ? `<span class="r-pin" style="background:rgba(37,99,235,0.92)">● 窗口</span>` : "",
            hitE ? `<span class="r-pin" style="background:rgba(124,58,237,0.92)">● 事件</span>` : "",
          ].filter(Boolean).join("");
          return `<div class="rubric-cell${hit ? " hit" : ""}" style="${hit ? `background:${t.grad};color:#fff;` : `border-top:3px solid ${t.bar};`}">
            <div class="r-top"><b>${t.code} · ${t.name}</b><span>${t.range}</span></div>
            <div class="r-desc">${t.desc}</div>
            ${tags ? `<div class="r-pins">${tags}</div>` : ""}
          </div>`;
        })
        .join("")}
    </div>
  </div>`;

  // 归因统计（只统计误报/漏报/边界超差，用于横向条形图与建议）
  const reasonMap = new Map<string, { kind: "fp" | "fn" | "bd"; tag: string; n: number; advice: string }>();
  for (const c of errorCases) {
    if (c.verdict !== "fp" && c.verdict !== "fn" && !c.boundaryBad) continue;
    const kind: "fp" | "fn" | "bd" = c.verdict === "fp" ? "fp" : c.verdict === "fn" ? "fn" : "bd";
    const key = `${kind}::${c.tag}`;
    const prev = reasonMap.get(key);
    if (prev) prev.n += 1;
    else reasonMap.set(key, { kind, tag: c.tag, n: 1, advice: c.advice });
  }
  const reasonsSorted = [...reasonMap.values()].sort((a, b) => b.n - a.n);
  const maxReasonN = Math.max(1, ...reasonsSorted.map((x) => x.n));

  const reasonBarsHtml = reasonsSorted.length
    ? reasonsSorted
        .map((r) => {
          const bw = Math.max(6, Math.round((r.n / maxReasonN) * 100));
          const color = r.kind === "fn" ? "#ef4444" : r.kind === "fp" ? "#f59e0b" : "#8b5cf6";
          const tagLabel = r.kind === "fn" ? "漏报" : r.kind === "fp" ? "误报" : "边界";
          return `<div class="bar-row">
            <span class="pill ${r.kind === "fn" ? "pill-red" : r.kind === "fp" ? "pill-orange" : "pill-purple"}" style="width:42px;text-align:center">${tagLabel}</span>
            <span class="bar-name-wide">${esc(r.tag)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${bw}%;background:${color}"></div></div>
            <span class="bar-val-sm"><b>${r.n}</b> 段</span>
          </div>`;
        })
        .join("")
    : `<div class="empty-tip">当前模型无错例记录，全部窗口均判定正确。</div>`;

  // 自动提炼 3 条精简测试结论与建议
  const takeaways: string[] = [];
  if (primary && pw && pr) {
    takeaways.push(
      `<strong>整体表现：</strong>主测模型 <b>${esc(primary.version)}</b>（${esc(primary.group)}）在「${esc(labelTitle)}」上的窗口级准确率 <b>${pct(pw.accuracy)}</b>（F1 <b>${pct(pw.f1)}</b>），事件级（IoU ≥ ${iouPct}%）F1 <b>${pct(evF1)}</b>，命中边界 ±2s 对齐率 <b>${pct(pr.within_2s_ratio)}</b>。`,
    );
  }
  if (reasonsSorted.length > 0) {
    const top2 = reasonsSorted.slice(0, 2).map((x) => `「${x.tag}」(${x.n}段)`).join("、");
    takeaways.push(`<strong>主要失误点：</strong>共 ${summaryCounts.err} 个错误窗口（误报 ${summaryCounts.fp} / 漏报 ${summaryCounts.fn}），最集中于 ${esc(top2)}。`);
    const topAdvice = reasonsSorted.find((x) => x.advice)?.advice;
    if (topAdvice) {
      takeaways.push(`<strong>优化建议：</strong>${esc(topAdvice)}`);
    }
  } else {
    takeaways.push(`<strong>主要失误点：</strong>全部 ${summaryCounts.total} 个测试窗口零误报、零漏报。`);
  }

  const renderArchBadge = (m?: ModelArchMeta, withExtra = true): string => {
    if (!m) return "";
    const cls = m.isDL ? "pill-purple" : m.paradigm === "机器学习" ? "pill-green" : "pill-gray";
    const extraHtml = withExtra && m.extra ? ` <span class="pill pill-gray">${esc(m.extra)}</span>` : "";
    return `<span class="pill ${cls}">${esc(m.shortTag)}</span>${extraHtml}`;
  };

  // 多模型对比表
  const showLabelCol = evalLabel === "ALL";
  const rowsHtml = rows
    .map((x) => {
      const w = x.r.window;
      const eF1 = f1(x.r.precision, x.r.recall);
      const isAct = primary && x.key === primary.key;
      const errDiff =
        x.r.d_start_abs_mean_ms != null && x.r.d_end_abs_mean_ms != null
          ? `${(x.r.d_start_abs_mean_ms / 1000).toFixed(1)}s / ${(x.r.d_end_abs_mean_ms / 1000).toFixed(1)}s`
          : "-";
      return `<tr class="${isAct ? "row-primary" : ""}">
        ${showLabelCol ? `<td><span class="pill pill-gray">${esc(x.label ?? "-")}</span></td>` : ""}
        <td>${esc(x.group)}</td>
        <td class="mono-sm"><div><b>${esc(x.version)}</b></div>${x.modelMeta || (x.confMin && x.confMin > 0) || (x.minDurSec && x.minDurSec > 0) || (x.mergeGapSec && x.mergeGapSec > 0) ? `<div style="margin-top:3px">${renderArchBadge(x.modelMeta)}${x.confMin && x.confMin > 0 ? ` <span class="pill pill-gray">置信≥${Math.round(x.confMin * 100)}%</span>` : ""}${x.minDurSec && x.minDurSec > 0 ? ` <span class="pill pill-gray">时长≥${x.minDurSec}s</span>` : ""}${x.mergeGapSec && x.mergeGapSec > 0 ? ` <span class="pill pill-gray">合并≤${x.mergeGapSec}s</span>` : ""}</div>` : ""}</td>
        <td class="col-w">${w ? pct(w.accuracy) : "-"}</td>
        <td class="col-w">${w ? pct(w.precision) : "-"}</td>
        <td class="col-w">${w ? pct(w.recall) : "-"}</td>
        <td class="col-w"><b>${w ? pct(w.f1) : "-"}</b></td>
        <td class="col-w">${w ? `<span class="c-green">${w.tp + w.tn}</span>/<span class="c-orange">${w.fp}</span>/<span class="c-red">${w.fn}</span>` : "-"}</td>
        <td class="col-e">${pct(x.r.precision)}</td>
        <td class="col-e">${pct(x.r.recall)}</td>
        <td class="col-e"><b>${pct(eF1)}</b></td>
        <td class="col-e"><span class="c-green">${x.r.tp}</span>/<span class="c-orange">${x.r.fp}</span>/<span class="c-red">${x.r.fn}</span></td>
        <td class="col-b">${pct(x.r.mean_iou)}</td>
        <td class="col-b"><b>${pct(x.r.within_2s_ratio)}</b></td>
        <td class="col-b">${errDiff}</td>
      </tr>`;
    })
    .join("");

  // 受试犬只画像映射（品种 / 体型 / 当前皮肤状态）
  const dogById = new Map<number, Dog>();
  const dogByName = new Map<string, Dog>();
  (dogs ?? []).forEach((d) => {
    dogById.set(d.id, d);
    if (d.name) dogByName.set(d.name, d);
  });
  const skinPill = (lv: string | null | undefined): string => {
    const s = (lv || "").trim();
    if (!s) return `<span class="pill pill-gray">皮肤未登记</span>`;
    if (s === "正常") return `<span class="pill pill-green">皮肤正常</span>`;
    if (s === "轻度") return `<span class="pill pill-orange">轻度瘙痒</span>`;
    if (s === "中度") return `<span class="pill pill-orange">中度瘙痒</span>`;
    if (s === "重度") return `<span class="pill pill-red">重度瘙痒</span>`;
    return `<span class="pill pill-gray">${esc(s)}</span>`;
  };
  const sizeLabel = (sz: string | null | undefined): string =>
    sz === "大" ? "大型犬" : sz === "中" ? "中型犬" : sz === "小" ? "小型犬" : sz ? `${sz}型` : "体型未知";

  // 犬只分布（突出品种、体型、皮肤状态，而非只写代号名字）
  const dogsArr = [...(coverage?.dogs ?? [])].sort((a, b) => b.share - a.share);
  const maxShare = Math.max(0.2, ...dogsArr.map((d) => d.share));
  const sizeCount = new Map<string, number>();
  const skinCount = new Map<string, number>();
  const dogsHtml = dogsArr
    .map((d) => {
      const info = (d.dog ? dogByName.get(d.dog) : undefined)
        ?? (() => {
          const matchedItem = items.find((it) => it.dog_name === d.dog && it.dog_id != null);
          return matchedItem?.dog_id != null ? dogById.get(matchedItem.dog_id) : undefined;
        })();
      const breed = info?.breed?.trim() || "品种未登记";
      const sz = sizeLabel(info?.size);
      const skin = info?.skin_level || info?.intake_skin_level || "";
      sizeCount.set(sz, (sizeCount.get(sz) ?? 0) + 1);
      skinCount.set(skin || "未登记", (skinCount.get(skin || "未登记") ?? 0) + 1);
      const bw = Math.max(4, Math.round((d.share / maxShare) * 100));
      return `<div class="dog-row">
        <div class="dog-meta">
          <b>${esc(breed)}</b>
          <span class="pill pill-gray">${esc(sz)}</span>
          ${skinPill(skin)}
          ${d.dog ? `<span class="muted">(${esc(d.dog)})</span>` : ""}
        </div>
        <div class="dog-bar-line">
          <div class="bar-track"><div class="bar-fill" style="width:${bw}%;background:${d.share > 0.25 ? "#f59e0b" : "#3b82f6"}"></div></div>
          <span class="bar-val">${(d.share * 100).toFixed(1)}% · ${fmtSec(d.sec)}</span>
        </div>
      </div>`;
    })
    .join("");
  const dogSummaryHtml = dogsArr.length
    ? `<div class="dog-summary-bar" style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:10px;padding:7px 10px;background:#f8fafc;border-radius:6px;font-size:11.5px;color:#475569">
        <span><b>体型覆盖：</b>${[...sizeCount.entries()].map(([k, n]) => `${k} ${n}只`).join(" · ")}</span>
        <span><b>皮肤状态：</b>${[...skinCount.entries()].map(([k, n]) => `${k} ${n}只`).join(" · ")}</span>
      </div>`
    : "";

  // 时长正负例分布
  const durEntries = Object.entries(coverage?.by_dur ?? {});
  const maxDur = Math.max(1, ...durEntries.map(([, m]) => (m["有抓挠"] ?? 0) + (m["无抓挠"] ?? 0)));
  const durHtml = durEntries
    .map(([dur, m]) => {
      const y = m["有抓挠"] ?? 0;
      const n = m["无抓挠"] ?? 0;
      const tot = y + n;
      const wPct = Math.max(8, Math.round((tot / maxDur) * 100));
      const yPct = tot > 0 ? Math.round((y / tot) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-name">${esc(dur)}</span>
        <div class="bar-track">
          <div style="width:${wPct}%;height:100%;display:flex;border-radius:4px;overflow:hidden">
            ${y > 0 ? `<div style="width:${yPct}%;background:#10b981;color:#fff;font-size:10px;text-align:center;line-height:16px">${y}</div>` : ""}
            ${n > 0 ? `<div style="width:${100 - yPct}%;background:#64748b;color:#fff;font-size:10px;text-align:center;line-height:16px">${n}</div>` : ""}
          </div>
        </div>
        <span class="bar-val">共 ${tot} 段</span>
      </div>`;
    })
    .join("");

  // 窗口明细（排序：漏报 → 误报 → 边界偏差 → 命中 → 正常通过）
  const sortedCases = [...errorCases].sort((a, b) => {
    const rank = (x: ReportErrorCase) =>
      x.verdict === "fn" ? 0 : x.verdict === "fp" ? 1 : x.boundaryBad ? 2 : x.verdict === "tp" ? 3 : 4;
    return rank(a) - rank(b);
  });
  const caseRowsHtml = sortedCases
    .map((c, idx) => {
      const kind = c.verdict === "fp" ? "fp" : c.verdict === "fn" ? "fn" : c.verdict === "tp" ? "tp" : "tn";
      const badge =
        c.verdict === "fp"
          ? `<span class="pill pill-orange">误报</span>`
          : c.verdict === "fn"
            ? `<span class="pill pill-red">漏报</span>`
            : c.verdict === "tp"
              ? c.boundaryBad
                ? `<span class="pill pill-purple">偏差&gt;${edgeTolSec}s</span>`
                : `<span class="pill pill-green">命中</span>`
              : `<span class="pill pill-gray">正常通过</span>`;
      const tagCls =
        c.verdict === "fn"
          ? "pill-red"
          : c.verdict === "fp"
            ? "pill-orange"
            : c.boundaryBad
              ? "pill-purple"
              : c.verdict === "tp"
                ? "pill-green"
                : "pill-gray";
      const labelsHtml = c.actualLabels.length
        ? c.actualLabels.slice(0, 3).map((lb) => `<span class="pill pill-gray">${esc(lb)}</span>`).join("")
        : `<span class="muted">无标注</span>`;
      const videoTitle = `${c.breed || c.dog}${c.size ? `(${c.size}型)` : ""} · ${c.winText} · ${c.tag}`;
      const tSegJson = JSON.stringify(c.truthSegs);
      const pSegJson = JSON.stringify(c.predSegs.map(([s, e]) => [s, e]));
      const videoBtn = c.sampleId
        ? `<button class="btn-play" data-sid="${c.sampleId}" data-seek="${(c.seekSec ?? c.winStartSec ?? 0).toFixed(2)}" data-ws="${(c.winStartSec ?? 0).toFixed(2)}" data-we="${(c.winEndSec ?? 0).toFixed(2)}" data-verdict="${c.verdict}" data-tseg="${esc(tSegJson)}" data-pseg="${esc(pSegJson)}" data-title="${esc(videoTitle)}" data-reason="${esc(c.reason || "")}">▶ 看视频</button>`
        : `<span class="muted">-</span>`;
      return `<tr class="case-row" data-kind="${kind}" data-bd="${c.boundaryBad ? "1" : "0"}" data-idx="${idx}">
        <td class="muted">${idx + 1}</td>
        <td>${badge}</td>
        <td>
          <b>${esc(c.breed || c.dog)}</b>${c.size ? `<span class="muted">(${esc(c.size)}型)</span>` : ""}
          ${c.skinLevel ? `<div>${skinPill(c.skinLevel)}</div>` : ""}
          <div class="sub">${c.breed && c.dog ? `${esc(c.dog)} · ` : ""}${esc(c.site)}</div>
        </td>
        <td class="mono-sm">${esc(c.winText)}<div class="sub">${esc(c.durText)}</div></td>
        <td>
          ${renderMiniTimelineSvg(c)}
          <div class="sub">标 ${c.truthN} / 预 ${c.predN}${c.maxConf != null ? ` · 置信 ${c.maxConf}` : ""}${c.minIou != null ? ` · IoU ${(c.minIou * 100).toFixed(0)}%` : ""}</div>
        </td>
        <td>
          <span class="pill ${tagCls}">${esc(c.tag)}</span>
          ${c.reason ? `<div class="sub" style="margin-top:2px;color:#334155">${esc(c.reason)}</div>` : ""}
        </td>
        <td>${labelsHtml}</td>
        <td style="text-align:center">${videoBtn}</td>
      </tr>`;
    })
    .join("");

  const iouAnalysis = primary?.r.window_details?.length
    ? analyzeIouAndEdge(primary.r.window_details, iouMin)
    : null;
  const iouPanelHtml = iouAnalysis
    ? (() => {
        const maxC = Math.max(1, ...iouAnalysis.buckets.map((b) => b.count));
        const bucketBars = iouAnalysis.buckets
          .map((b) => {
            const passed = b.min >= iouMin - 1e-6;
            const bw = b.count ? Math.max(4, Math.round((b.count / maxC) * 100)) : 0;
            return `<div class="bar-row">
              <span class="bar-name">${b.label}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${bw}%;background:${b.color};opacity:${passed ? 1 : 0.4}"></div></div>
              <span class="bar-val-sm" style="color:${passed ? "#16a34a" : "#64748b"}"><b>${b.count}</b> 对${passed ? " ✓" : ""}</span>
            </div>`;
          })
          .join("");
        const sweepRows = iouAnalysis.iouSweep
          .map((s) => {
            const cur = Math.abs(s.iou - iouMin) < 0.001;
            return `<tr style="${cur ? "background:#f5f3ff;font-weight:700" : ""}">
              <td>IoU ≥ ${Math.round(s.iou * 100)}%${cur ? " (当前)" : ""}</td>
              <td>${pct(s.precision)}</td>
              <td>${pct(s.recall)}</td>
              <td style="color:#6d28d9"><b>${pct(s.f1)}</b></td>
              <td>${s.tp} / ${s.fp} / ${s.fn}</td>
            </tr>`;
          })
          .join("");
        const edgeTags = iouAnalysis.edgeSweep
          .map((e) => `<span class="pill ${e.tolSec === edgeTolSec ? "pill-green" : "pill-gray"}">±${e.tolSec}s：${e.ratio != null ? pct(e.ratio) : "-"}</span>`)
          .join(" ");
        return `<div class="two-col" style="margin-top:14px;padding-top:14px;border-top:1px dashed #e2e8f0">
          <div>
            <div class="chart-title" style="margin-bottom:8px">重叠度 (IoU) 整体分布（有重叠 ${iouAnalysis.totalOverlapped} 对 / 人工 ${iouAnalysis.totalTruth} 次 / 预测 ${iouAnalysis.totalPred} 次）</div>
            ${bucketBars}
          </div>
          <div>
            <div class="chart-title" style="margin-bottom:8px">不同 IoU 门槛下的事件级表现对比</div>
            <table>
              <thead><tr><th>IoU 门槛</th><th>精确率</th><th>召回率</th><th>事件 F1</th><th>对/误/漏</th></tr></thead>
              <tbody>${sweepRows}</tbody>
            </table>
            <div style="margin-top:8px;font-size:12px;color:#475569">当前 IoU 下不同起止容差对齐率：${edgeTags}</div>
          </div>
        </div>`;
      })()
    : "";

  // 全类别总览（仅保留清晰宽幅可视化柱状图，去掉重复冗余表格）
  const distinctCats = new Set((allCategoryRows ?? []).map((x) => x.label).filter(Boolean));
  const distinctModels = new Set((allCategoryRows ?? []).map((x) => x.version));
  const showAllCatSection = evalLabel !== "ALL" && distinctCats.size > 1 && (allCategoryRows?.length ?? 0) > 0;
  const secNumAllCat = showAllCatSection ? "四" : "";
  const secNumCov = showAllCatSection ? "五" : "四";
  const secNumCases = showAllCatSection ? "六" : "五";
  const tocItems: { id: string; label: string; sub?: string }[] = [
    { id: "sec-overview", label: "一、测试概况与范围" },
    { id: "sec-kpi", label: "二、核心指标总览", sub: pw ? `准确率 ${pct(pw.accuracy)}` : undefined },
    { id: "sec-compare", label: "三、模型评测指标对比", sub: `IoU ≥ ${iouPct}%` },
    ...(showAllCatSection ? [{ id: "sec-allcat", label: `${secNumAllCat}、全类别综合表现`, sub: `${distinctCats.size} 类` }] : []),
    { id: "sec-coverage", label: `${secNumCov}、测试集数据分布`, sub: `${nDogs} 只犬` },
    { id: "sec-cases", label: `${secNumCases}、错例归因与明细`, sub: `${summaryCounts.err} 错例` },
  ];
  const tocHtml = tocItems
    .map(
      (it, i) => `<a class="toc-link${i === 0 ? " active" : ""}" href="#${it.id}" data-target="${it.id}">
        <span class="toc-text">${esc(it.label)}</span>
        ${it.sub ? `<span class="toc-sub">${esc(it.sub)}</span>` : ""}
      </a>`,
    )
    .join("");

  const allCatSectionHtml = showAllCatSection
    ? `<div class="card" id="sec-allcat">
        <div class="sec-hd">
          <h2>${secNumAllCat}、全类别综合表现总览（${[...distinctCats].join(" / ")}）</h2>
          <span class="sub">${distinctModels.size === 1 ? `模型：${esc([...distinctModels][0])} · ` : ""}IoU ≥ ${iouPct}% · 容差 ±${edgeTolSec}s</span>
        </div>
        ${renderModelCompareChartSvg(allCategoryRows ?? [], true, edgeTolSec, distinctModels.size === 1)}
      </div>`
    : "";

  const sc = summaryCounts;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>算法测试报告 · ${esc(testSet.name)} · ${esc(labelTitle)}</title>
<style>
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; padding: 24px 16px 48px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    background: #f1f5f9; color: #0f172a; font-size: 13px; line-height: 1.55;
  }
  .layout { max-width: 1400px; margin: 0 auto; display: flex; gap: 22px; align-items: flex-start; }
  .toc-aside {
    width: 248px; flex: none; position: sticky; top: 20px;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
    padding: 16px 14px; box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  }
  .toc-title { font-size: 13.5px; font-weight: 700; color: #0f172a; margin-bottom: 2px; padding: 0 6px; }
  .toc-code { font-size: 11px; color: #94a3b8; margin-bottom: 12px; padding: 0 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .toc-nav { display: flex; flex-direction: column; gap: 5px; }
  .toc-link {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 8px 10px; border-radius: 7px; text-decoration: none;
    color: #334155; font-size: 13px; line-height: 1.35; border-left: 3px solid transparent; transition: all .15s;
  }
  .toc-link:hover { background: #f8fafc; color: #0f172a; }
  .toc-link.active { background: #eef2ff; color: #4338ca; font-weight: 600; border-left-color: #4f46e5; }
  .toc-text { white-space: normal; word-break: keep-all; }
  .toc-sub { font-size: 11px; color: #64748b; padding-left: 16px; }
  .toc-link.active .toc-sub { color: #6366f1; }
  .toc-foot {
    margin-top: 12px; padding-top: 10px; border-top: 1px solid #f1f5f9;
    display: flex; flex-direction: column; gap: 6px;
  }
  .toc-btn {
    width: 100%; padding: 6px 8px; border-radius: 6px; font-size: 12px; cursor: pointer;
    border: 1px solid #e2e8f0; background: #f8fafc; color: #334155; text-align: center; text-decoration: none;
  }
  .toc-btn:hover { background: #e2e8f0; }
  .page { flex: 1; min-width: 0; max-width: 1120px; }
  .card { scroll-margin-top: 18px; }

  /* 顶部标准报告头 */
  .banner {
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #312e81 100%);
    color: #fff; border-radius: 12px; padding: 22px 26px; margin-bottom: 16px;
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;
  }
  .banner-tag { font-size: 11px; letter-spacing: 1px; color: #a5b4fc; text-transform: uppercase; margin-bottom: 4px; }
  .banner h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
  .banner-sub { font-size: 12px; color: rgba(255,255,255,0.78); }
  .banner-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .verdict-badge { padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; }
  .badge-epic { background: rgba(168,85,247,0.24); color: #e9d5ff; border: 1px solid rgba(168,85,247,0.55); }
  .badge-pass { background: rgba(16,185,129,0.2); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.45); }
  .badge-info { background: rgba(59,130,246,0.22); color: #93c5fd; border: 1px solid rgba(59,130,246,0.45); }
  .badge-warn { background: rgba(245,158,11,0.2); color: #fcd34d; border: 1px solid rgba(245,158,11,0.45); }
  .badge-fail { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid rgba(239,68,68,0.45); }

  /* 三指标图解（静态/动画/交互一体） */
  .edu-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
  .edu-card {
    border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 13px; background: #fff;
    display: flex; flex-direction: column; gap: 8px;
  }
  .edu-card.c-win { border-top: 3px solid #2563eb; }
  .edu-card.c-evt { border-top: 3px solid #7c3aed; }
  .edu-card.c-edg { border-top: 3px solid #0d9488; }
  .edu-hd { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 13px; font-weight: 700; }
  .edu-tag { font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px; }
  .edu-vis { background: #f8fafc; border: 1px solid #eef2f7; border-radius: 8px; padding: 8px 10px; }
  .edu-desc { font-size: 11.5px; color: #475569; line-height: 1.5; }
  .edu-ctrl { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; font-size: 11px; color: #475569; margin-top: 6px; }
  .edu-slider { flex: 1; min-width: 90px; accent-color: #7c3aed; cursor: pointer; }
  .edu-pbtn {
    border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 5px;
    padding: 2px 7px; font-size: 10.5px; cursor: pointer;
  }
  .edu-pbtn.active { background: #0d9488; border-color: #0d9488; color: #fff; font-weight: 600; }
  .edu-wbtn {
    border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 5px;
    padding: 2px 6px; font-size: 10.5px; cursor: pointer;
  }
  .edu-wbtn.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
  .edu-status { font-size: 11.5px; font-weight: 700; margin-top: 5px; display: flex; align-items: center; justify-content: space-between; }
  @keyframes scanMove {
    0% { transform: translateX(0); }
    100% { transform: translateX(232px); }
  }
  .scan-line { animation: scanMove 3.6s linear infinite; }
  @media (max-width: 960px) {
    .edu-grid { grid-template-columns: 1fr; }
  }

  /* 客观 5 档渐变刻度尺 */
  .rubric-box { margin-bottom: 14px; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; }
  .rubric-hd { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12.5px; margin-bottom: 6px; color: #0f172a; }
  .rubric-track-wrap { position: relative; padding: 26px 0 26px; margin: 2px 0 10px; }
  .rubric-spectrum {
    height: 12px; border-radius: 999px; overflow: hidden; display: flex; gap: 3px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.12);
  }
  .rubric-pin {
    position: absolute; transform: translateX(-50%); color: #fff; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 999px; white-space: nowrap; box-shadow: 0 2px 6px rgba(15,23,42,0.22);
  }
  .rubric-pin.pin-top { top: 0; }
  .rubric-pin.pin-top::after {
    content: ""; position: absolute; left: 50%; bottom: -5px; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: #2563eb; border-bottom: 0;
  }
  .rubric-pin.pin-bot { bottom: 0; }
  .rubric-pin.pin-bot::after {
    content: ""; position: absolute; left: 50%; top: -5px; transform: translateX(-50%);
    border: 5px solid transparent; border-bottom-color: #7c3aed; border-top: 0;
  }
  .rubric-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .rubric-cell {
    border-radius: 8px; padding: 8px 10px; font-size: 11.5px;
    background: #f8fafc; color: #64748b; border: 1px solid #e2e8f0; opacity: 0.7;
  }
  .rubric-cell.hit {
    opacity: 1; border: none; transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(15,23,42,0.16);
  }
  .r-top { display: flex; justify-content: space-between; align-items: center; gap: 4px; font-size: 12.5px; }
  .r-desc { font-size: 11px; opacity: 0.9; margin-top: 3px; }
  .r-pins { display: flex; gap: 5px; margin-top: 6px; }
  .r-pin { color: #fff; font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.45); }
  .btn-print {
    background: rgba(255,255,255,0.14); color: #fff; border: 1px solid rgba(255,255,255,0.28);
    border-radius: 7px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  }
  .btn-print:hover { background: rgba(255,255,255,0.24); }

  /* 章节卡片 */
  .card {
    background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
    padding: 18px 20px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(15,23,42,0.03);
  }
  .sec-hd {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; margin: 0 0 14px;
  }
  .sec-hd h2 { margin: 0; font-size: 15px; font-weight: 700; color: #0f172a; }
  .sec-hd .sub { font-size: 12px; color: #64748b; }

  /* 一、测试概况 4 列信息网格 */
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 18px; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-k { font-size: 11.5px; color: #64748b; }
  .meta-v { font-size: 13px; font-weight: 600; color: #1e293b; }

  /* 二、核心可视化（4 仪表盘 + 环形图 + 混淆矩阵） */
  .gauges-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .gauge-card {
    border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 10px;
    background: #f8fafc; text-align: center;
  }
  .gauge-svg { display: block; margin: 0 auto 4px; }
  .gauge-label { font-size: 13px; font-weight: 700; color: #1e293b; }
  .gauge-sub { font-size: 11px; color: #64748b; margin-top: 2px; }

  .vis-two { display: grid; grid-template-columns: 1.05fr 1fr; gap: 16px; align-items: center; }
  .donut-wrap { display: flex; align-items: center; gap: 20px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; }
  .donut-legend { display: flex; flex-direction: column; gap: 7px; font-size: 12.5px; flex: 1; }
  .donut-leg-row { display: flex; align-items: center; gap: 6px; }
  .donut-leg-name { flex: 1; color: #334155; }

  /* 2x2 混淆矩阵 */
  .cm-box { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; background: #f8fafc; }
  .cm-title { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 8px; }
  .cm-grid { display: grid; grid-template-columns: 64px 1fr 1fr; gap: 6px; text-align: center; font-size: 12px; }
  .cm-hd { font-size: 11px; color: #64748b; display: flex; align-items: center; justify-content: center; font-weight: 600; }
  .cm-cell { border-radius: 7px; padding: 8px 6px; }
  .cm-cell b { display: block; font-size: 18px; line-height: 1.2; }
  .cm-cell span { font-size: 11px; opacity: 0.85; }
  .cm-tp { background: #dcfce7; color: #166534; }
  .cm-fn { background: #fee2e2; color: #991b1b; }
  .cm-fp { background: #fef3c7; color: #92400e; }
  .cm-tn { background: #dbeafe; color: #1e40af; }

  /* 结论摘要框 */
  .takeaways {
    margin-top: 14px; padding: 12px 16px; border-radius: 8px;
    background: #eef2ff; border-left: 4px solid #4f46e5; font-size: 13px;
  }
  .takeaways div { margin: 4px 0; color: #1e293b; }

  /* SVG 分组柱状图 */
  .chart-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; }
  .chart-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .chart-title { font-size: 12.5px; font-weight: 700; color: #334155; }
  .chart-legend { display: flex; gap: 14px; font-size: 11.5px; color: #475569; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

  /* 表格 */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 7px 8px; border: 1px solid #e2e8f0; text-align: left; vertical-align: middle; }
  th { background: #f8fafc; font-weight: 600; color: #334155; white-space: nowrap; }
  .th-w { background: #eff6ff; color: #1d4ed8; text-align: center; }
  .th-e { background: #f5f3ff; color: #6d28d9; text-align: center; }
  .th-b { background: #f0fdfa; color: #0f766e; text-align: center; }
  .col-w { background: #fafcff; font-variant-numeric: tabular-nums; }
  .col-e { background: #fcfaff; font-variant-numeric: tabular-nums; }
  .col-b { background: #f8fffe; font-variant-numeric: tabular-nums; }
  .row-primary td { background-color: rgba(79,70,229,0.04); }

  .c-green { color: #16a34a; font-weight: 600; }
  .c-orange { color: #d97706; font-weight: 600; }
  .c-red { color: #dc2626; font-weight: 600; }
  .muted, .sub { color: #64748b; font-size: 11px; }
  .mono-sm { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600;
    margin: 1px 2px 1px 0; white-space: nowrap;
  }
  .pill-green { background: #dcfce7; color: #15803d; }
  .pill-orange { background: #fef3c7; color: #b45309; }
  .pill-red { background: #fee2e2; color: #b91c1c; }
  .pill-purple { background: #ede9fe; color: #6d28d9; }
  .pill-gray { background: #f1f5f9; color: #334155; }

  /* 水平条形图 */
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 12px; }
  .bar-name { width: 68px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #334155; font-weight: 500; }
  .bar-name-wide { width: 132px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1e293b; font-weight: 500; }
  .bar-track { flex: 1; height: 16px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-val { width: 98px; flex: none; text-align: right; color: #475569; font-variant-numeric: tabular-nums; font-size: 11.5px; }
  .bar-val-sm { width: 52px; flex: none; text-align: right; color: #334155; font-variant-numeric: tabular-nums; }
  .dog-row { margin-bottom: 9px; }
  .dog-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-bottom: 3px; font-size: 12px; color: #1e293b; }
  .dog-bar-line { display: flex; align-items: center; gap: 8px; }
  .empty-tip { padding: 16px; text-align: center; color: #64748b; background: #f8fafc; border-radius: 8px; }

  /* 错例筛选工具条 */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .filter-btns { display: flex; flex-wrap: wrap; gap: 6px; }
  .f-btn {
    border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 6px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .f-btn.active { background: #1e293b; color: #fff; border-color: #1e293b; }
  .search-in { border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 10px; font-size: 12px; width: 200px; }
  .btn-more {
    display: block; margin: 10px auto 0; padding: 5px 16px; font-size: 12px;
    border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; border-radius: 6px; cursor: pointer;
  }
  .btn-more:hover { background: #e2e8f0; }
  .btn-play {
    border: 1px solid #4f46e5; background: #eef2ff; color: #4338ca; border-radius: 6px;
    padding: 3px 9px; font-size: 11.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .btn-play:hover { background: #4f46e5; color: #fff; }

  /* 内置视频验证弹窗 */
  .v-mask {
    display: none; position: fixed; inset: 0; z-index: 9999;
    background: rgba(15,23,42,0.72); align-items: center; justify-content: center; padding: 16px;
  }
  .v-mask.open { display: flex; }
  .v-box {
    background: #0f172a; color: #f8fafc; border-radius: 12px; width: 100%; max-width: 820px;
    overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.12);
  }
  .v-hd {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .v-title { font-size: 14px; font-weight: 700; }
  .v-reason { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .v-close {
    border: none; background: rgba(255,255,255,0.12); color: #fff; border-radius: 6px;
    width: 28px; height: 28px; font-size: 16px; cursor: pointer; flex: none;
  }
  .v-close:hover { background: rgba(255,255,255,0.24); }
  .v-player { width: 100%; max-height: 62vh; background: #000; display: block; }
  .v-bar {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
    padding: 10px 16px; background: #1e293b; font-size: 12px;
  }
  .v-ctrl { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .v-btn {
    border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #e2e8f0;
    border-radius: 5px; padding: 3px 9px; font-size: 11.5px; cursor: pointer;
  }
  .v-btn.active, .v-btn:hover { background: #4f46e5; border-color: #6366f1; color: #fff; }
  /* 弹窗内双轨窗口进度条（标注 vs 预测 + 实时播放线） */
  .v-tl-wrap {
    padding: 10px 16px 8px; background: #0f172a; border-top: 1px solid rgba(255,255,255,0.08);
    user-select: none;
  }
  .v-tl-head {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
    font-size: 11.5px; color: #cbd5e1; margin-bottom: 6px;
  }
  .v-tl-box {
    position: relative; cursor: pointer; border-radius: 6px;
    background: rgba(255,255,255,0.04); padding: 4px 0;
  }
  .v-imu-canvas {
    display: block; width: 100%; height: 62px; margin-bottom: 4px; border-radius: 4px;
    background: rgba(15,23,42,0.85);
  }
  .v-tl-row {
    position: relative; height: 10px; margin: 2px 0; border-radius: 3px;
    background: rgba(148,163,184,0.2); overflow: hidden;
  }
  .v-tl-seg { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
  .v-tl-head-line {
    position: absolute; top: 0; bottom: 0; width: 2px; background: #f43f5e;
    box-shadow: 0 0 6px #f43f5e; pointer-events: none; left: 0%;
  }

  /* 签核页脚 */
  .signoff {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
    margin-top: 12px; padding-top: 12px; border-top: 1px dashed #cbd5e1; font-size: 12px; color: #475569;
  }
  .footer { text-align: center; font-size: 11.5px; color: #94a3b8; margin-top: 18px; }

  /* 可选暗黑模式（默认明亮模式；打印时自动恢复明亮） */
  body.dark { background: #0b1120; color: #e2e8f0; }
  body.dark .toc-aside, body.dark .card, body.dark .edu-card, body.dark .rubric-box {
    background: #111827; border-color: #1f2937; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  body.dark .sec-hd { border-bottom-color: #1f2937; }
  body.dark .sec-hd h2, body.dark .toc-title, body.dark .meta-v, body.dark .gauge-label,
  body.dark .chart-title, body.dark .rubric-hd, body.dark .dog-meta, body.dark .donut-leg-name { color: #f1f5f9; }
  body.dark .muted, body.dark .sub, body.dark .meta-k, body.dark .gauge-sub, body.dark .edu-desc,
  body.dark .bar-val, body.dark .bar-val-sm, body.dark .bar-name, body.dark .bar-name-wide, body.dark .chart-legend { color: #94a3b8; }
  body.dark .gauge-card, body.dark .donut-wrap, body.dark .cm-box, body.dark .chart-box,
  body.dark .edu-vis, body.dark .empty-tip, body.dark .rubric-cell:not(.hit) {
    background: #1e293b; border-color: #334155; color: #cbd5e1;
  }
  body.dark .takeaways { background: #1e1b4b; border-left-color: #6366f1; }
  body.dark .takeaways div { color: #e2e8f0; }
  body.dark .toc-link { color: #cbd5e1; }
  body.dark .toc-link:hover { background: #1e293b; color: #fff; }
  body.dark .toc-link.active { background: #1e1b4b; color: #a5b4fc; border-left-color: #6366f1; }
  body.dark .toc-foot { border-top-color: #1f2937; }
  body.dark .toc-btn, body.dark .f-btn, body.dark .btn-more, body.dark .edu-pbtn, body.dark .edu-wbtn, body.dark .search-in {
    background: #1e293b; border-color: #334155; color: #e2e8f0;
  }
  body.dark .toc-btn:hover, body.dark .btn-more:hover { background: #334155; }
  body.dark .f-btn.active { background: #4f46e5; border-color: #6366f1; color: #fff; }
  body.dark th, body.dark td { border-color: #273449; color: #e2e8f0; }
  body.dark th { background: #1e293b; color: #cbd5e1; }
  body.dark .th-w { background: #172554; color: #93c5fd; }
  body.dark .th-e { background: #2e1065; color: #c4b5fd; }
  body.dark .th-b { background: #042f2e; color: #5eead4; }
  body.dark .col-w, body.dark .col-e, body.dark .col-b { background: #111827; }
  body.dark .row-primary td { background: rgba(99,102,241,0.12); }
  body.dark .bar-track { background: #273449; }
  body.dark .pill-gray { background: #1e293b; color: #cbd5e1; }
  body.dark .pill-green { background: rgba(16,185,129,0.2); color: #6ee7b7; }
  body.dark .pill-orange { background: rgba(245,158,11,0.2); color: #fcd34d; }
  body.dark .pill-red { background: rgba(239,68,68,0.2); color: #fca5a5; }
  body.dark .pill-purple { background: rgba(139,92,246,0.22); color: #c4b5fd; }
  body.dark .cm-tp { background: rgba(16,185,129,0.22); color: #6ee7b7; }
  body.dark .cm-fn { background: rgba(239,68,68,0.22); color: #fca5a5; }
  body.dark .cm-fp { background: rgba(245,158,11,0.22); color: #fcd34d; }
  body.dark .cm-tn { background: rgba(59,130,246,0.22); color: #93c5fd; }
  body.dark .btn-play { background: #1e1b4b; color: #a5b4fc; border-color: #6366f1; }
  body.dark .btn-play:hover { background: #4f46e5; color: #fff; }
  body.dark .signoff { border-top-color: #334155; color: #94a3b8; }
  body.dark svg circle[stroke="#eef2f7"], body.dark svg circle[stroke="#f1f5f9"] { stroke: #334155; }
  body.dark svg line[stroke="#e2e8f0"] { stroke: #334155; }
  body.dark svg rect[fill="#e2e8f0"] { fill: #334155; }
  body.dark svg text[fill="#0f172a"], body.dark svg text[fill="#1e293b"], body.dark svg text[fill="#334155"] { fill: #f1f5f9; }
  body.dark svg text[fill="#64748b"], body.dark svg text[fill="#94a3b8"] { fill: #94a3b8; }
  body.dark svg tspan[fill="#64748b"] { fill: #94a3b8; }
  body.dark .edu-banner-bar { background: #1e293b !important; border-color: #334155 !important; color: #cbd5e1 !important; }
  body.dark .dog-summary-bar { background: #1e293b !important; color: #cbd5e1 !important; }

  @media (max-width: 1020px) {
    .toc-aside { display: none; }
    .page { max-width: 100%; }
  }
  @media (max-width: 780px) {
    .gauges-grid { grid-template-columns: repeat(2, 1fr); }
    .vis-two { grid-template-columns: 1fr; }
    .signoff { grid-template-columns: 1fr; }
  }
  @media print {
    body { background: #fff; padding: 0; }
    .toc-aside, .btn-print, .filter-bar, .btn-more { display: none !important; }
    .layout { display: block; }
    .page { max-width: 100%; }
    .card { break-inside: avoid; box-shadow: none; }
    .case-row.hidden-extra { display: table-row !important; }
  }
</style>
</head>
<body>
<div class="layout">
  <aside class="toc-aside">
    <div class="toc-title">报告目录</div>
    <div class="toc-code">${esc(reportCode)}</div>
    <nav class="toc-nav">${tocHtml}</nav>
    <div class="toc-foot">
      <button class="toc-btn theme-toggle-btn" type="button">🌙 暗黑模式</button>
      <a class="toc-btn" href="#top">↑ 回到顶部</a>
      <button class="toc-btn" onclick="window.print()">打印 / 另存 PDF</button>
    </div>
  </aside>
<div class="page" id="top">

  <!-- 报告头部 -->
  <div class="banner">
    <div>
      <div class="banner-tag">QA EVALUATION REPORT · ${esc(reportCode)}</div>
      <h1>模型行为识别测试报告</h1>
      <div class="banner-sub">测试集：${esc(testSet.name)}${primary?.modelMeta ? ` · 模型架构：${esc(primary.modelMeta.shortTag)}` : ""} · 评估类别：${esc(labelTitle)} · 报告生成：${esc(genTime)}</div>
    </div>
    <div class="banner-right">
      <span class="verdict-badge ${winGrade.cls}">窗口 ${winGrade.code}·${winGrade.name} (${pct(pw?.f1)})</span>
      <span class="verdict-badge ${evGrade.cls}">事件 ${evGrade.code}·${evGrade.name} (${pct(evF1)})</span>
      <button class="btn-print theme-toggle-btn" type="button">🌙 暗黑模式</button>
      <button class="btn-print" onclick="window.print()">打印 / 另存为 PDF</button>
    </div>
  </div>

  <!-- 一、测试概况 -->
  <div class="card" id="sec-overview">
    <div class="sec-hd">
      <h2>一、测试概况与范围</h2>
      <span class="sub">${testSet.frozen ? "已冻结测试集" : "动态测试集"}</span>
    </div>
    <div class="meta-grid">
      <div class="meta-item"><span class="meta-k">测试集名称</span><span class="meta-v">${esc(testSet.name)}</span></div>
      <div class="meta-item"><span class="meta-k">主测模型版本</span><span class="meta-v mono-sm">${esc(primary?.version ?? "-")}${primary?.modelMeta ? `<div style="margin-top:4px;font-family:inherit">${renderArchBadge(primary.modelMeta)}</div>` : ""}</span></div>
      <div class="meta-item"><span class="meta-k">评估类别 / 判定标准</span><span class="meta-v">${esc(labelTitle)}（重叠 ≥ ${iouPct}% · 容差 ±${edgeTolSec}s）</span></div>
      <div class="meta-item"><span class="meta-k">数据规模与覆盖</span><span class="meta-v">${nTotal} 段 · ${nDogs} 只犬 · ${fmtSec(totalSec)}</span></div>
      <div class="meta-item"><span class="meta-k">人工核对进度</span><span class="meta-v">${nChecked} / ${nTotal} 段（${nTotal ? Math.round((nChecked / nTotal) * 100) : 0}%）</span></div>
      <div class="meta-item"><span class="meta-k">训练数据隔离</span><span class="meta-v">${testSet.seen_ref ? `没见过 ${testSet.n_unseen ?? 0} 段 / 见过 ${testSet.n_seen ?? 0} 段` : "全部样本"}</span></div>
      <div class="meta-item"><span class="meta-k">数据场地</span><span class="meta-v">${esc(sitesTxt)}</span></div>
      <div class="meta-item"><span class="meta-k">测试人 / 创建人</span><span class="meta-v">${esc(reporter || testSet.creator_name || "-")} / ${esc(testSet.creator_name || "-")}</span></div>
    </div>
    ${testSet.note ? `<div class="muted" style="margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9">测试说明：${esc(testSet.note)}</div>` : ""}
  </div>

  <!-- 二、核心指标可视化总览 -->
  <div class="card" id="sec-kpi">
    <div class="sec-hd">
      <h2>二、核心指标总览</h2>
      <span class="sub">主测模型：${esc(primary?.version ?? "-")}${primary?.modelMeta ? `（${esc(primary.modelMeta.shortTag)}）` : ""} · ${esc(primary?.group ?? "")}</span>
    </div>

    <div class="gauges-grid">
      ${renderGaugeSvg(pw?.accuracy, "#2563eb", "片段级检出准确率", pw ? `共 ${pw.n_windows} 段 · 判对 ${pw.tp + pw.tn} 段` : "-")}
      ${renderGaugeSvg(pw?.f1, "#3b82f6", "片段级 F1（须有重叠）", pw ? `精确 ${pct(pw.precision)} / 召回 ${pct(pw.recall)}` : "-")}
      ${renderGaugeSvg(evF1, "#7c3aed", `事件级 F1（每次计次）`, pr ? `IoU≥${iouPct}% · 命中 ${pr.tp}/误 ${pr.fp}/漏 ${pr.fn}` : "-")}
      ${renderGaugeSvg(pr?.within_2s_ratio, "#0d9488", `起止 ±${edgeTolSec}s 对齐率`, pr ? `命中平均重叠 ${pct(pr.mean_iou)}` : "-")}
    </div>

    ${rubricHtml}

    <!-- 三大核心指标：一层比一层严的三关，用具体时间例子讲清楚 -->
    <div class="edu-banner-bar" style="margin-bottom:8px;padding:7px 12px;border-radius:7px;background:#f8fafc;border:1px solid #e2e8f0;font-size:12px;color:#334155">
      <b>三个指标其实是「一层比一层严」的三道关（全部要求真实重叠，不按 1 分钟凑数）：</b>
      <span style="color:#1d4ed8;font-weight:600">第 1 关看有没有重叠检出</span> →
      <span style="color:#6d28d9;font-weight:600">第 2 关看每次动作重叠够不够 ${iouPct}%</span> →
      <span style="color:#0f766e;font-weight:600">第 3 关看开始/结束时间差几秒</span>
    </div>
    <div class="edu-grid">
      <!-- ① 片段级检出（须真实重叠 >0s，舍弃 1 分钟框概念） -->
      <div class="edu-card c-win">
        <div class="edu-hd">
          <span style="color:#1d4ed8">第 1 关 · 片段级检出（须真实重叠）</span>
          <span class="edu-tag" style="background:#eff6ff;color:#1d4ed8">拖动交互</span>
        </div>
        <div class="edu-vis">
          <svg viewBox="0 0 260 68" width="100%" style="display:block">
            <text x="4" y="12" font-size="9.5" fill="#64748b">例：蓝条必须与绿条有真实重叠（&gt;0s）才算命中</text>
            <rect x="10" y="21" width="220" height="10" rx="3" fill="#e2e8f0" />
            <g id="eduWinTruth">
              <rect x="76" y="21" width="66" height="10" rx="3" fill="#10b981" />
            </g>
            <text x="236" y="29" font-size="9" fill="#15803d" font-weight="600">真</text>
            <rect x="10" y="35" width="220" height="10" rx="3" fill="#e2e8f0" />
            <rect id="eduWinPred" x="88" y="35" width="66" height="10" rx="3" fill="#3b82f6" />
            <text x="236" y="43" font-size="9" fill="#1d4ed8" font-weight="600">测</text>
            <text id="eduWinTxt" x="4" y="63" font-size="10" font-weight="700" fill="#15803d">✓ 与真实动作有重叠 → 命中 (TP)</text>
          </svg>
          <div class="edu-ctrl" id="eduWinSlideRow">
            <span>拖看有无重叠：</span>
            <input type="range" id="eduWinRange" class="edu-slider" style="accent-color:#2563eb" min="10" max="164" step="2" value="88" />
            <b id="eduWinPos" style="color:#15803d">有重叠 ✓</b>
          </div>
          <div class="edu-ctrl">
            <button class="edu-wbtn active" data-w="tp">命中 TP</button>
            <button class="edu-wbtn" data-w="tn">正常 TN</button>
            <button class="edu-wbtn" data-w="fp">误报 FP</button>
            <button class="edu-wbtn" data-w="fn">漏报 FN</button>
          </div>
        </div>
        <div class="edu-desc"><b>基础检出：</b>模型预测必须与真实动作<b>真实重叠（&gt;0s）</b>才算命中；<b>完全不重叠</b>不算命中（算漏报）。无动作段若乱报算误报（FP）。</div>
      </div>

      <!-- ② 事件级（可拖动 IoU 交互演示） -->
      <div class="edu-card c-evt">
        <div class="edu-hd">
          <span style="color:#6d28d9">第 2 关 · 事件级（重叠够不够 ${iouPct}%）</span>
          <span class="edu-tag" style="background:#f5f3ff;color:#6d28d9">拖动交互</span>
        </div>
        <div class="edu-vis">
          <svg viewBox="0 0 260 66" width="100%" style="display:block">
            <text x="4" y="12" font-size="9.5" fill="#64748b">例：真实 11:11:10~16s(绿) · 预测(紫) · 重叠(金)</text>
            <rect x="4" y="19" width="232" height="11" rx="3" fill="#e2e8f0" />
            <rect x="76" y="19" width="72" height="11" rx="3" fill="#10b981" />
            <rect x="4" y="35" width="232" height="11" rx="3" fill="#e2e8f0" />
            <rect id="eduIouPred" x="94" y="35" width="72" height="11" rx="3" fill="#7c3aed" />
            <rect id="eduIouInter" x="94" y="19" width="54" height="27" rx="2" fill="rgba(245,158,11,0.28)" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="3,2" />
            <text id="eduIouTxt" x="4" y="61" font-size="10" font-weight="700" fill="#15803d">重叠占比 = 60% ≥ ${iouPct}% → 这次算抓对 ✓</text>
          </svg>
          <div class="edu-ctrl">
            <span>拖看报歪几秒：</span>
            <input type="range" id="eduIouRange" class="edu-slider" min="-6" max="7" step="0.5" value="1.5" />
            <b id="eduIouShift">+1.5s</b>
          </div>
        </div>
        <div class="edu-desc"><b>加严一步：</b>真正在 11:11:10~16s 抓挠，模型预测的那段必须跟它<b>重叠占比 ≥ ${iouPct}%</b>（交集÷并集）才算抓对；没重叠上或漏掉某一次都要扣分。</div>
      </div>

      <!-- ③ 起止对齐（可滑动 + 快捷档位交互演示） -->
      <div class="edu-card c-edg">
        <div class="edu-hd">
          <span style="color:#0f766e">第 3 关 · 起止对齐（两头差≤${edgeTolSec}s）</span>
          <span class="edu-tag" style="background:#f0fdfa;color:#0f766e">拖动交互</span>
        </div>
        <div class="edu-vis">
          <svg viewBox="0 0 260 66" width="100%" style="display:block">
            <text x="4" y="12" font-size="9.5" fill="#64748b">例：在已抓对的基础上，拖看开头/结尾各差几秒</text>
            <rect x="4" y="20" width="232" height="10" rx="3" fill="#e2e8f0" />
            <rect x="64" y="20" width="96" height="10" rx="3" fill="#10b981" />
            <line x1="64" y1="16" x2="64" y2="48" stroke="#10b981" stroke-width="1.2" stroke-dasharray="2,2" />
            <line x1="160" y1="16" x2="160" y2="48" stroke="#10b981" stroke-width="1.2" stroke-dasharray="2,2" />
            <rect x="4" y="36" width="232" height="10" rx="3" fill="#e2e8f0" />
            <rect id="eduEdgPred" x="72" y="36" width="94" height="10" rx="3" fill="#0d9488" />
            <text id="eduEdgTxt" x="4" y="61" font-size="10" font-weight="700" fill="#0f766e">起 +0.8s / 止 +0.6s（≤ ±${edgeTolSec}s 对齐 ✓）</text>
          </svg>
          <div class="edu-ctrl">
            <span>起点差：</span>
            <input type="range" id="eduEdgStart" class="edu-slider" style="accent-color:#0d9488;min-width:58px" min="-5" max="5" step="0.2" value="0.8" />
            <span>终点差：</span>
            <input type="range" id="eduEdgEnd" class="edu-slider" style="accent-color:#0d9488;min-width:58px" min="-5" max="5" step="0.2" value="0.6" />
          </div>
          <div class="edu-ctrl">
            <button class="edu-pbtn active" data-ds="0.8" data-de="0.6">很准 (±0.8s)</button>
            <button class="edu-pbtn" data-ds="1.8" data-de="-1.5">微偏 (±1.8s)</button>
            <button class="edu-pbtn" data-ds="3.6" data-de="2.8">偏大 (±3.6s)</button>
          </div>
        </div>
        <div class="edu-desc"><b>最严格：</b>在上面第 2 关已经重叠抓对的动作里，<b>开始时间差 ≤ ${edgeTolSec}s 且 结束时间差 ≤ ${edgeTolSec}s</b> 才算对齐，用来衡量视频回放定位准不准。</div>
      </div>
    </div>

    ${sc.total > 0 ? `
    <div class="vis-two">
      ${renderVerdictDonutSvg(sc.tp, sc.tn, sc.fp, sc.fn)}
      <div class="cm-box">
        <div class="cm-title">测试片段级混淆矩阵（共 ${sc.total} 段 · 须真实重叠）</div>
        <div class="cm-grid">
          <div></div><div class="cm-hd">模型预测：有</div><div class="cm-hd">模型预测：无</div>
          <div class="cm-hd">实际：有</div>
          <div class="cm-cell cm-tp"><b>${sc.tp}</b><span>命中 (TP)</span></div>
          <div class="cm-cell cm-fn"><b>${sc.fn}</b><span>漏报 (FN)</span></div>
          <div class="cm-hd">实际：无</div>
          <div class="cm-cell cm-fp"><b>${sc.fp}</b><span>误报 (FP)</span></div>
          <div class="cm-cell cm-tn"><b>${sc.tn}</b><span>正常通过 (TN)</span></div>
        </div>
      </div>
    </div>` : ""}

    <div class="takeaways">
      ${takeaways.map((t) => `<div>• ${t}</div>`).join("")}
    </div>
  </div>

  <!-- 三、模型指标对比 -->
  <div class="card" id="sec-compare">
    <div class="sec-hd">
      <h2>三、模型评测指标对比</h2>
      <span class="sub">共 ${rows.length} 条记录 · 事件判定阈值 IoU ≥ ${iouPct}% · 容差 ±${edgeTolSec}s</span>
    </div>
    ${renderModelCompareChartSvg(rows, showLabelCol, edgeTolSec, false)}
    ${rows.length > 1 ? `<div style="overflow-x:auto;margin-top:14px">
      <table>
        <thead>
          <tr>
            ${showLabelCol ? `<th rowspan="2">类别</th>` : ""}
            <th rowspan="2">范围</th>
            <th rowspan="2">模型版本</th>
            <th colspan="5" class="th-w">片段级检出（须真实重叠）</th>
            <th colspan="4" class="th-e">事件级（IoU ≥ ${iouPct}%）</th>
            <th colspan="3" class="th-b">起止对齐（命中事件）</th>
          </tr>
          <tr>
            <th class="th-w">准确率</th><th class="th-w">精确率</th><th class="th-w">召回率</th><th class="th-w">F1</th><th class="th-w">对/误/漏</th>
            <th class="th-e">精确率</th><th class="th-e">召回率</th><th class="th-e">F1</th><th class="th-e">对/误/漏</th>
            <th class="th-b">平均重叠</th><th class="th-b">±${edgeTolSec}s 对齐</th><th class="th-b">起/止均差</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>` : ""}
    ${iouPanelHtml}
  </div>

  ${allCatSectionHtml}

  <!-- 四、测试集数据分布 -->
  <div class="card" id="sec-coverage">
    <div class="sec-hd">
      <h2>${secNumCov}、测试集数据覆盖分布</h2>
      <span class="sub">${nDogs} 只犬 · 总时长 ${fmtSec(totalSec)}</span>
    </div>
    <div class="two-col">
      <div>
        <div class="chart-title" style="margin-bottom:8px">受试犬只特征与时长占比（品种 / 体型 / 皮肤状态）</div>
        ${dogSummaryHtml}
        ${dogsHtml || `<div class="muted">暂无数据</div>`}
      </div>
      <div>
        <div class="chart-title" style="margin-bottom:8px">窗口时长 × 正负例分布（<span style="color:#10b981">■ 有动作</span> / <span style="color:#64748b">■ 无动作</span>）</div>
        ${durHtml || `<div class="muted">暂无数据</div>`}
      </div>
    </div>
  </div>

  <!-- 五、错例归因与缺陷明细 -->
  <div class="card" id="sec-cases">
    <div class="sec-hd">
      <h2>${secNumCases}、错例归因与缺陷明细</h2>
      <span class="sub">错误窗口 ${sc.err} 段（误报 ${sc.fp} / 漏报 ${sc.fn}），边界偏差 &gt;2s 共 ${sc.boundaryBad} 段</span>
    </div>

    <div style="margin-bottom:14px">
      <div class="chart-title" style="margin-bottom:8px">失误原因分布（按频次降序）</div>
      ${reasonBarsHtml}
    </div>

    ${sortedCases.length > 0 ? `
    <div class="filter-bar">
      <div class="filter-btns">
        <button class="f-btn active" data-f="err">仅看错误 (${sc.err})</button>
        <button class="f-btn" data-f="fp">误报 (${sc.fp})</button>
        <button class="f-btn" data-f="fn">漏报 (${sc.fn})</button>
        <button class="f-btn" data-f="bd">偏差 &gt;${edgeTolSec}s (${sc.boundaryBad})</button>
        <button class="f-btn" data-f="tp">命中 (${sc.tp})</button>
        <button class="f-btn" data-f="tn">正常通过 (${sc.tn})</button>
        <button class="f-btn" data-f="all">全部 (${sortedCases.length})</button>
      </div>
      <input class="search-in" id="caseSearch" placeholder="按狗名 / 场地 / 原因搜索..." />
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th style="width:36px">#</th>
            <th style="width:68px">类型</th>
            <th style="width:128px">犬只 / 场地</th>
            <th style="width:110px">窗口时间</th>
            <th style="width:185px">标注(绿) vs 预测(蓝/橙)</th>
            <th style="width:205px">自动归因</th>
            <th>窗口内实际动作</th>
            <th style="width:82px;text-align:center">视频验证</th>
          </tr>
        </thead>
        <tbody id="caseTbody">${caseRowsHtml}</tbody>
      </table>
    </div>
    <button class="btn-more" id="btnShowAll" style="display:none">展开全部</button>
    ` : ""}

    <div class="signoff">
      <div><b>测试执行：</b>${esc(reporter || testSet.creator_name || "_____________")}</div>
      <div><b>算法确认：</b>_____________</div>
      <div><b>报告日期：</b>${esc(genTime.slice(0, 10))}</div>
    </div>
  </div>

  <div class="footer">Smart-Label 算法评测系统自动生成 · 报告编号 ${esc(reportCode)} · 支持离线查看与浏览器打印 PDF</div>
</div>
</div>

<!-- 内置视频验证弹窗（点击明细行「▶ 看视频」免登录直接回放对应时刻） -->
<div class="v-mask" id="videoModal">
  <div class="v-box">
    <div class="v-hd">
      <div>
        <div class="v-title" id="vTitle">视频验证</div>
        <div class="v-reason" id="vReason"></div>
      </div>
      <button class="v-close" id="vClose" title="关闭 (ESC)">×</button>
    </div>
    <video class="v-player" id="vPlayer" controls playsinline preload="metadata"></video>
    <!-- 窗口内双轨可视化进度条：上轨人工标注(绿) / 下轨模型预测(蓝或橙) / 红色实时播放线，点击任意位置可跳转 -->
    <div class="v-tl-wrap">
      <div class="v-tl-head">
        <span>
          <i class="dot" style="background:#38bdf8"></i>IMU Acc-X
          <i class="dot" style="background:#10b981;margin-left:10px"></i>人工标注
          <i class="dot" id="vPredDot" style="background:#3b82f6;margin-left:10px"></i><span id="vPredLbl">模型预测</span>
          <span style="color:#64748b;margin-left:8px">（点波形或进度条可跳转）</span>
        </span>
        <span id="vCurPos" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#f8fafc">0:00</span>
      </div>
      <div class="v-tl-box" id="vTlBox">
        <canvas class="v-imu-canvas" id="vImuCanvas" width="780" height="62"></canvas>
        <div class="v-tl-row" id="vTlTruth"></div>
        <div class="v-tl-row" id="vTlPred"></div>
        <div class="v-tl-head-line" id="vTlPlayhead"></div>
      </div>
    </div>
    <div class="v-bar">
      <div class="v-ctrl">
        <button class="v-btn" id="vReplay">↺ 重播该动作</button>
        <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:#cbd5e1">
          <input type="checkbox" id="vLoop" checked /> 循环该窗口
        </label>
        <span style="color:#94a3b8;margin-left:6px" id="vTimeRange"></span>
      </div>
      <div class="v-ctrl">
        <span style="color:#94a3b8">倍速：</span>
        <button class="v-btn v-spd" data-spd="0.5">0.5x</button>
        <button class="v-btn v-spd active" data-spd="1">1x</button>
        <button class="v-btn v-spd" data-spd="1.5">1.5x</button>
        <button class="v-btn v-spd" data-spd="2">2x</button>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  var VIDEO_BASE = "__REPORT_VIDEO_BASE__";
  // 明亮 / 暗黑模式切换（默认明亮，打印时自动恢复明亮）
  var themeBtns = Array.prototype.slice.call(document.querySelectorAll(".theme-toggle-btn"));
  function applyTheme(dark) {
    if (dark) document.body.classList.add("dark");
    else document.body.classList.remove("dark");
    themeBtns.forEach(function(b) { b.textContent = dark ? "☀ 明亮模式" : "🌙 暗黑模式"; });
  }
  try {
    if (localStorage.getItem("smart-label:report-theme") === "dark") applyTheme(true);
  } catch (e) {}
  themeBtns.forEach(function(b) {
    b.addEventListener("click", function() {
      var next = !document.body.classList.contains("dark");
      applyTheme(next);
      try { localStorage.setItem("smart-label:report-theme", next ? "dark" : "light"); } catch (e) {}
    });
  });
  var wasDarkBeforePrint = false;
  window.addEventListener("beforeprint", function() {
    wasDarkBeforePrint = document.body.classList.contains("dark");
    if (wasDarkBeforePrint) document.body.classList.remove("dark");
  });
  window.addEventListener("afterprint", function() {
    if (wasDarkBeforePrint) document.body.classList.add("dark");
  });

  // 左侧目录大纲滚动高亮联动
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc-link"));
  var sections = tocLinks.map(function(a) { return document.getElementById(a.getAttribute("data-target")); }).filter(Boolean);
  function syncToc() {
    var y = window.scrollY + 90;
    var activeId = sections.length ? sections[0].id : "";
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= y) activeId = sections[i].id;
    }
    tocLinks.forEach(function(a) {
      if (a.getAttribute("data-target") === activeId) a.classList.add("active");
      else a.classList.remove("active");
    });
  }
  if (sections.length) {
    window.addEventListener("scroll", syncToc, { passive: true });
    syncToc();
  }

  var curFilter = "err";
  var expanded = false;
  var LIMIT = 20;
  var btns = document.querySelectorAll(".f-btn");
  var search = document.getElementById("caseSearch");
  var btnMore = document.getElementById("btnShowAll");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".case-row"));

  function apply() {
    var kw = (search ? search.value : "").trim().toLowerCase();
    var matched = [];
    rows.forEach(function(tr) {
      var k = tr.getAttribute("data-kind");
      var bd = tr.getAttribute("data-bd") === "1";
      var okKind = curFilter === "all"
        || (curFilter === "err" && (k === "fp" || k === "fn"))
        || (curFilter === "bd" && bd)
        || k === curFilter;
      var okKw = !kw || tr.textContent.toLowerCase().indexOf(kw) >= 0;
      if (okKind && okKw) matched.push(tr);
      else { tr.style.display = "none"; tr.classList.remove("hidden-extra"); }
    });
    matched.forEach(function(tr, i) {
      if (!expanded && i >= LIMIT) {
        tr.style.display = "none";
        tr.classList.add("hidden-extra");
      } else {
        tr.style.display = "";
        tr.classList.remove("hidden-extra");
      }
    });
    if (btnMore) {
      if (!expanded && matched.length > LIMIT) {
        btnMore.style.display = "block";
        btnMore.textContent = "展开其余 " + (matched.length - LIMIT) + " 条（共 " + matched.length + " 条）";
      } else {
        btnMore.style.display = "none";
      }
    }
  }

  btns.forEach(function(b) {
    b.addEventListener("click", function() {
      btns.forEach(function(x) { x.classList.remove("active"); });
      b.classList.add("active");
      curFilter = b.getAttribute("data-f");
      expanded = false;
      apply();
    });
  });
  if (search) search.addEventListener("input", function() { expanded = false; apply(); });
  if (btnMore) btnMore.addEventListener("click", function() { expanded = true; apply(); });
  apply();

  // 三指标交互演示（片段级须真实重叠 + IoU 滑块 + 起止对齐档位）
  var winBtns = Array.prototype.slice.call(document.querySelectorAll(".edu-wbtn"));
  var winTruth = document.getElementById("eduWinTruth");
  var winPred = document.getElementById("eduWinPred");
  var winTxt = document.getElementById("eduWinTxt");
  var winRange = document.getElementById("eduWinRange");
  var winSlideRow = document.getElementById("eduWinSlideRow");
  var winPosTxt = document.getElementById("eduWinPos");
  var curWinState = "tp";
  var WIN_STATES = {
    tp: { t: true, p: true, fill: "#3b82f6", color: "#15803d", txt: "✓ 与真实动作有重叠 → 命中 (TP)" },
    tn: { t: false, p: false, fill: "#3b82f6", color: "#1d4ed8", txt: "✓ 实际无动作，模型也没报 → 正常通过 (TN)" },
    fp: { t: false, p: true, fill: "#f59e0b", color: "#b45309", txt: "✗ 实际无动作，模型乱报了 → 误报 (FP)" },
    fn: { t: true, p: false, fill: "#ef4444", color: "#dc2626", txt: "✗ 实际有动作，模型漏报了 → 漏报 (FN)" },
  };
  function updateWinSlide() {
    if (!winRange || !winPred) return;
    var x = parseFloat(winRange.value) || 88;
    winPred.setAttribute("x", x.toFixed(1));
    // 绿条在 [76, 142]，蓝条宽 66，必须有真实重叠 (>0) 才算命中
    var hasOv = (x + 66) > 76 && x < 142;
    if (curWinState === "tp" && winTxt && winPosTxt) {
      if (hasOv) {
        winPred.setAttribute("fill", "#3b82f6");
        winPosTxt.style.color = "#15803d";
        winPosTxt.textContent = "有重叠 ✓";
        winTxt.setAttribute("fill", "#15803d");
        winTxt.textContent = "✓ 与真实动作有重叠（>0s）→ 命中 (TP)";
      } else {
        winPred.setAttribute("fill", "#ef4444");
        winPosTxt.style.color = "#dc2626";
        winPosTxt.textContent = "完全不重叠 ✗";
        winTxt.setAttribute("fill", "#dc2626");
        winTxt.textContent = "✗ 完全没重叠 → 不算命中，判漏报 (FN)";
      }
    } else if (curWinState === "fp" && winTxt && winPosTxt) {
      winPred.setAttribute("fill", "#f59e0b");
      winPosTxt.style.color = "#b45309";
      winPosTxt.textContent = "无动作乱报 ✗";
      winTxt.setAttribute("fill", "#b45309");
      winTxt.textContent = "✗ 实际无动作却乱报了 → 误报 (FP)";
    }
  }
  function applyEduWin(k) {
    curWinState = k || "tp";
    var st = WIN_STATES[curWinState] || WIN_STATES.tp;
    if (winTruth) winTruth.style.display = st.t ? "" : "none";
    if (winPred) {
      winPred.style.display = st.p ? "" : "none";
      winPred.setAttribute("fill", st.fill);
    }
    if (winSlideRow) winSlideRow.style.opacity = st.p ? "1" : "0.35";
    if (winRange) winRange.disabled = !st.p;
    if (st.p) {
      updateWinSlide();
    } else {
      if (winPosTxt) { winPosTxt.style.color = st.color; winPosTxt.textContent = "无预测条"; }
      if (winTxt) { winTxt.setAttribute("fill", st.color); winTxt.textContent = st.txt; }
    }
  }
  if (winRange) winRange.addEventListener("input", updateWinSlide);
  winBtns.forEach(function(b) {
    b.addEventListener("click", function() {
      winBtns.forEach(function(x) { x.classList.remove("active"); });
      b.classList.add("active");
      applyEduWin(b.getAttribute("data-w"));
    });
  });
  updateWinSlide();

  var REPORT_IOU_PCT = ${iouPct};
  var REPORT_EDGE_TOL = ${edgeTolSec};
  var iouRange = document.getElementById("eduIouRange");
  var iouPred = document.getElementById("eduIouPred");
  var iouInter = document.getElementById("eduIouInter");
  var iouTxt = document.getElementById("eduIouTxt");
  var iouShift = document.getElementById("eduIouShift");
  function updateEduIou() {
    if (!iouRange || !iouPred || !iouInter || !iouTxt) return;
    var sh = parseFloat(iouRange.value) || 0;
    var pxPerSec = 12; // 6s = 72px
    var t0 = 76, t1 = 148;
    var p0 = Math.max(4, Math.min(164, t0 + sh * pxPerSec));
    var p1 = p0 + 72;
    iouPred.setAttribute("x", p0.toFixed(1));
    var i0 = Math.max(t0, p0), i1 = Math.min(t1, p1);
    var inter = Math.max(0, i1 - i0);
    var union = (t1 - t0) + (p1 - p0) - inter;
    var iouP = union > 0 ? Math.round((inter / union) * 100) : 0;
    if (inter > 0) {
      iouInter.setAttribute("x", i0.toFixed(1));
      iouInter.setAttribute("width", inter.toFixed(1));
      iouInter.style.display = "";
    } else {
      iouInter.style.display = "none";
    }
    if (iouShift) iouShift.textContent = (sh >= 0 ? "+" : "") + sh.toFixed(1) + "s";
    var ok = iouP >= REPORT_IOU_PCT;
    iouPred.setAttribute("fill", ok ? "#7c3aed" : "#ef4444");
    iouTxt.setAttribute("fill", ok ? "#15803d" : "#dc2626");
    iouTxt.textContent = ok
      ? "重叠 IoU = " + iouP + "% ≥ " + REPORT_IOU_PCT + "% → 算命中 ✓"
      : "重叠 IoU = " + iouP + "% < " + REPORT_IOU_PCT + "% → 判 1 误 + 1 漏 ✗";
  }
  if (iouRange) {
    iouRange.addEventListener("input", updateEduIou);
    updateEduIou();
  }

  var edgBtns = Array.prototype.slice.call(document.querySelectorAll(".edu-pbtn"));
  var edgPred = document.getElementById("eduEdgPred");
  var edgTxt = document.getElementById("eduEdgTxt");
  var edgStart = document.getElementById("eduEdgStart");
  var edgEnd = document.getElementById("eduEdgEnd");
  function renderEduEdge(ds, de) {
    if (!edgPred || !edgTxt) return;
    var pxPerSec = 10;
    var p0 = Math.max(4, Math.min(200, 64 + ds * pxPerSec));
    var p1 = Math.max(p0 + 18, Math.min(236, 160 + de * pxPerSec));
    edgPred.setAttribute("x", p0.toFixed(1));
    edgPred.setAttribute("width", (p1 - p0).toFixed(1));
    var maxE = Math.max(Math.abs(ds), Math.abs(de));
    var ok = maxE <= REPORT_EDGE_TOL;
    edgPred.setAttribute("fill", ok ? "#0d9488" : "#ef4444");
    edgTxt.setAttribute("fill", ok ? "#0f766e" : "#dc2626");
    var sStr = (ds >= 0 ? "+" : "") + ds.toFixed(1) + "s";
    var eStr = (de >= 0 ? "+" : "") + de.toFixed(1) + "s";
    edgTxt.textContent = "起 " + sStr + " / 止 " + eStr + (ok ? "（≤ ±" + REPORT_EDGE_TOL + "s 对齐 ✓）" : "（> ±" + REPORT_EDGE_TOL + "s 未对齐 ✗）");
  }
  function onEduEdgeSlide() {
    edgBtns.forEach(function(x) { x.classList.remove("active"); });
    var ds = edgStart ? parseFloat(edgStart.value) || 0 : 0;
    var de = edgEnd ? parseFloat(edgEnd.value) || 0 : 0;
    renderEduEdge(ds, de);
  }
  if (edgStart) edgStart.addEventListener("input", onEduEdgeSlide);
  if (edgEnd) edgEnd.addEventListener("input", onEduEdgeSlide);
  edgBtns.forEach(function(b) {
    b.addEventListener("click", function() {
      edgBtns.forEach(function(x) { x.classList.remove("active"); });
      b.classList.add("active");
      var ds = parseFloat(b.getAttribute("data-ds") || "0") || 0;
      var de = parseFloat(b.getAttribute("data-de") || "0") || 0;
      if (edgStart) edgStart.value = String(ds);
      if (edgEnd) edgEnd.value = String(de);
      renderEduEdge(ds, de);
    });
  });
  renderEduEdge(0.8, 0.6);

  // 内置视频验证播放器
  var vModal = document.getElementById("videoModal");
  var vPlayer = document.getElementById("vPlayer");
  var vTitle = document.getElementById("vTitle");
  var vReason = document.getElementById("vReason");
  var vRange = document.getElementById("vTimeRange");
  var vLoop = document.getElementById("vLoop");
  var vReplay = document.getElementById("vReplay");
  var vClose = document.getElementById("vClose");
  var vTlBox = document.getElementById("vTlBox");
  var vImuCanvas = document.getElementById("vImuCanvas");
  var vTlTruth = document.getElementById("vTlTruth");
  var vTlPred = document.getElementById("vTlPred");
  var vTlPlayhead = document.getElementById("vTlPlayhead");
  var vCurPos = document.getElementById("vCurPos");
  var vPredDot = document.getElementById("vPredDot");
  var vPredLbl = document.getElementById("vPredLbl");
  var spdBtns = Array.prototype.slice.call(document.querySelectorAll(".v-spd"));
  var curSeek = 0, curWs = 0, curWe = 0, curSrc = "", rafId = 0, imuReqSeq = 0;

  function drawImuWave(tMs, ax, wsMs, weMs, tSegs, pSegs, pColor, statusMsg) {
    if (!vImuCanvas) return;
    var ctx = vImuCanvas.getContext("2d");
    if (!ctx) return;
    var W = vImuCanvas.width, H = vImuCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(15,23,42,0.9)";
    ctx.fillRect(0, 0, W, H);
    var dur = Math.max(1, weMs - wsMs);
    // 背景标注/预测高亮带
    (tSegs || []).forEach(function(seg) {
      var x0 = Math.max(0, Math.min(W, (seg[0] / dur) * W));
      var x1 = Math.max(x0 + 2, Math.min(W, (seg[1] / dur) * W));
      ctx.fillStyle = "rgba(16,185,129,0.16)";
      ctx.fillRect(x0, 0, x1 - x0, H);
    });
    (pSegs || []).forEach(function(seg) {
      var x0 = Math.max(0, Math.min(W, (seg[0] / dur) * W));
      var x1 = Math.max(x0 + 2, Math.min(W, (seg[1] / dur) * W));
      ctx.fillStyle = pColor === "#f59e0b" ? "rgba(245,158,11,0.16)" : "rgba(59,130,246,0.16)";
      ctx.fillRect(x0, 0, x1 - x0, H);
    });
    // 中线
    ctx.strokeStyle = "rgba(148,163,184,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    if (!tMs || !tMs.length || !ax || !ax.length) {
      ctx.fillStyle = "#64748b";
      ctx.font = "11px sans-serif";
      ctx.fillText(statusMsg || "加载 IMU Acc-X 波形...", 10, H / 2 + 4);
      return;
    }
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < ax.length; i++) {
      var v = ax[i];
      if (v == null || !isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!isFinite(mn) || !isFinite(mx)) return;
    var span = Math.max(0.2, mx - mn);
    var pad = 6;
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var penDown = false;
    for (var j = 0; j < tMs.length; j++) {
      var val = ax[j];
      if (val == null || !isFinite(val)) { penDown = false; continue; }
      var x = ((tMs[j] - wsMs) / dur) * W;
      var y = H - pad - ((val - mn) / span) * (H - pad * 2);
      if (!penDown) { ctx.moveTo(x, y); penDown = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(148,163,184,0.8)";
    ctx.font = "10px monospace";
    ctx.fillText("Acc-X " + mn.toFixed(1) + "~" + mx.toFixed(1) + "g", 6, 12);
  }
  function stopRaf() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  function startRaf() {
    stopRaf();
    function tick() {
      syncPlayhead();
      if (vPlayer && !vPlayer.paused && vModal && vModal.classList.contains("open")) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function renderVideoTrack(container, segs, durMs, color) {
    if (!container) return;
    container.innerHTML = "";
    if (!segs || !segs.length || durMs <= 0) return;
    segs.forEach(function(seg) {
      var s = seg[0], e = seg[1];
      var left = Math.max(0, Math.min(100, (s / durMs) * 100));
      var width = Math.max(1.2, Math.min(100 - left, ((e - s) / durMs) * 100));
      var div = document.createElement("div");
      div.className = "v-tl-seg";
      div.style.left = left.toFixed(2) + "%";
      div.style.width = width.toFixed(2) + "%";
      div.style.background = color;
      container.appendChild(div);
    });
  }
  function syncPlayhead() {
    if (!vPlayer || !vTlPlayhead) return;
    var dur = Math.max(0.1, curWe - curWs);
    var rel = vPlayer.currentTime - curWs;
    var pctX = Math.max(0, Math.min(100, (rel / dur) * 100));
    vTlPlayhead.style.left = pctX.toFixed(2) + "%";
    if (vCurPos) {
      var rStr = rel >= 0 && rel <= dur ? ("（窗口内 " + rel.toFixed(1) + "s / " + Math.round(dur) + "s）") : "";
      vCurPos.textContent = fmtT(vPlayer.currentTime) + rStr;
    }
  }

  function fmtT(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), x = s % 60;
    return m + ":" + (x < 10 ? "0" : "") + x;
  }
  function closeVideo() {
    stopRaf();
    if (!vModal || !vPlayer) return;
    vPlayer.pause();
    vModal.classList.remove("open");
  }
  function openVideo(btn) {
    if (!vModal || !vPlayer) return;
    var base = VIDEO_BASE;
    if (!base || base.indexOf("__REPORT_" + "VIDEO_BASE__") >= 0) {
      if (window.location && window.location.pathname && window.location.pathname.indexOf("/model-tests/reports/") >= 0) {
        var pn = window.location.pathname;
        base = (pn.charAt(pn.length - 1) === "/" ? pn.slice(0, -1) : pn) + "/video";
      } else {
        alert("当前离线报告未绑定服务端视频链接，请在内网通过「分享链接」打开。");
        return;
      }
    }
    var sid = btn.getAttribute("data-sid");
    curSeek = parseFloat(btn.getAttribute("data-seek") || "0") || 0;
    curWs = parseFloat(btn.getAttribute("data-ws") || "0") || 0;
    curWe = parseFloat(btn.getAttribute("data-we") || "0") || 0;
    if (vTitle) vTitle.textContent = btn.getAttribute("data-title") || "视频验证";
    if (vReason) vReason.textContent = btn.getAttribute("data-reason") || "";
    if (vRange) vRange.textContent = "窗口 " + fmtT(curWs) + " ~ " + fmtT(curWe);
    var verdict = btn.getAttribute("data-verdict") || "";
    var pColor = verdict === "fp" ? "#f59e0b" : "#3b82f6";
    if (vPredDot) vPredDot.style.background = pColor;
    if (vPredLbl) vPredLbl.textContent = verdict === "fp" ? "模型误报(橙)" : verdict === "fn" ? "模型漏报(无预测)" : "模型预测(蓝)";
    var tSegs = [], pSegs = [];
    try { tSegs = JSON.parse(btn.getAttribute("data-tseg") || "[]"); } catch (e) {}
    try { pSegs = JSON.parse(btn.getAttribute("data-pseg") || "[]"); } catch (e) {}
    var durMs = Math.max(1000, (curWe - curWs) * 1000);
    renderVideoTrack(vTlTruth, tSegs, durMs, "#10b981");
    renderVideoTrack(vTlPred, pSegs, durMs, pColor);
    var wsMs = Math.round(curWs * 1000), weMs = Math.round(curWe * 1000);
    drawImuWave([], [], wsMs, weMs, tSegs, pSegs, pColor, "加载真实 IMU Acc-X 波形...");
    var imuBase = base.slice(0, base.lastIndexOf("/video")) + "/imu/" + sid + "?start_ms=" + wsMs + "&end_ms=" + weMs;
    var reqId = ++imuReqSeq;
    fetch(imuBase).then(function(r) { return r.json(); }).then(function(j) {
      if (reqId !== imuReqSeq) return;
      var d = j && j.data ? j.data : j;
      if (d && d.t_ms && d.t_ms.length) {
        drawImuWave(d.t_ms, d.ax, wsMs, weMs, tSegs, pSegs, pColor);
      } else {
        drawImuWave([], [], wsMs, weMs, tSegs, pSegs, pColor, "该窗口暂无 IMU 数据");
      }
    }).catch(function() {
      if (reqId === imuReqSeq) drawImuWave([], [], wsMs, weMs, tSegs, pSegs, pColor, "IMU 波形加载失败");
    });
    var src = base + "/" + sid;
    vModal.classList.add("open");
    if (curSrc !== src) {
      curSrc = src;
      vPlayer.src = src;
      vPlayer.onloadedmetadata = function() {
        vPlayer.currentTime = curSeek;
        vPlayer.play().catch(function(){});
      };
    } else {
      vPlayer.currentTime = curSeek;
      vPlayer.play().catch(function(){});
    }
  }
  document.addEventListener("click", function(e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("btn-play")) openVideo(t);
  });
  if (vPlayer) {
    vPlayer.addEventListener("play", startRaf);
    vPlayer.addEventListener("pause", stopRaf);
    vPlayer.addEventListener("timeupdate", function() {
      syncPlayhead();
      if (vLoop && vLoop.checked && curWe > curWs && vPlayer.currentTime >= curWe) {
        vPlayer.currentTime = curSeek;
      }
    });
  }
  if (vTlBox) {
    vTlBox.addEventListener("click", function(e) {
      if (!vPlayer || curWe <= curWs) return;
      var rect = vTlBox.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      vPlayer.currentTime = curWs + ratio * (curWe - curWs);
      syncPlayhead();
      vPlayer.play().catch(function(){});
    });
  }
  if (vReplay) vReplay.addEventListener("click", function() {
    if (vPlayer) { vPlayer.currentTime = curSeek; vPlayer.play().catch(function(){}); }
  });
  if (vClose) vClose.addEventListener("click", closeVideo);
  if (vModal) vModal.addEventListener("click", function(e) { if (e.target === vModal) closeVideo(); });
  document.addEventListener("keydown", function(e) { if (e.key === "Escape") closeVideo(); });
  spdBtns.forEach(function(b) {
    b.addEventListener("click", function() {
      spdBtns.forEach(function(x) { x.classList.remove("active"); });
      b.classList.add("active");
      if (vPlayer) vPlayer.playbackRate = parseFloat(b.getAttribute("data-spd") || "1") || 1;
    });
  });
})();
</script>
</body>
</html>`;
}
