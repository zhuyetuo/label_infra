import type { VersionResult } from "@/api/modelEval";
import type { Coverage, TestItem, TestSet } from "@/api/modelTests";

export interface ReportEvalRow {
  key: string;
  label?: string;
  group: string;
  n: number;
  version: string;
  r: VersionResult;
}

export interface ReportErrorCase {
  verdict: "fp" | "fn" | "tp" | "tn";
  boundaryBad: boolean;
  dog: string;
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
  items: TestItem[];
  evalLabel: string;
  iouMin: number;
  rows: ReportEvalRow[];
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

function renderMiniTimelineSvg(c: ReportErrorCase): string {
  const dur = Math.max(1, c.winDurMs);
  const segRects = (segs: [number, number, ...unknown[]][], y: number, fill: string) =>
    segs
      .map(([s, e]) => {
        const x = Math.max(0, Math.min(100, (s / dur) * 100));
        const w = Math.max(1.8, Math.min(100 - x, ((e - s) / dur) * 100));
        return `<rect x="${x.toFixed(2)}%" y="${y}" width="${w.toFixed(2)}%" height="6" rx="2" fill="${fill}" />`;
      })
      .join("");
  const predColor = c.verdict === "fp" ? "#fa8c16" : "#1677ff";
  return `<svg width="100%" height="20" style="display:block;min-width:120px">
    <rect x="0" y="2" width="100%" height="6" rx="2" fill="#e5e7eb" />
    ${segRects(c.truthSegs, 2, "#22c55e")}
    <rect x="0" y="12" width="100%" height="6" rx="2" fill="#e5e7eb" />
    ${segRects(c.predSegs, 12, predColor)}
  </svg>`;
}

/** 生成独立可离线打开、可打印 PDF、也可分享链接的标准 HTML 算法测试报告 */
export function buildTestReportHtml(input: TestReportInput): string {
  const {
    testSet, coverage, items, evalLabel, iouMin, rows, activeRow, errorCases, summaryCounts, reporter,
  } = input;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const genTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
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
  const sitesMap = coverage?.sites ?? {};
  const sitesTxt = Object.entries(sitesMap).map(([k, v]) => `${k} ${v}段`).join(" / ") || "-";

  // 归因汇总
  const fnReasons = new Map<string, number>();
  const fpReasons = new Map<string, number>();
  for (const c of errorCases) {
    if (c.verdict === "fn") fnReasons.set(c.tag, (fnReasons.get(c.tag) ?? 0) + 1);
    if (c.verdict === "fp") fpReasons.set(c.tag, (fpReasons.get(c.tag) ?? 0) + 1);
  }

  // 自动生成结论摘要
  const conclusionLines: string[] = [];
  if (primary && pw && pr) {
    const wf1 = pw.f1 != null ? (pw.f1 * 100).toFixed(1) : "-";
    const wacc = (pw.accuracy * 100).toFixed(1);
    conclusionLines.push(
      `主测模型 <b>${esc(primary.version)}</b>（范围：${esc(primary.group)}）在「${esc(labelTitle)}」上的<strong>窗口级准确率 ${wacc}%、F1 ${wf1}%</strong>（精确率 ${pct(pw.precision)} / 召回率 ${pct(pw.recall)}，${pw.tp + pw.tn} 对 / ${pw.fp} 误 / ${pw.fn} 漏）。`,
    );
    conclusionLines.push(
      `<strong>事件（片段）级（IoU ≥ ${iouPct}%）F1 ${pct(evF1)}</strong>（精确率 ${pct(pr.precision)} / 召回率 ${pct(pr.recall)}，命中 ${pr.tp} / 误报 ${pr.fp} / 漏报 ${pr.fn}）；命中事件平均 IoU <b>${pct(pr.mean_iou)}</b>，±2s 边界对齐率 <b>${pct(pr.within_2s_ratio)}</b>。`,
    );
  }
  if (fpReasons.size > 0 || fnReasons.size > 0) {
    const topFp = [...fpReasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join("、");
    const topFn = [...fnReasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join("、");
    conclusionLines.push(
      `错例主因：${topFp ? `误报主要集中在 <b>${esc(topFp)}</b>` : "无误报"}${topFn ? `；漏报主要集中在 <b>${esc(topFn)}</b>` : "；无漏报"}。`,
    );
  }

  // 通过率堆叠条百分比
  const sc = summaryCounts;
  const denom = Math.max(1, sc.total);
  const segTn = (sc.tn / denom) * 100;
  const segTpClean = (Math.max(0, sc.tp - sc.boundaryBad) / denom) * 100;
  const segBd = (sc.boundaryBad / denom) * 100;
  const segFp = (sc.fp / denom) * 100;
  const segFn = (sc.fn / denom) * 100;

  // 多模型对比表行
  const showLabelCol = evalLabel === "ALL";
  const rowsHtml = rows
    .map((x) => {
      const w = x.r.window;
      const eF1 = f1(x.r.precision, x.r.recall);
      const isAct = primary && x.key === primary.key;
      const errDiff = x.r.d_start_abs_mean_ms != null && x.r.d_end_abs_mean_ms != null
        ? `${(x.r.d_start_abs_mean_ms / 1000).toFixed(1)}s / ${(x.r.d_end_abs_mean_ms / 1000).toFixed(1)}s`
        : "-";
      return `<tr class="${isAct ? "row-primary" : ""}">
        ${showLabelCol ? `<td><span class="pill pill-gray">${esc(x.label ?? "-")}</span></td>` : ""}
        <td>${esc(x.group)}</td>
        <td class="mono-sm"><b>${esc(x.version)}</b></td>
        <td class="col-w">${w ? w.n_windows : "-"}</td>
        <td class="col-w">${w ? pct(w.accuracy) : "-"}</td>
        <td class="col-w">${w ? pct(w.precision) : "-"}</td>
        <td class="col-w">${w ? pct(w.recall) : "-"}</td>
        <td class="col-w"><b>${w ? pct(w.f1) : "-"}</b></td>
        <td class="col-w">${w ? `<span class="c-green">${w.tp + w.tn}对</span> / <span class="c-orange">${w.fp}误</span> / <span class="c-red">${w.fn}漏</span>` : "-"}</td>
        <td class="col-e">${pct(x.r.precision)}</td>
        <td class="col-e">${pct(x.r.recall)}</td>
        <td class="col-e"><b>${pct(eF1)}</b></td>
        <td class="col-e"><span class="c-green">${x.r.tp}对</span> / <span class="c-orange">${x.r.fp}误</span> / <span class="c-red">${x.r.fn}漏</span></td>
        <td class="col-b">${pct(x.r.mean_iou)}</td>
        <td class="col-b"><b>${pct(x.r.within_2s_ratio)}</b></td>
        <td class="col-b">${errDiff}</td>
        <td>${x.r.n_samples_with_result}/${x.n}</td>
      </tr>`;
    })
    .join("");

  // 狗分布条形图
  const dogsArr = [...(coverage?.dogs ?? [])].sort((a, b) => b.share - a.share);
  const maxShare = Math.max(0.2, ...dogsArr.map((d) => d.share));
  const dogsHtml = dogsArr
    .map((d) => {
      const bw = Math.max(3, Math.round((d.share / maxShare) * 100));
      return `<div class="bar-row">
        <span class="bar-name">${esc(d.dog ?? "未知")}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${bw}%;background:${d.share > 0.2 ? "#f59e0b" : "#3b82f6"}"></div></div>
        <span class="bar-val">${(d.share * 100).toFixed(1)}% · ${fmtSec(d.sec)}</span>
      </div>`;
    })
    .join("");

  // 时长 × 有/无分布
  const durEntries = Object.entries(coverage?.by_dur ?? {});
  const maxDur = Math.max(1, ...durEntries.map(([, m]) => (m["有抓挠"] ?? 0) + (m["无抓挠"] ?? 0)));
  const durHtml = durEntries
    .map(([dur, m]) => {
      const y = m["有抓挠"] ?? 0;
      const n = m["无抓挠"] ?? 0;
      const tot = y + n;
      const wPct = Math.max(6, Math.round((tot / maxDur) * 100));
      const yPct = tot > 0 ? Math.round((y / tot) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-name">${esc(dur)}</span>
        <div class="bar-track">
          <div style="width:${wPct}%;height:100%;display:flex;border-radius:4px;overflow:hidden">
            ${y > 0 ? `<div style="width:${yPct}%;background:#22c55e;color:#fff;font-size:10px;text-align:center;line-height:16px">${y}</div>` : ""}
            ${n > 0 ? `<div style="width:${100 - yPct}%;background:#64748b;color:#fff;font-size:10px;text-align:center;line-height:16px">${n}</div>` : ""}
          </div>
        </div>
        <span class="bar-val">共 ${tot} 段</span>
      </div>`;
    })
    .join("");

  // 错例明细行（支持前端一键筛选）
  const caseRowsHtml = errorCases
    .map((c) => {
      const kind = c.verdict === "fp" ? "fp" : c.verdict === "fn" ? "fn" : c.boundaryBad ? "bd" : "ok";
      const badge =
        c.verdict === "fp"
          ? `<span class="pill pill-orange">误报</span>`
          : c.verdict === "fn"
            ? `<span class="pill pill-red">漏报</span>`
            : c.boundaryBad
              ? `<span class="pill pill-purple">偏差&gt;2s</span>`
              : `<span class="pill pill-green">命中</span>`;
      const labelsHtml = c.actualLabels.length
        ? c.actualLabels.map((lb) => `<span class="pill pill-gray">${esc(lb)}</span>`).join(" ")
        : `<span class="muted">无标注</span>`;
      return `<tr class="case-row" data-kind="${kind}">
        <td>${badge}</td>
        <td><b>${esc(c.dog)}</b>${c.size ? `（${esc(c.size)}）` : ""}<div class="sub">${esc(c.site)}</div></td>
        <td class="mono-sm">${esc(c.winText)}<div class="sub">${esc(c.durText)}</div></td>
        <td>
          ${renderMiniTimelineSvg(c)}
          <div class="sub">标 ${c.truthN} / 预 ${c.predN}${c.maxConf != null ? ` · 置信 ${c.maxConf}` : ""}${c.minIou != null ? ` · IoU ${(c.minIou * 100).toFixed(0)}%` : ""}</div>
        </td>
        <td>
          <div><span class="pill ${c.verdict === "fn" ? "pill-red" : "pill-orange"}">${esc(c.tag)}</span></div>
          <div class="reason">${esc(c.reason)}</div>
          ${c.advice ? `<div class="advice">→ ${esc(c.advice)}</div>` : ""}
        </td>
        <td>${labelsHtml}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>模型测试报告 · ${esc(testSet.name)} · ${esc(labelTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    background: #f5f7fb; color: #1f2937; font-size: 13px; line-height: 1.55;
  }
  .page { max-width: 1180px; margin: 0 auto; }
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #312e81 100%);
    color: #fff; border-radius: 12px; padding: 22px 26px; margin-bottom: 18px;
    display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 14px;
  }
  .header h1 { margin: 0 0 6px; font-size: 21px; font-weight: 700; letter-spacing: 0.3px; }
  .header .meta { font-size: 12px; color: rgba(255,255,255,0.82); display: flex; flex-wrap: wrap; gap: 12px; }
  .header .note { margin-top: 8px; font-size: 12px; color: rgba(255,255,255,0.75); }
  .header .actions { display: flex; gap: 8px; }
  .btn-print {
    background: rgba(255,255,255,0.16); color: #fff; border: 1px solid rgba(255,255,255,0.3);
    border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  }
  .btn-print:hover { background: rgba(255,255,255,0.26); }

  .section {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  }
  .section-title {
    font-size: 15px; font-weight: 700; color: #111827; margin: 0 0 12px;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .section-title .sub { font-size: 12px; font-weight: 400; color: #6b7280; }

  .summary-box {
    background: #f8fafc; border-left: 4px solid #4f46e5; border-radius: 6px;
    padding: 10px 14px; margin-bottom: 14px; font-size: 13px;
  }
  .summary-box div { margin: 3px 0; }

  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .kpi {
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; background: #fafafa;
  }
  .kpi .k-label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
  .kpi .k-val { font-size: 24px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .kpi .k-sub { font-size: 11px; color: #6b7280; margin-top: 4px; }
  .kpi.blue { border-top: 3px solid #2563eb; }
  .kpi.purple { border-top: 3px solid #7c3aed; }
  .kpi.teal { border-top: 3px solid #0d9488; }
  .kpi.slate { border-top: 3px solid #475569; }

  .stack-bar { height: 12px; border-radius: 6px; overflow: hidden; display: flex; background: #e5e7eb; margin: 8px 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #4b5563; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 7px 8px; border: 1px solid #e5e7eb; text-align: left; vertical-align: middle; }
  th { background: #f8fafc; font-weight: 600; color: #374151; white-space: nowrap; }
  .th-w { background: #eff6ff; color: #1d4ed8; text-align: center; }
  .th-e { background: #f5f3ff; color: #6d28d9; text-align: center; }
  .th-b { background: #f0fdfa; color: #0f766e; text-align: center; }
  .col-w { background: #fafcff; font-variant-numeric: tabular-nums; }
  .col-e { background: #fcfaff; font-variant-numeric: tabular-nums; }
  .col-b { background: #f8fffe; font-variant-numeric: tabular-nums; }
  .row-primary td { font-weight: 500; }

  .c-green { color: #16a34a; font-weight: 600; }
  .c-orange { color: #d97706; font-weight: 600; }
  .c-red { color: #dc2626; font-weight: 600; }
  .muted, .sub { color: #6b7280; font-size: 11px; }
  .mono-sm { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 500;
    margin: 1px 2px 1px 0; white-space: nowrap;
  }
  .pill-green { background: #dcfce7; color: #15803d; }
  .pill-orange { background: #fef3c7; color: #b45309; }
  .pill-red { background: #fee2e2; color: #b91c1c; }
  .pill-purple { background: #ede9fe; color: #6d28d9; }
  .pill-gray { background: #f3f4f6; color: #374151; }

  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 12px; }
  .bar-name { width: 72px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #374151; }
  .bar-track { flex: 1; height: 16px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .bar-val { width: 96px; flex: none; text-align: right; color: #4b5563; font-variant-numeric: tabular-nums; font-size: 11px; }

  .filter-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .f-btn {
    border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .f-btn.active { background: #1e293b; color: #fff; border-color: #1e293b; }
  .reason { margin-top: 3px; color: #374151; }
  .advice { margin-top: 2px; color: #2563eb; font-size: 11px; }

  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 20px; }
  .table-wrap { overflow-x: auto; }

  @media print {
    body { background: #fff; padding: 0; }
    .btn-print, .filter-bar { display: none !important; }
    .section { box-shadow: none; break-inside: avoid; }
    .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <h1>犬行为算法模型测试报告 · ${esc(testSet.name)}</h1>
      <div class="meta">
        <span>评测类别：<b>${esc(labelTitle)}</b></span>
        <span>事件命中阈值：<b>IoU ≥ ${iouPct}%</b></span>
        <span>测试规模：<b>${nTotal} 段</b>（${testSet.n_samples} 样本 · ${fmtSec(totalSec)} · ${nDogs} 只狗）</span>
        <span>核对完成：<b>${nChecked}/${nTotal}</b></span>
        ${testSet.n_unseen != null ? `<span>数据隔离：<b>没见过 ${testSet.n_unseen} / 见过 ${testSet.n_seen ?? 0}</b></span>` : ""}
      </div>
      ${testSet.note ? `<div class="note">测试集说明：${esc(testSet.note)}</div>` : ""}
      <div class="note">生成时间：${esc(genTime)}${reporter ? ` · 报告人：${esc(reporter)}` : ""}${testSet.creator_name ? ` · 测试集创建人：${esc(testSet.creator_name)}` : ""}</div>
    </div>
    <div class="actions">
      <button class="btn-print" onclick="window.print()">打印 / 另存 PDF</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">
      <span>一、核心结论与指标总览</span>
      <span class="sub">${primary ? `主展示模型：${esc(primary.version)}（${esc(primary.group)}）` : ""}</span>
    </div>
    ${conclusionLines.length ? `<div class="summary-box">${conclusionLines.map((l) => `<div>• ${l}</div>`).join("")}</div>` : ""}
    <div class="kpi-grid">
      <div class="kpi blue">
        <div class="k-label">窗口级 F1（整段有无）</div>
        <div class="k-val" style="color:#2563eb">${pw ? pct(pw.f1) : "-"}</div>
        <div class="k-sub">准确率 ${pw ? pct(pw.accuracy) : "-"} · 精确 ${pw ? pct(pw.precision) : "-"} · 召回 ${pw ? pct(pw.recall) : "-"}</div>
      </div>
      <div class="kpi purple">
        <div class="k-label">事件（片段）级 F1（IoU ≥ ${iouPct}%）</div>
        <div class="k-val" style="color:#7c3aed">${pct(evF1)}</div>
        <div class="k-sub">精确 ${pct(pr?.precision)} · 召回 ${pct(pr?.recall)} · 命中 ${pr?.tp ?? 0} / 误 ${pr?.fp ?? 0} / 漏 ${pr?.fn ?? 0}</div>
      </div>
      <div class="kpi teal">
        <div class="k-label">起止时间对齐（命中事件）</div>
        <div class="k-val" style="color:#0d9488">${pct(pr?.mean_iou)}</div>
        <div class="k-sub">平均 IoU · ±2s 对齐率 ${pct(pr?.within_2s_ratio)}</div>
      </div>
      <div class="kpi slate">
        <div class="k-label">测试窗口通过情况</div>
        <div class="k-val">${sc.total - sc.err} <span style="font-size:14px;font-weight:400;color:#6b7280">/ ${sc.total}</span></div>
        <div class="k-sub">正常通过 ${sc.tn} · 命中 ${sc.tp} · 误报 ${sc.fp} · 漏报 ${sc.fn}</div>
      </div>
    </div>
    <div class="stack-bar">
      <div style="width:${segTn.toFixed(2)}%;background:#22c55e" title="正常通过（无动作没乱报）${sc.tn}"></div>
      <div style="width:${segTpClean.toFixed(2)}%;background:#3b82f6" title="准确命中 ${Math.max(0, sc.tp - sc.boundaryBad)}"></div>
      <div style="width:${segBd.toFixed(2)}%;background:#8b5cf6" title="命中但起止偏差>2s ${sc.boundaryBad}"></div>
      <div style="width:${segFp.toFixed(2)}%;background:#f59e0b" title="误报窗口 ${sc.fp}"></div>
      <div style="width:${segFn.toFixed(2)}%;background:#ef4444" title="漏报窗口 ${sc.fn}"></div>
    </div>
    <div class="legend">
      <span><i class="dot" style="background:#22c55e"></i>正常通过 ${sc.tn}</span>
      <span><i class="dot" style="background:#3b82f6"></i>精准命中 ${Math.max(0, sc.tp - sc.boundaryBad)}</span>
      <span><i class="dot" style="background:#8b5cf6"></i>起止偏差&gt;2s ${sc.boundaryBad}</span>
      <span><i class="dot" style="background:#f59e0b"></i>误报窗口 ${sc.fp}</span>
      <span><i class="dot" style="background:#ef4444"></i>漏报窗口 ${sc.fn}</span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">
      <span>二、模型指标明细表</span>
      <span class="sub">共 ${rows.length} 条评测记录</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${showLabelCol ? `<th rowspan="2">类别</th>` : ""}
            <th rowspan="2">范围</th>
            <th rowspan="2">模型版本</th>
            <th colspan="6" class="th-w">● 窗口级（整段有无）</th>
            <th colspan="4" class="th-e">● 事件（片段）级（IoU ≥ ${iouPct}%）</th>
            <th colspan="3" class="th-b">● 起止对齐（命中事件）</th>
            <th rowspan="2">样本</th>
          </tr>
          <tr>
            <th class="th-w">窗口</th><th class="th-w">准确率</th><th class="th-w">精确率</th><th class="th-w">召回率</th><th class="th-w">F1</th><th class="th-w">明细</th>
            <th class="th-e">精确率</th><th class="th-e">召回率</th><th class="th-e">F1</th><th class="th-e">明细</th>
            <th class="th-b">平均 IoU</th><th class="th-b">±2s 对齐</th><th class="th-b">起/止均差</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || `<tr><td colspan="17" style="text-align:center;color:#999">暂无打分数据</td></tr>`}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">
      <span>三、测试集构成与覆盖度</span>
      <span class="sub">场地：${esc(sitesTxt)}</span>
    </div>
    <div class="two-col">
      <div>
        <div style="font-weight:600;margin-bottom:8px;font-size:13px">各狗时长占比（共 ${nDogs} 只）</div>
        ${dogsHtml || `<div class="muted">暂无分布数据</div>`}
      </div>
      <div>
        <div style="font-weight:600;margin-bottom:8px;font-size:13px">窗口时长 × 有/无目标动作（绿=有，灰=无）</div>
        ${durHtml || `<div class="muted">暂无时长分布数据</div>`}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">
      <span>四、错例归因与明细（${errorCases.length} 条异常/偏差窗口）</span>
      <span class="sub">绿轨 = 人工标注 · 橙/蓝轨 = 模型预测</span>
    </div>
    <div style="margin-bottom:10px">
      ${[...fnReasons.entries()].map(([k, v]) => `<span class="pill pill-red">漏报 · ${esc(k)} × ${v}</span>`).join("")}
      ${[...fpReasons.entries()].map(([k, v]) => `<span class="pill pill-orange">误报 · ${esc(k)} × ${v}</span>`).join("")}
    </div>
    <div class="filter-bar">
      <button class="f-btn active" onclick="filterCases('err', this)">全部错误（${sc.err}）</button>
      <button class="f-btn" onclick="filterCases('fp', this)">仅误报（${sc.fp}）</button>
      <button class="f-btn" onclick="filterCases('fn', this)">仅漏报（${sc.fn}）</button>
      <button class="f-btn" onclick="filterCases('bd', this)">起止偏差 &gt;2s（${sc.boundaryBad}）</button>
      <button class="f-btn" onclick="filterCases('all', this)">显示全部列表（${errorCases.length}）</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:74px">结果</th>
            <th style="width:120px">狗 / 场地</th>
            <th style="width:110px">窗口</th>
            <th style="width:170px">标注 vs 预测</th>
            <th>自动归因与调优方向</th>
            <th style="width:180px">窗口内实际动作</th>
          </tr>
        </thead>
        <tbody id="case-tbody">
          ${caseRowsHtml || `<tr><td colspan="6" style="text-align:center;color:#999">本次测试无误报/漏报记录 🎉</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer">
    由 smart-label 模型评测系统自动生成 · ${esc(genTime)}
  </div>
</div>
<script>
function filterCases(mode, btn) {
  document.querySelectorAll('.f-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  document.querySelectorAll('#case-tbody tr.case-row').forEach(function(tr){
    var k = tr.getAttribute('data-kind');
    var show = mode === 'all'
      || (mode === 'err' && (k === 'fp' || k === 'fn'))
      || (mode === k);
    tr.style.display = show ? '' : 'none';
  });
}
filterCases('err', document.querySelector('.f-btn.active'));
</script>
</body>
</html>`;
}
