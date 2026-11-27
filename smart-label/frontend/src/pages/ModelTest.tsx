/**
 * 模型测试：管测试集（挑数据、看配额够不够、哪个模型见过）、拿测试集给模型打分、几批测试集交叉对比。
 *
 * 规矩（后端守着）：测试集里的样本不进任何训练导出；冻结后不能增删，补数据复制成新版本。
 * 打分复用「模型对比」那套（/model-eval）：按整个样本、按事件配对算精确率 / 召回率。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert, Button, Checkbox, Collapse, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Popover, Progress, Radio, Segmented, Select, Slider, Space, Table, Tabs, Tag, Tooltip, TreeSelect, Typography, message,
} from "antd";
import type { Dayjs } from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addTestItems, batchPromoteTestItems, batchRemoveTestItems, checkAllTestItems, checkTestItem, composeApply, composePreview, copyTestSet, createTestSet, dedupeTestSet, deleteTestItem, deleteTestSet, freezeTestSet, getEvalCache, getLabelTree, mergeAdjacentTestSet, promoteTestItemToPool, publishTestReport, saveEvalCache, updateTestSet,
  getTaskSegments, getTestItems, getTestSeen, listTestSets,
  type ComposeBody, type ComposeStats, type Coverage, type TaskSeg, type TestItem, type TestSet,
} from "@/api/modelTests";
import { listDogs } from "@/api/dogs";
import { CopyOutlined, DownloadOutlined, ExportOutlined, PlusOutlined, QuestionCircleOutlined, SettingOutlined, ShareAltOutlined } from "@ant-design/icons";
import { buildTestReportHtml, type ReportErrorCase, type TestReportInput } from "@/utils/testReportHtml";
import { analyzeIouAndEdge, recomputeVersionAt } from "@/utils/evalMetrics";
import ModelTestPlan from "@/components/ModelTestPlan";
import { listProjects } from "@/api/projects";
import { claimTask, editAgain, getTask, listTasks } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace, { type EvalWindowHint } from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import type { LabelDefinition } from "@/types";
import { listModelVersions, type ModelVersion } from "@/api/training";
import { compareModels, deleteTestSetEvalRun, getEvalRunProgress, listEvalRuns, startEvalRun, type VersionResult, type WindowDetail } from "@/api/modelEval";
import { useInferModes } from "@/hooks/useInferModes";
import { INFER_MODE_LABEL, isSrvMode, modeLabelOf, srvPostOf } from "@/utils/inferMode";
import { TaskStatusTag } from "@/utils/taskStatus";
import type { Task, TaskStatus } from "@/types";

const TOPS = ["抓挠", "活动", "静止/休息", "未佩戴"];
/** 「标了什么」的标签：实心色块、加粗，一眼看得出是哪类 */
const TAG_SOLID = { fontWeight: 600, fontSize: 13, padding: "2px 8px", borderRadius: 6, marginInlineEnd: 0 } as const;
const SIZES = ["小", "中", "大"];
const EVAL_LABELS = ["抓挠", "活动", "静止/休息", "未佩戴"];
const LABEL_ORDER = ["抓挠", "甩头/抖身", "活动", "静止/休息", "未佩戴", "舔", "啃", "蹭", "进食", "饮水", "吠叫"];

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`;
};
const fmtSec = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`);
/** 「1:30」「90」「1:02:03」→ 毫秒；空 → null；认不出 → NaN */
const parseTime = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0) * 1000;
};
/** 测试片段 → 打分用的时间窗口（只要 sampleIds 里的） */
const windowsOf = (items: TestItem[], sampleIds: number[]) => {
  const keep = new Set(sampleIds);
  return items.filter((i) => keep.has(i.sample_id) && i.end_ms > i.start_ms)
    .map((i) => ({ sample_id: i.sample_id, start_ms: i.start_ms, end_ms: i.end_ms }));
};
/** 正确答案只取测试集自己的任务（同一个样本在别的项目里还有预标 / 别人标的） */
const taskIdsOf = (items: TestItem[], sampleIds: number[]) => {
  const keep = new Set(sampleIds);
  return Array.from(new Set(items.filter((i) => keep.has(i.sample_id)).map((i) => i.task_id)));
};
const f1 = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
/** 「srv:train60」之类 → 训练记录的 algo_job_id；默认在线模型之类认不出就 null（见没见过不知道） */
const jobIdOfTag = (tag: string): number | null => {
  const m = /train(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
};

/** 把算法服务内部的 train<任务号> 对回平台「训练记录 #N」，两边编号不一致时同时注明避免找不到 */
const formatEvalVersion = (modelTag: string, mode: string, mvByJob?: Map<number, ModelVersion>): string => {
  const jobId = jobIdOfTag(`${modelTag}::${mode}`);
  const mv = jobId != null ? mvByJob?.get(jobId) : undefined;
  if (mv) {
    const post = isSrvMode(mode)
      ? (INFER_MODE_LABEL[srvPostOf(mode)] ?? srvPostOf(mode))
      : modeLabelOf(mode);
    return `训练记录 #${mv.id}（train${mv.algo_job_id}）· ${post}`;
  }
  return `${modelTag} · ${modeLabelOf(mode)}`;
};

type OpenTaskOpts = {
  winStartMs?: number;
  winEndMs?: number;
  itemId?: number;
  loopRange?: { startMs: number; endMs: number };
  evalHint?: EvalWindowHint;
};

// ───────────────────────── 配额表 ─────────────────────────
function CoverageView({ cov }: { cov: Coverage }) {
  const sizes = Object.keys(cov.matrix);
  const nChecked = cov.n_checked ?? 0;
  const checkPct = cov.n_items > 0 ? Math.round((nChecked / cov.n_items) * 100) : 0;
  const nDays = Object.keys(cov.dates ?? {}).length;

  // 归并同类提示，压成一行紧凑胶囊（不再占满半屏）
  const dogShareWarns: string[] = [];
  const otherWarns: string[] = [];
  for (const w of cov.warnings ?? []) {
    if (w.includes("占总时长") && w.includes("超过")) dogShareWarns.push(w);
    else otherWarns.push(w);
  }

  // 汇总抓挠总事件数与时长
  let scratchEvents = 0;
  let scratchSec = 0;
  for (const sz of sizes) {
    const cell = cov.matrix[sz]?.["抓挠"] as { items: number; n: number; sec: number } | undefined;
    if (cell) {
      scratchEvents += cell.n ?? 0;
      scratchSec += cell.sec ?? 0;
    }
  }

  // 每列最大事件数（用于热力进度条归一化；抓挠以 100 次为满条参考）
  const colMax: Record<string, number> = {};
  for (const tp of TOPS) {
    let m = tp === "抓挠" ? 100 : 1;
    for (const sz of sizes) {
      const c = cov.matrix[sz]?.[tp] as { n?: number } | undefined;
      if (c?.n && c.n > m) m = c.n;
    }
    colMax[tp] = m;
  }

  const TOP_COLOR: Record<string, string> = {
    抓挠: "#52c41a",
    活动: "#faad14",
    "静止/休息": "#4096ff",
    未佩戴: "#8c8c8c",
  };

  const durRows = Object.entries(cov.by_dur ?? {}).map(([dur, m]) => ({
    dur,
    yes: m["有抓挠"] ?? 0,
    no: m["无抓挠"] ?? 0,
    total: (m["有抓挠"] ?? 0) + (m["无抓挠"] ?? 0),
  }));
  const maxDurTotal = Math.max(1, ...durRows.map((r) => r.total));

  const sortedDogs = [...(cov.dogs ?? [])].sort((a, b) => b.share - a.share);
  const maxDogShare = Math.max(0.2, ...sortedDogs.map((d) => d.share));

  const leafEntries = Object.entries(cov.leaf ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const maxLeaf = Math.max(1, ...leafEntries.map(([, n]) => n));

  const cardStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: 8,
    padding: "10px 14px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 1. 顶部一行紧凑提醒条（同类归并，悬停看详情） */}
      {(dogShareWarns.length > 0 || otherWarns.length > 0) && (
        <div style={{
          display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8,
          padding: "6px 12px", borderRadius: 6,
          background: "rgba(250, 173, 20, 0.08)", border: "1px solid rgba(250, 173, 20, 0.28)",
          fontSize: 12,
        }}>
          <span style={{ color: "#faad14", fontWeight: 600 }}>体检提醒</span>
          {dogShareWarns.length > 0 && (
            <Popover
              placement="bottomLeft"
              content={
                <div style={{ maxWidth: 320, fontSize: 12, lineHeight: 1.7 }}>
                  {dogShareWarns.map((w) => <div key={w}>• {w}</div>)}
                  <div style={{ color: "#888", marginTop: 4 }}>单只狗占比过高会让测试分偏向那只狗；狗数较少（如 6 只平均约 17%）时属正常现象。</div>
                </div>
              }
            >
              <Tag color="warning" style={{ marginInlineEnd: 0, cursor: "pointer" }}>
                {dogShareWarns.length} 只狗占比 &gt;15%（悬停看明细）
              </Tag>
            </Popover>
          )}
          {otherWarns.map((w) => {
            const short = w.includes("：") ? w.split("：")[0] : (w.length > 26 ? `${w.slice(0, 26)}…` : w);
            return (
              <Tooltip key={w} title={w}>
                <Tag color="orange" style={{ marginInlineEnd: 0, cursor: "help" }}>{short}</Tag>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* 2. 顶部 5 张简约 KPI 卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))", gap: 10 }}>
        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: "#888" }}>总段数 / 长短分布</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>{cov.n_items} <span style={{ fontSize: 12, fontWeight: 400, color: "#888" }}>段</span></div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, fontSize: 11, color: "#aaa" }}>
            {Object.entries(cov.kinds ?? {}).map(([k, n]) => (
              <span key={k}>{k.replace("片段", "")} <b style={{ color: "#ddd" }}>{n}</b></span>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: "#888" }}>总时长 / 跨度</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>{fmtSec(cov.total_sec)}</div>
          <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>覆盖 <b style={{ color: "#ddd" }}>{nDays}</b> 天数据</div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888" }}>
            <span>人工核对进度</span>
            <span style={{ color: checkPct === 100 ? "#52c41a" : "#faad14", fontWeight: 600 }}>{checkPct}%</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>
            {nChecked} <span style={{ fontSize: 12, fontWeight: 400, color: "#888" }}>/ {cov.n_items}</span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden", marginTop: 6 }}>
            <div style={{ width: `${checkPct}%`, height: "100%", background: checkPct === 100 ? "#52c41a" : "#1677ff" }} />
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: "#888" }}>抓挠事件量（核心评测）</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginTop: 2, color: "#52c41a" }}>
            {scratchEvents} <span style={{ fontSize: 12, fontWeight: 400, color: "#888" }}>次</span>
          </div>
          <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>累计 <b style={{ color: "#ddd" }}>{fmtSec(scratchSec)}</b></div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 11, color: "#888" }}>狗数 / 场地</div>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3, marginTop: 2 }}>{cov.n_dogs} <span style={{ fontSize: 12, fontWeight: 400, color: "#888" }}>只狗</span></div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            {Object.entries(cov.sites ?? {}).map(([k, n]) => (
              <Tag key={k} color="blue" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "16px", padding: "0 5px" }}>
                {k.replace("狗场", "")} {n}
              </Tag>
            ))}
          </div>
        </div>
      </div>

      {/* 3. 体型 × 类别 热力矩阵 */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Space size={6}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>体型 × 类别 覆盖矩阵</span>
            <Tooltip title="数事件数而非段数：抓挠每种体型 30 次左右召回率误差约 ±15%，100 次左右稳到 ±8%。红色「缺」表示该体型缺少该类别样本。">
              <QuestionCircleOutlined style={{ color: "#888", fontSize: 12, cursor: "help" }} />
            </Tooltip>
          </Space>
          <span style={{ fontSize: 11, color: "#888" }}>进度条：抓挠以 100 次为满格，其余按同列最高归一化</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `64px repeat(${TOPS.length}, minmax(130px, 1fr))`, gap: 6, alignItems: "stretch" }}>
          <div style={{ fontSize: 11, color: "#888", padding: "4px 6px" }}>体型</div>
          {TOPS.map((tp) => (
            <div key={tp} style={{ fontSize: 12, fontWeight: 600, padding: "4px 8px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: TOP_COLOR[tp] ?? "#888" }} />
              {tp}
            </div>
          ))}
          {sizes.map((sz) => (
            <div key={sz} style={{ display: "contents" }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 600, fontSize: 13, background: "rgba(255,255,255,0.02)", borderRadius: 6,
              }}>
                {sz}型
              </div>
              {TOPS.map((tp) => {
                const c = (cov.matrix[sz]?.[tp] ?? { items: 0, n: 0, sec: 0 }) as { items: number; n: number; sec: number };
                const clr = TOP_COLOR[tp] ?? "#1677ff";
                if (!c.items) {
                  return (
                    <div key={`${sz}-${tp}`} style={{
                      padding: "8px 10px", borderRadius: 6,
                      background: "rgba(255, 77, 79, 0.06)", border: "1px dashed rgba(255, 77, 79, 0.25)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Tag color="error" style={{ marginInlineEnd: 0, fontSize: 11 }}>缺</Tag>
                    </div>
                  );
                }
                const ratio = Math.min(1, c.n / colMax[tp]);
                return (
                  <Tooltip key={`${sz}-${tp}`} title={`${sz}型 · ${tp}：${c.n} 次事件，累计 ${fmtSec(c.sec)}，分布在 ${c.items} 段窗口`}>
                    <div style={{
                      padding: "7px 10px", borderRadius: 6,
                      background: `color-mix(in srgb, ${clr} ${Math.round(5 + ratio * 12)}%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${clr} 24%, transparent)`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{c.n} <span style={{ fontSize: 11, fontWeight: 400, color: "#aaa" }}>次</span></span>
                        <span style={{ fontSize: 11, color: "#aaa", fontVariantNumeric: "tabular-nums" }}>{fmtSec(c.sec)} · {c.items}段</span>
                      </div>
                      <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden", marginTop: 5 }}>
                        <div style={{ width: `${Math.max(4, Math.round(ratio * 100))}%`, height: "100%", background: clr }} />
                      </div>
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* 4. 下方双栏：左「时长 × 有/无抓挠」双向条形图，右「各狗时长占比」条形图 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12 }}>
        {durRows.length > 0 && (
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>时长 × 有/无抓挠</span>
              <Space size={10} style={{ fontSize: 11, color: "#aaa" }}>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#52c41a", marginRight: 4 }} />有抓挠</span>
                <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#4a6fa5", marginRight: 4 }} />无抓挠</span>
              </Space>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {durRows.map((r) => {
                const wPct = Math.round((r.total / maxDurTotal) * 100);
                const yPct = r.total > 0 ? Math.round((r.yes / r.total) * 100) : 0;
                return (
                  <div key={r.dur} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 54, flex: "none", color: "#ccc" }}>{r.dur}</span>
                    <div style={{ flex: 1, height: 18, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${Math.max(6, wPct)}%`, height: "100%", display: "flex" }}>
                        {r.yes > 0 && (
                          <Tooltip title={`${r.dur} · 有抓挠：${r.yes} 段（${yPct}%）`}>
                            <div style={{
                              width: `${yPct}%`, background: "#52c41a", color: "#fff", fontSize: 11,
                              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                            }}>{r.yes}</div>
                          </Tooltip>
                        )}
                        {r.no > 0 && (
                          <Tooltip title={`${r.dur} · 无抓挠：${r.no} 段（${100 - yPct}%）`}>
                            <div style={{
                              width: `${100 - yPct}%`, background: "#4a6fa5", color: "#fff", fontSize: 11,
                              display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                            }}>{r.no}</div>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    <span style={{ width: 42, textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{r.total}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>各狗时长占比</span>
            <span style={{ fontSize: 11, color: "#888" }}>警戒线 15%（橙色偏重）</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, position: "relative" }}>
            {sortedDogs.map((d) => {
              const barPct = Math.round((d.share / maxDogShare) * 100);
              const linePct = Math.round((0.15 / maxDogShare) * 100);
              const over = d.share > 0.15;
              return (
                <div key={`${d.site}-${d.dog}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <Tooltip title={`${d.site ?? "未知"} · ${d.dog ?? "未知"}`}>
                    <span style={{ width: 64, flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#ddd" }}>
                      {d.dog ?? "未知"}
                    </span>
                  </Tooltip>
                  <div style={{ flex: 1, height: 14, background: "rgba(255,255,255,0.05)", borderRadius: 4, position: "relative", overflow: "hidden" }}>
                    <div style={{
                      width: `${Math.max(2, barPct)}%`, height: "100%",
                      background: over ? "#faad14" : "#1677ff", borderRadius: 4,
                    }} />
                    <div style={{
                      position: "absolute", left: `${linePct}%`, top: 0, bottom: 0,
                      borderLeft: "1px dashed rgba(255, 77, 79, 0.7)",
                    }} />
                  </div>
                  <span style={{ width: 44, textAlign: "right", color: over ? "#faad14" : "#ccc", fontWeight: over ? 600 : 400, fontVariantNumeric: "tabular-nums" }}>
                    {pct(d.share)}
                  </span>
                  <span style={{ width: 46, textAlign: "right", color: "#888", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    {fmtSec(d.sec)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 5. 细类（部位）分布 */}
      {leafEntries.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>细类 / 部位分布</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {leafEntries.map(([k, n]) => {
              const r = Math.round((n / maxLeaf) * 100);
              return (
                <div key={k} style={{
                  padding: "3px 8px", borderRadius: 4, fontSize: 12,
                  background: `linear-gradient(90deg, rgba(22,119,255,0.18) ${r}%, rgba(255,255,255,0.04) ${r}%)`,
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>
                  <span style={{ color: "#ddd" }}>{k}</span> <b style={{ marginLeft: 4, fontVariantNumeric: "tabular-nums" }}>{n}</b>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 添加片段 ─────────────────────────
function AddItemsModal({ setId, open, onClose }: { setId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [idsText, setIdsText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [padSec, setPadSec] = useState<number | null>(60);
  const [segTask, setSegTask] = useState<number | null>(null);
  const [segPicked, setSegPicked] = useState<number[]>([]);
  const [segTop, setSegTop] = useState<string>("抓挠");
  const [busy, setBusy] = useState(false);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects, enabled: open });
  const { data: tasks, isFetching } = useQuery({
    queryKey: ["tasks", projectId], queryFn: () => listTasks(projectId!), enabled: open && projectId != null,
  });
  const { data: segs, isFetching: segLoading } = useQuery({
    queryKey: ["task-segs", segTask], queryFn: () => getTaskSegments(segTask!), enabled: open && segTask != null,
  });
  const segShown = (segs ?? []).filter((x) => !segTop || x.top === segTop);
  const typedIds = () => idsText.split(/[\s,，、]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);

  const submit = async () => {
    // 挑了事件：每个事件一段，起止 = 事件起止，再凑够 N 秒
    if (segTask != null && segPicked.length) {
      const chosen = (segs ?? []).filter((x) => segPicked.includes(x.id));
      setBusy(true);
      try {
        const r = await addTestItems(setId, chosen.map((x) => ({
          task_id: segTask, start_ms: x.start_ms, end_ms: x.end_ms, pad_to_sec: padSec, note: note || `${x.label} 事件`,
        })));
        message[r.skipped.length ? "warning" : "success"](
          `加了 ${r.added} 段` + (r.skipped.length ? `，跳过 ${r.skipped.length}：${r.skipped.slice(0, 3).map((x) => x.reason).join("；")}` : ""));
        qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
        qc.invalidateQueries({ queryKey: ["model-test-sets"] });
        setSegPicked([]);
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }
    const ids = Array.from(new Set([...picked, ...typedIds()]));
    if (!ids.length) return message.warning("先选任务、填任务号，或者点「挑事件」选标注片段");
    const s = parseTime(from), e = parseTime(to);
    if (Number.isNaN(s) || Number.isNaN(e) || (s == null) !== (e == null) || (s != null && e != null && e <= s)) {
      return message.warning("起止要么都空（整个任务），要么都填、结束晚于开始；格式 1:30 或 90（秒）");
    }
    setBusy(true);
    try {
      const r = await addTestItems(setId, ids.map((task_id) => ({
        task_id, start_ms: s, end_ms: e, note: note || undefined, pad_to_sec: s != null ? padSec : null,
      })));
      message[r.skipped.length ? "warning" : "success"](
        `加了 ${r.added} 段` + (r.skipped.length ? `，跳过 ${r.skipped.length}：${r.skipped.slice(0, 3).map((x) => `#${x.task_id} ${x.reason}`).join("；")}` : ""));
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      setPicked([]); setIdsText("");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="加到测试集" open={open} onCancel={onClose} onOk={submit} confirmLoading={busy} width={900} okText="加进去">
      <Space direction="vertical" style={{ width: "100%" }}>
        <Alert type="info" showIcon message={
          <span>加进来的窗口<b>前后各 60 秒以后不进任何训练导出</b>（防相邻几秒漏进去；不给窗口 = 整个样本都不要）。
            挑的时候照顾多样性：体型、狗、场地、白天 / 夜里、不同日期都摊开，一只狗别超过总量 15%。
            标注要对着视频复核过，别直接用某个模型的预标（测试会偏向那个模型）。</span>} />
        <Space wrap>
          <Select showSearch optionFilterProp="label" placeholder="从项目里挑任务" style={{ width: 320 }}
            value={projectId ?? undefined} onChange={(v) => { setProjectId(v); setPicked([]); }}
            options={(projects ?? []).map((p) => ({ value: p.id, label: `#${p.id} ${p.name}` }))} />
          <span>或者直接填任务号：</span>
          <Input style={{ width: 200 }} placeholder="67845, 67846 …" value={idsText} onChange={(e) => setIdsText(e.target.value)} />
          {typedIds().length === 1 && <Button size="small" onClick={() => { setSegTask(typedIds()[0]); setSegPicked([]); }}>挑这个任务的事件</Button>}
        </Space>
        {projectId != null && (
          <Table<Task>
            size="small" rowKey="id" loading={isFetching} dataSource={tasks ?? []} pagination={{ pageSize: 8, showSizeChanger: false }}
            rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) }}
            columns={[
              { title: "任务", dataIndex: "id", width: 90 },
              { title: "样本", render: (_, t) => (t as Task & { sample_code?: string }).sample_code ?? t.sample_id },
              { title: "状态", dataIndex: "status", width: 110 },
              { title: "窗口", width: 140, render: (_, t) => (t.segment_start_ms != null && t.segment_end_ms != null
                ? `${fmtMs(t.segment_start_ms)}–${fmtMs(t.segment_end_ms)}` : "整个样本") },
              { title: "", width: 90, render: (_, t) => (
                <a onClick={(e) => { e.stopPropagation(); setSegTask(t.id); setSegPicked([]); }}>
                  {segTask === t.id ? <b>挑事件 ▾</b> : "挑事件"}
                </a>) },
            ]}
          />
        )}
        {segTask != null && (
          <div style={{ border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }}>
            <Space wrap style={{ marginBottom: 6 }}>
              <b>任务 #{segTask} 的标注片段</b>
              <Select size="small" style={{ width: 130 }} value={segTop} onChange={setSegTop} allowClear placeholder="全部大类"
                options={[...TOPS, "其他"].map((x) => ({ value: x, label: x }))} />
              <span style={{ color: "#888" }}>勾哪几个事件，每个加成一段（起止 = 事件起止，再按下面「凑够」前后延长）</span>
              <a onClick={() => { setSegTask(null); setSegPicked([]); }}>收起</a>
            </Space>
            <Table<TaskSeg>
              size="small" rowKey="id" loading={segLoading} dataSource={segShown} pagination={{ pageSize: 8, showSizeChanger: false }}
              rowSelection={{ selectedRowKeys: segPicked, onChange: (k) => setSegPicked(k as number[]) }}
              columns={[
                { title: "类别", render: (_, x) => <span>{x.label}{x.uncertain && <Tag color="gold" style={{ marginLeft: 4 }}>待定</Tag>}</span> },
                { title: "起止", render: (_, x) => `${fmtMs(x.start_ms)}–${fmtMs(x.end_ms)}` },
                { title: "时长", render: (_, x) => fmtSec((x.end_ms - x.start_ms) / 1000) },
              ]}
            />
          </div>
        )}
        <Space wrap>
          <span>时间窗口（可空 = 整个任务）：</span>
          <Input style={{ width: 100 }} placeholder="开始 1:30" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>—</span>
          <Input style={{ width: 100 }} placeholder="结束 2:30" value={to} onChange={(e) => setTo(e.target.value)} />
          <Tooltip title="围绕起止前后各延长一半凑够这么长（碰到样本头尾就往另一边补）。比如 10 秒抓挠凑成 60 秒：窗口里有事件前后的上下文，模型报早报晚、起止准不准（交并比）才测得出来。空 = 不延长">
            <span>凑够 <InputNumber size="small" min={1} max={3600} style={{ width: 80 }} value={padSec} onChange={(v) => setPadSec(v)} /> 秒</span>
          </Tooltip>
          <Input style={{ width: 220 }} placeholder="备注（为什么挑它，可空）" value={note} onChange={(e) => setNote(e.target.value)} />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          勾了事件就按事件加（上面的时间窗口不用填）；否则窗口对这次选中的所有任务都一样。不超过 3 分钟算「短片段」，否则「长片段」。
          延长出来的那部分也要标全（休息、活动也标），不然模型在那里报的会算误报。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── 按条件挑 ─────────────────────────
const SITE_NAMES = ["公司影棚", "佛山博朗旺狗场", "深圳雷诺狗场"];
/** 从已有的标注片段（人工标过的 / AI 预标的）里按条件挑，凑窗口，先看配比再加进来 */
function ComposeModal({ setId, open, onClose }: { setId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: tree } = useQuery({ queryKey: ["mt-label-tree"], queryFn: getLabelTree, enabled: open });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs, enabled: open });
  const { data: mvs } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions, enabled: open });
  const [labels, setLabels] = useState<string[]>(["抓挠"]);
  const [sites, setSites] = useState<string[]>([]);
  const [dogIds, setDogIds] = useState<number[]>([]);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [source, setSource] = useState<"any" | "human" | "ai">("any");
  const [seenMode, setSeenMode] = useState<"any" | "unseen" | "seen">("any");
  const [modelIds, setModelIds] = useState<number[]>([56, 61, 62]);
  const [perGroup, setPerGroup] = useState(10);
  const [maxTotal, setMaxTotal] = useState(200);
  const [padSec, setPadSec] = useState(60);
  const [minSec, setMinSec] = useState(0);
  const [seed, setSeed] = useState(1);
  const [mode, setMode] = useState<"positive" | "negative">("positive");
  const [anchors, setAnchors] = useState<string[]>([]);
  const [perDog, setPerDog] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ stats: ComposeStats; warnings: string[] } | null>(null);

  const treeData = useMemo(() => {
    const kids = new Map<string | null, { name: string; parent: string | null }[]>();
    (tree ?? []).forEach((x) => kids.set(x.parent, [...(kids.get(x.parent) ?? []), x]));
    type Node = { title: string; value: string; children: Node[] };
    const build = (p: string | null, depth = 0): Node[] =>
      depth > 4 ? [] : (kids.get(p) ?? []).map((x) => ({ title: x.name, value: x.name, children: build(x.name, depth + 1) }));
    return build(null);
  }, [tree]);

  const body = (): ComposeBody => ({
    label_names: labels, sites: sites.length ? sites : undefined, dog_ids: dogIds.length ? dogIds : undefined,
    date_from: range?.[0]?.format("YYYY-MM-DD") ?? null, date_to: range?.[1]?.format("YYYY-MM-DD") ?? null,
    source, seen_mode: seenMode, model_ids: seenMode === "any" ? undefined : modelIds,
    per_group: perGroup, max_total: maxTotal, pad_sec: padSec, min_sec: minSec, seed,
    mode, anchor_names: mode === "negative" && anchors.length ? anchors : undefined, per_dog: perDog,
  });
  const preview = async () => {
    if (!labels.length) return message.warning("至少选一个类别");
    setBusy(true);
    try { setRes(await composePreview(setId, body())); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await composeApply(setId, body());
      message.success(`加了 ${r.added} 段`);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      onClose();
    } finally { setBusy(false); }
  };

  const st = res?.stats;
  const leafs = st ? Array.from(new Set(Object.values(st.by_dog_label).flatMap((m) => Object.keys(m)))).sort() : [];
  const dogRows = st ? Object.keys({ ...st.available }).sort() : [];
  return (
    <Modal title="按条件挑片段" open={open} onCancel={onClose} width={1100}
      footer={<Space>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={preview} loading={busy}>预览配比</Button>
        <Button type="primary" disabled={!st?.n_picked} loading={busy} onClick={apply}>加进测试集（{st?.n_picked ?? 0} 段）</Button>
      </Space>}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Alert type="info" showIcon message={
          <span>从<b>已有的标注片段</b>里挑（以前人工标过的，或 AI 预标的），片段前后延长凑成窗口，挂在原任务上——不建新任务、不用从零标。
            加进来以后在「片段」里点「看 / 标」核对：片段起止、类别不对就调，窗口里漏的补上，然后勾「核对」。打分可以只用核对过的。</span>} />
        <Space wrap>
          <span>类别：</span>
          <TreeSelect style={{ minWidth: 360 }} treeData={treeData} value={labels} onChange={(v) => setLabels(v as string[])}
            treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} placeholder="比如 抓挠 / 抓挠-头颈耳 / 抓挠-躯干" maxTagCount={6} />
          <Tooltip title="选上一级就含下面所有细类；只要某个部位就只勾那个部位">
            <span style={{ color: "#888" }}>（勾大类 = 含全部部位）</span>
          </Tooltip>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" buttonStyle="solid"
            options={[{ value: "positive", label: "有这类" }, { value: "negative", label: "无这类" }]} />
        </Space>
        {mode === "negative" && (
          <Space wrap>
            <Tooltip title="「无抓挠」窗口以哪类片段为中心：选相似动作（舔、甩头、啃）就是考模型会不会把它们误当抓挠；选活动 / 休息就是一般情况。不选 = 任何别的类别。窗口里这个样本所有任务都不能有选的类别（待定的也不行）">
              <span>以哪类片段为中心：</span>
            </Tooltip>
            <TreeSelect style={{ minWidth: 360 }} treeData={treeData} value={anchors} onChange={(v) => setAnchors(v as string[])}
              treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} allowClear placeholder="不选 = 任何别的类别（比如 舔 / 甩头/抖身 / 活动）" maxTagCount={6} />
          </Space>
        )}
        <Space wrap>
          <span>窗口时长：</span>
          <Radio.Group value={[60, 300, 600].includes(padSec) ? padSec : -1} optionType="button"
            onChange={(e) => { if (e.target.value > 0) setPadSec(e.target.value); }}
            options={[{ value: 60, label: "1 分钟" }, { value: 300, label: "5 分钟" }, { value: 600, label: "10 分钟" }, { value: -1, label: "自定义" }]} />
          <InputNumber min={5} max={3600} value={padSec} onChange={(v) => setPadSec(v ?? 60)} addonAfter="秒" style={{ width: 130 }} />
          <span style={{ color: "#888", fontSize: 12 }}>
            {mode === "positive" ? "事件比窗口短就前后延长；长时间的事件不截，留完整过程" : "中心片段比窗口长就在里面截一段"}
          </span>
        </Space>
        <Space wrap>
          <span>场地：</span>
          <Select mode="multiple" style={{ minWidth: 260 }} placeholder="全部" value={sites} onChange={setSites}
            options={SITE_NAMES.map((x) => ({ value: x, label: x }))} />
          <span>狗：</span>
          <Select mode="multiple" style={{ minWidth: 320 }} placeholder="全部" value={dogIds} onChange={setDogIds} optionFilterProp="label"
            options={(dogs ?? []).filter((d) => !sites.length || sites.includes(d.site ?? ""))
              .map((d) => ({ value: d.id, label: `${d.name ?? d.dog_code}（${d.size ?? "?"}·${(d.site ?? "").slice(0, 2)}）` }))} />
          <span>日期：</span>
          <DatePicker.RangePicker value={range as never} onChange={(v) => setRange(v as never)} allowEmpty={[true, true]} />
        </Space>
        <Space wrap>
          <span>片段来源：</span>
          <Radio.Group value={source} onChange={(e) => setSource(e.target.value)} optionType="button" size="small"
            options={[{ value: "any", label: "都要（人工优先）" }, { value: "human", label: "只要人工标过的" }, { value: "ai", label: "只要 AI 预标的" }]} />
          <span>模型见没见过：</span>
          <Radio.Group value={seenMode} onChange={(e) => setSeenMode(e.target.value)} optionType="button" size="small"
            options={[{ value: "any", label: "不管" }, { value: "unseen", label: "没见过" }, { value: "seen", label: "见过" }]} />
          {seenMode !== "any" && (
            <Select mode="multiple" style={{ minWidth: 260 }} value={modelIds} onChange={setModelIds} placeholder="相对哪些模型"
              options={(mvs ?? []).filter((m) => m.status === "done").map((m) => ({ value: m.id, label: `#${m.id} train${m.algo_job_id}` }))} />
          )}
        </Space>
        <Space wrap>
          <span>每只狗 × 每个细类最多 <InputNumber size="small" min={1} max={500} value={perGroup} onChange={(v) => setPerGroup(v ?? 10)} /> 段</span>
          <span>每只狗最多 <InputNumber size="small" min={1} max={3000} value={perDog} placeholder="不限" onChange={(v) => setPerDog(v)} /> 段</span>
          <span>总共最多 <InputNumber size="small" min={1} max={3000} value={maxTotal} onChange={(v) => setMaxTotal(v ?? 200)} /> 段</span>
          <span>片段至少 <InputNumber size="small" min={0} max={3600} value={minSec} onChange={(v) => setMinSec(v ?? 0)} /> 秒</span>
          <Tooltip title="同样的条件和种子挑出来的一样；换个数字就换一批">
            <span>随机种子 <InputNumber size="small" min={1} value={seed} onChange={(v) => setSeed(v ?? 1)} /></span>
          </Tooltip>
        </Space>
        {res?.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />)}
        {st && (
          <>
            <Space wrap>
              <span>符合条件的片段 <b>{st.n_found}</b> 条，挑出 <b>{st.n_picked}</b> 段，视频 <b>{st.video_hours}</b> 小时</span>
              {Object.entries(st.by_site).map(([k, n]) => <Tag key={k} color="blue">{k} {n}</Tag>)}
              {Object.entries(st.by_source).map(([k, n]) => <Tag key={k} color={k === "人工标过" ? "green" : "orange"}>{k} {n}</Tag>)}
              <span style={{ color: "#888" }}>日期 {Object.keys(st.by_date).length} 天</span>
            </Space>
            {st.skipped_unclear && st.skipped_unclear.total > 0 && (
              <Alert
                type="info"
                showIcon
                style={{ padding: "6px 12px" }}
                message={
                  <Space wrap size={[6, 4]}>
                    <span>已自动过滤 <b>{st.skipped_unclear.total}</b> 条本符合条件的「画面看不清 / 遮挡」片段（不纳入测试）：</span>
                    {Object.entries(st.skipped_unclear.by_reason).map(([reason, n]) => (
                      <Tag key={reason} color="cyan" style={{ marginInlineEnd: 0, fontSize: 11 }}>{reason} {n}</Tag>
                    ))}
                    {Object.entries(st.skipped_unclear.by_site).map(([site, n]) => (
                      <Tag key={site} style={{ marginInlineEnd: 0, fontSize: 11 }}>{site} {n}</Tag>
                    ))}
                  </Space>
                }
              />
            )}
            <Table size="small" bordered pagination={false} rowKey="dog" scroll={{ x: true }}
              dataSource={dogRows.map((dog) => ({ dog }))}
              columns={[
                { title: "狗", dataIndex: "dog", fixed: "left", render: (v: string) => `${v}${st.dogs[v]?.size ? `（${st.dogs[v].size}）` : ""}` },
                ...leafs.map((lf) => ({
                  title: lf, key: lf,
                  render: (_: unknown, r: { dog: string }) => {
                    const n = st.by_dog_label[r.dog]?.[lf] ?? 0, a = st.available[r.dog]?.[lf] ?? 0;
                    return <Tooltip title={`挑了 ${n} 段 / 符合条件 ${a} 条`}><span style={{ color: n ? undefined : "#ccc" }}>{n}<span style={{ color: "#888", fontSize: 11 }}> /{a}</span></span></Tooltip>;
                  },
                })),
                { title: "合计", key: "sum", render: (_: unknown, r: { dog: string }) => <b>{Object.values(st.by_dog_label[r.dog] ?? {}).reduce((a, b) => a + b, 0)}</b> },
              ]} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>格子里「挑了 / 符合条件」。不满意就改条件再预览；同样的条件和种子，加进去的就是预览这批。</Typography.Text>
          </>
        )}
      </Space>
    </Modal>
  );
}

// ───────────────────────── 打分 ─────────────────────────
type EvalRow = { key: string; label?: string; group: string; n: number; version: string; r: VersionResult };

/** 选哪些模型版本、哪个类别；测试集严格只列「在本测试集上主动跑过并记录」的模型 */
function useEvalPicker(testSetId?: number, defaultLabel = "抓挠", testSetIds?: number[]) {
  const [label, setLabel] = useState(defaultLabel);
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setScope] = useState<SeenScope>("split");
  const [iou, setIou] = useState(0.3);
  const [checkedOnly, setCheckedOnly] = useState(true);
  const { data: mvs } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions, staleTime: 30_000 });
  const mvByJob = useMemo(() => new Map((mvs ?? []).map((m) => [m.algo_job_id, m])), [mvs]);
  const idsKey = testSetIds ? testSetIds.join(",") : "";
  const { data: runs, refetch } = useQuery({
    queryKey: ["eval-runs-all", testSetId ?? (testSetIds ? `multi:${idsKey}` : "all")],
    queryFn: () => {
      if (testSetId) return listEvalRuns({ test_set_id: testSetId });
      if (testSetIds) return testSetIds.length ? listEvalRuns({ test_set_ids: testSetIds }) : Promise.resolve({ n_scope: 0, runs: [] });
      return listEvalRuns({});
    },
  });
  const nScope = runs?.n_scope ?? null;
  const sortedRuns = useMemo(
    () => [...(runs?.runs ?? [])].sort((a, b) =>
      (b.last_run_at ?? "").localeCompare(a.last_run_at ?? "") || b.n_samples - a.n_samples,
    ),
    [runs],
  );
  const options = useMemo(() => sortedRuns.map((r) => ({
    value: `${r.model_tag}::${r.mode}`,
    label: `${formatEvalVersion(r.model_tag, r.mode, mvByJob)}（已跑 ${r.n_samples}${nScope != null ? `/${nScope}` : ""}）`,
    n_samples: r.n_samples,
    classes: r.classes ?? [],
  })), [sortedRuns, nScope, mvByJob]);
  const pickedRuns = useMemo(
    () => sortedRuns.filter((r) => picked.includes(`${r.model_tag}::${r.mode}`)),
    [sortedRuns, picked],
  );
  // 切到新测试集时：有跑批记录就默认只勾选最新 1 个；没记录或记录被移除时，清空已选，绝不沿用旧测试集/已移除的模型
  const autoPickedSet = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!testSetId || runs === undefined) return;
    const valid = new Set(options.map((o) => o.value));
    if (autoPickedSet.current !== testSetId) {
      autoPickedSet.current = testSetId;
      setPicked(options.length ? [options[0].value] : []);
      return;
    }
    setPicked((prev) => {
      const next = prev.filter((k) => valid.has(k));
      return next.length === prev.length ? prev : next;
    });
  }, [testSetId, runs, options]);
  const versions = picked.map((p) => { const [model_tag, mode] = p.split("::"); return { model_tag, mode }; });
  return { label, setLabel, picked, setPicked, scope, setScope, iou, setIou, checkedOnly, setCheckedOnly, options, pickedRuns, mvByJob, versions, refetchRuns: refetch };
}

/** 打分用哪些样本：选中的模型都没见过的 / 至少一个见过的 / 全部 / 两部分分开各打一次 */
type SeenScope = "unseen" | "seen" | "all" | "split";
const SCOPE_OPTIONS = [
  { value: "unseen", label: "只用没见过的（正式成绩）" },
  { value: "seen", label: "只用见过的（训练用过）" },
  { value: "all", label: "全部" },
  { value: "split", label: "见过 / 没见过 分开看" },
];
/** 按范围把样本分成几份：[名字, 样本 id] */
async function scopeParts(setId: number, items: TestItem[], versionKeys: string[], scope: SeenScope, notes: string[], prefix = "") {
  const all = Array.from(new Set(items.map((i) => i.sample_id)));
  if (scope === "all") return [[`${prefix}全部`, all]] as [string, number[]][];
  const { seenSamples, unknown } = await seenSamplesOf(setId, items, versionKeys);
  if (unknown.length) notes.push(`${unknown.join("、")} 为默认在线或外部模型，无对应训练记录（默认按没见过计）`);
  const seen = all.filter((s) => seenSamples.has(s));
  const unseen = all.filter((s) => !seenSamples.has(s));
  notes.push(`${prefix}选中的模型见过 ${seen.length} 个样本、都没见过 ${unseen.length} 个`);
  if (scope === "seen") return [[`${prefix}见过`, seen]] as [string, number[]][];
  if (scope === "unseen") return [[`${prefix}没见过`, unseen]] as [string, number[]][];
  return [[`${prefix}没见过`, unseen], [`${prefix}见过`, seen]] as [string, number[]][];
}

/** 一批测试集里，选中模型见过的样本（按训练记录的数据集算）。versionKeys 为 "model_tag::mode"，从两段里都能认出 train<N> */
async function seenSamplesOf(setId: number, items: TestItem[], versionKeys: string[]) {
  const mvs = await listModelVersions();
  const jobIds = versionKeys.map(jobIdOfTag);
  const unknown = versionKeys
    .filter((_, i) => jobIds[i] == null || !mvs.some((m) => m.algo_job_id === jobIds[i]))
    .map((vk) => vk.split("::")[0]);
  const ids = mvs.filter((m) => jobIds.includes(m.algo_job_id)).map((m) => m.id);
  const seenItems = new Set<number>();
  if (ids.length) {
    const r = await getTestSeen(setId, ids);
    r.models.forEach((m) => m.seen_item_ids.forEach((i) => seenItems.add(i)));
  }
  const seenSamples = new Set(items.filter((it) => seenItems.has(it.id)).map((it) => it.sample_id));
  return { seenSamples, unknown: Array.from(new Set(unknown)) };
}

function EvalPickerBar({ p, extra }: { p: ReturnType<typeof useEvalPicker>; extra?: ReactNode }) {
  return (
    <Space wrap>
      <Select style={{ width: 130 }} value={p.label} onChange={p.setLabel} options={EVAL_LABELS.map((x) => ({ value: x, label: x }))} />
      <Select mode="multiple" allowClear style={{ minWidth: 420 }} placeholder="选要比的模型版本（要先在这批样本上跑过）"
        value={p.picked} onChange={p.setPicked} options={p.options} maxTagCount={3} />
      <Tooltip title="重叠多少算同一段：0.3 宽松，起止差一点也认；想严格看边界调到 0.5 以上">
        <span>IoU ≥ <InputNumber size="small" min={0.05} max={0.95} step={0.05} value={p.iou} onChange={(v) => p.setIou(v ?? 0.3)} /></span>
      </Tooltip>
      <Tooltip title="见过 = 样本在选中的任一模型的训练数据里。正式成绩看「没见过」；跟「见过」差得多说明模型在背答案">
        <Select style={{ width: 210 }} value={p.scope} onChange={(v) => p.setScope(v as SeenScope)} options={SCOPE_OPTIONS} />
      </Tooltip>
      <Tooltip title="正确答案只认人工核对过的片段（看过窗口、该调的调了）。没核对的里面可能还是没改过的 AI 预标">
        <Checkbox checked={p.checkedOnly} onChange={(e) => p.setCheckedOnly(e.target.checked)}>只用核对过的</Checkbox>
      </Tooltip>
      {extra}
    </Space>
  );
}

const EVAL_GROUP_THEME = {
  window: {
    accent: "#4096ff",
    border: "2px solid #1677ff",
    headBg: "rgba(22, 119, 255, 0.18)",
    subBg: "rgba(22, 119, 255, 0.09)",
    cellBg: "rgba(22, 119, 255, 0.04)",
  },
  event: {
    accent: "#b37feb",
    border: "2px solid #9254de",
    headBg: "rgba(114, 46, 209, 0.20)",
    subBg: "rgba(114, 46, 209, 0.10)",
    cellBg: "rgba(114, 46, 209, 0.04)",
  },
  boundary: {
    accent: "#36cfc9",
    border: "2px solid #13c2c2",
    headBg: "rgba(19, 194, 194, 0.18)",
    subBg: "rgba(19, 194, 194, 0.09)",
    cellBg: "rgba(19, 194, 194, 0.04)",
  },
} as const;

const styleGroupCols = <T extends Record<string, unknown>>(
  theme: (typeof EVAL_GROUP_THEME)[keyof typeof EVAL_GROUP_THEME],
  cols: T[],
): T[] => cols.map((c, idx) => ({
  ...c,
  onHeaderCell: () => ({
    style: {
      background: theme.subBg,
      ...(idx === 0 ? { borderLeft: theme.border } : {}),
    },
  }),
  onCell: () => ({
    style: {
      background: theme.cellBg,
      ...(idx === 0 ? { borderLeft: theme.border } : {}),
    },
  }),
}));

const evalColumns = (groupTitle: string, showLabel = false, colorOf?: (k: string) => string | undefined, iouMin?: number, edgeTolSec = 2) => {
  const iouTxt = iouMin != null ? `IoU ≥ ${Math.round(iouMin * 100)}%` : "IoU 达标";
  return [
  ...(showLabel ? [{
    title: "类别", dataIndex: "label", width: 92,
    render: (lb: string) => <Tag color={colorOf?.(lb)} style={{ marginInlineEnd: 0 }}>{lb}</Tag>,
  }] : []),
  { title: groupTitle, dataIndex: "group", width: 115 },
  { title: "版本", dataIndex: "version", width: 210, ellipsis: true },
  {
    title: (
      <Tooltip title="把每个测试片段（如 1 分钟）当成一道「有没有抓挠」的是非题，衡量有没有报警/记录准不准">
        <span style={{ color: EVAL_GROUP_THEME.window.accent, fontWeight: 700 }}>● 窗口级（这段有没有）</span>
      </Tooltip>
    ),
    onHeaderCell: () => ({
      style: {
        background: EVAL_GROUP_THEME.window.headBg,
        borderLeft: EVAL_GROUP_THEME.window.border,
        borderTop: EVAL_GROUP_THEME.window.border,
      },
    }),
    children: styleGroupCols(EVAL_GROUP_THEME.window, [
      { title: "段数", key: "w_n", width: 56, render: (_: unknown, x: EvalRow) => x.r.window ? x.r.window.n_windows : "-" },
      { title: "准确率", key: "w_acc", width: 70, render: (_: unknown, x: EvalRow) => x.r.window ? pct(x.r.window.accuracy) : "-" },
      { title: "精确率", key: "w_p", width: 70, render: (_: unknown, x: EvalRow) => x.r.window ? pct(x.r.window.precision) : "-" },
      { title: "召回率", key: "w_r", width: 70, render: (_: unknown, x: EvalRow) => x.r.window ? pct(x.r.window.recall) : "-" },
      {
        title: "F1", key: "w_f1", width: 68,
        render: (_: unknown, x: EvalRow) => x.r.window ? <b style={{ color: EVAL_GROUP_THEME.window.accent }}>{pct(x.r.window.f1)}</b> : "-",
      },
      {
        title: "明细（对 / 误 / 漏）", key: "w_det", width: 150,
        render: (_: unknown, x: EvalRow) => {
          const w = x.r.window;
          if (!w) return "-";
          return (
            <Tooltip title={`真阳(有且报) ${w.tp} · 真阴(无且没报) ${w.tn} · 误报窗口 ${w.fp} · 漏报窗口 ${w.fn}`}>
              <span>
                <b style={{ color: "#52c41a" }}>{w.tp + w.tn}</b> 对 / <span style={{ color: "#faad14" }}>{w.fp}</span> 误 / <span style={{ color: "#ff4d4f" }}>{w.fn}</span> 漏
              </span>
            </Tooltip>
          );
        },
      },
    ]),
  },
  {
    title: (
      <Tooltip title={`逐次比对每次动作：预测时段和人工标注的重叠比例（${iouTxt}）达标才算抓对，衡量「计次准不准」。拖动上方 IoU 滑块可实时重算`}>
        <span style={{ color: EVAL_GROUP_THEME.event.accent, fontWeight: 700 }}>
          ● 事件级（每次抓对没 · {iouTxt}）
        </span>
      </Tooltip>
    ),
    onHeaderCell: () => ({
      style: {
        background: EVAL_GROUP_THEME.event.headBg,
        borderLeft: EVAL_GROUP_THEME.event.border,
        borderTop: EVAL_GROUP_THEME.event.border,
      },
    }),
    children: styleGroupCols(EVAL_GROUP_THEME.event, [
      { title: "精确率", key: "e_p", width: 70, render: (_: unknown, x: EvalRow) => pct(x.r.precision) },
      { title: "召回率", key: "e_r", width: 70, render: (_: unknown, x: EvalRow) => pct(x.r.recall) },
      { title: "F1", key: "e_f1", width: 70, render: (_: unknown, x: EvalRow) => <b style={{ color: EVAL_GROUP_THEME.event.accent }}>{pct(f1(x.r.precision, x.r.recall))}</b> },
      {
        title: "明细（对 / 误 / 漏）", key: "e_det", width: 160,
        render: (_: unknown, x: EvalRow) => (
          <span><b style={{ color: "#52c41a" }}>{x.r.tp}</b> 对 / <span style={{ color: "#faad14" }}>{x.r.fp}</span> 误 / <span style={{ color: "#ff4d4f" }}>{x.r.fn}</span> 漏</span>
        ),
      },
    ]),
  },
  {
    title: (
      <Tooltip title={`在已经抓对的动作里，看模型报的开始/结束时刻跟人工标注差几秒，衡量「时长统计准不准」。可在上方切换 ±1s/±2s/±3s/±5s`}>
        <span style={{ color: EVAL_GROUP_THEME.boundary.accent, fontWeight: 700 }}>● 起止对齐（开始/结束准不准）</span>
      </Tooltip>
    ),
    onHeaderCell: () => ({
      style: {
        background: EVAL_GROUP_THEME.boundary.headBg,
        borderLeft: EVAL_GROUP_THEME.boundary.border,
        borderTop: EVAL_GROUP_THEME.boundary.border,
      },
    }),
    children: styleGroupCols(EVAL_GROUP_THEME.boundary, [
      { title: "平均重叠", key: "b_iou", width: 78, render: (_: unknown, x: EvalRow) => x.r.mean_iou != null ? pct(x.r.mean_iou) : "-" },
      {
        title: <Tooltip title={`抓对的动作里，开始和结束时间都与人工标注相差 ≤ ${edgeTolSec} 秒的比例`}>±{edgeTolSec}s 对齐</Tooltip>,
        key: "b_2s", width: 82,
        render: (_: unknown, x: EvalRow) => x.r.within_2s_ratio != null ? <b style={{ color: EVAL_GROUP_THEME.boundary.accent }}>{pct(x.r.within_2s_ratio)}</b> : "-",
      },
      {
        title: <Tooltip title="开始时间平均偏差 / 结束时间平均偏差">起/止均差</Tooltip>,
        key: "b_err", width: 108,
        render: (_: unknown, x: EvalRow) => (x.r.d_start_abs_mean_ms != null && x.r.d_end_abs_mean_ms != null)
          ? `${(x.r.d_start_abs_mean_ms / 1000).toFixed(1)}s / ${(x.r.d_end_abs_mean_ms / 1000).toFixed(1)}s`
          : "-",
      },
    ]),
  },
  { title: <Tooltip title="已跑推理的原始视频样本数 / 测试集涉及的总样本数">样本</Tooltip>, key: "ran", width: 68, render: (_: unknown, x: EvalRow) => (
    <span style={{ color: x.r.n_samples_with_result < x.n ? "#ff4d4f" : undefined }}>{x.r.n_samples_with_result}/{x.n}</span>) },
  ];
};

/** 单个测试窗口的双轨迷你时间轴：上轨 = 人工标注（绿），下轨 = 模型预测（蓝/橙） */
function MiniTimeline({ d }: { d: WindowDetail }) {
  const dur = Math.max(1, d.end_ms - d.start_ms);
  const pos = (s: number, e: number) => ({
    left: `${Math.max(0, Math.min(100, (s / dur) * 100))}%`,
    width: `${Math.max(2, Math.min(100, ((e - s) / dur) * 100))}%`,
  });
  return (
    <Tooltip title={
      <div style={{ fontSize: 12 }}>
        <div>绿色上轨：标注 {d.truth_n} 次</div>
        <div>{d.verdict === "fp" ? "橙色" : "蓝色"}下轨：预测 {d.pred_n} 次{d.max_conf != null ? `（最高置信度 ${d.max_conf}）` : ""}</div>
        <div>事件配对：{d.event_tp} 对 / {d.event_fp} 误报 / {d.event_fn} 漏报</div>
        {d.mean_iou != null && <div>平均 IoU {pct(d.mean_iou)}</div>}
        {d.max_edge_err_ms != null && <div>最大起止偏差 {(d.max_edge_err_ms / 1000).toFixed(1)}s</div>}
      </div>
    }>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, width: 160 }}>
        <div style={{ position: "relative", height: 6, borderRadius: 3, background: "rgba(128,128,128,0.18)", overflow: "hidden" }}>
          {d.truth_segs.map(([s, e], i) => (
            <div key={i} style={{ position: "absolute", top: 0, bottom: 0, background: "#52c41a", borderRadius: 2, ...pos(s, e) }} />
          ))}
        </div>
        <div style={{ position: "relative", height: 6, borderRadius: 3, background: "rgba(128,128,128,0.18)", overflow: "hidden" }}>
          {d.pred_segs.map(([s, e], i) => (
            <div key={i} style={{ position: "absolute", top: 0, bottom: 0, background: d.verdict === "fp" ? "#faad14" : "#1677ff", borderRadius: 2, ...pos(s, e) }} />
          ))}
        </div>
      </div>
    </Tooltip>
  );
}

const VERDICT_META: Record<WindowDetail["verdict"], { label: string; color: string; hex: string }> = {
  tp: { label: "命中", color: "green", hex: "#52c41a" },
  tn: { label: "正常通过", color: "default", hex: "#5c7cfa" },
  fp: { label: "误报", color: "orange", hex: "#faad14" },
  fn: { label: "漏报", color: "red", hex: "#ff4d4f" },
};

const DIAG_COLOR: Record<string, string> = {
  post_filter: "purple",
  low_conf: "gold",
  misclass: "red",
  suspect_human_miss: "cyan",
  confuse_similar: "orange",
  low_conf_fp: "gold",
  model_fp: "red",
};

function EvalVisualPanel({ row, iouMin, edgeTolSec = 2, items, colors, opening, promoting, frozen, onOpenTask, onPromoteItem }: {
  row: EvalRow; iouMin: number; edgeTolSec?: number; items: TestItem[]; colors: Record<string, string>;
  opening: number | null; promoting: number | null; frozen?: boolean;
  onOpenTask: (taskId: number, seekMs: number, opts?: OpenTaskOpts) => void;
  onPromoteItem: (itemId: number) => void;
}) {
  const details = row.r.window_details ?? [];
  const [filter, setFilter] = useState<"err" | "fp" | "fn" | "edge" | "tp" | "tn" | "all">("err");
  const [diagFilter, setDiagFilter] = useState<string | null>(null);
  useEffect(() => {
    setDiagFilter(null);
  }, [row.key]);
  const itemByWin = useMemo(() => {
    const m = new Map<string, TestItem>();
    items.forEach((it) => m.set(`${it.sample_id}:${it.start_ms}:${it.end_ms}`, it));
    return m;
  }, [items]);

  const openDetailAt = (d: WindowDetail, it: TestItem, targetSeg?: [number, number]) => {
    const absTruth: [number, number][] = d.truth_segs.map(([s, e]) => [d.start_ms + s, d.start_ms + e]);
    const absPred: [number, number, number | null][] = d.pred_segs.map(([s, e, c]) => [d.start_ms + s, d.start_ms + e, c]);
    const firstPred: [number, number] | undefined = absPred[0] ? [absPred[0][0], absPred[0][1]] : undefined;
    const focusSeg: [number, number] | undefined = targetSeg
      ?? (d.verdict === "fp" ? firstPred : (absTruth[0] ?? firstPred));
    const evalHint: EvalWindowHint = {
      label: row.label ?? "抓挠",
      version: row.version,
      verdict: d.verdict,
      iouMin,
      truthSegs: absTruth,
      predSegs: absPred,
    };
    if (focusSeg) {
      // 严格用该事件自己的精确起止作为循环区间，波形浮窗才能精确匹配到「已标注 · 抓挠」或「模型预测 · 抓挠」
      onOpenTask(it.task_id, focusSeg[0], {
        winStartMs: d.start_ms,
        winEndMs: d.end_ms,
        itemId: it.id,
        loopRange: { startMs: focusSeg[0], endMs: focusSeg[1] },
        evalHint,
      });
    } else {
      onOpenTask(it.task_id, d.start_ms, {
        winStartMs: d.start_ms,
        winEndMs: d.end_ms,
        itemId: it.id,
        evalHint,
      });
    }
  };

  const counts = useMemo(() => {
    const c = { tp: 0, tn: 0, fp: 0, fn: 0, edgeBad: 0 };
    details.forEach((d) => {
      c[d.verdict]++;
      if (d.edge_aligned === false) c.edgeBad++;
    });
    return c;
  }, [details]);
  const total = details.length;
  const errCount = counts.fp + counts.fn;
  const diagSummary = useMemo(() => {
    const fnMap = new Map<string, { code: string; title: string; count: number }>();
    const fpMap = new Map<string, { code: string; title: string; count: number }>();
    details.forEach((d) => {
      if (!d.diag) return;
      const target = d.verdict === "fn" ? fnMap : d.verdict === "fp" ? fpMap : null;
      if (!target) return;
      const prev = target.get(d.diag.code);
      if (prev) prev.count += 1;
      else target.set(d.diag.code, { code: d.diag.code, title: d.diag.title, count: 1 });
    });
    const sortDesc = (m: Map<string, { code: string; title: string; count: number }>) =>
      Array.from(m.values()).sort((a, b) => b.count - a.count);
    return { fn: sortDesc(fnMap), fp: sortDesc(fpMap) };
  }, [details]);
  const shown = useMemo(() => {
    let base: WindowDetail[];
    if (filter === "all") base = details;
    else if (filter === "err") base = details.filter((d) => d.verdict === "fp" || d.verdict === "fn");
    else if (filter === "edge") base = details.filter((d) => d.edge_aligned === false);
    else base = details.filter((d) => d.verdict === filter);
    if (diagFilter) return base.filter((d) => d.diag?.code === diagFilter);
    return base;
  }, [details, filter, diagFilter]);

  if (!total) return null;
  const colorOf = (k: string): string | undefined => colors[k] ?? (k === "其他" ? "#8c8c8c" : undefined);
  const cards: { k: typeof filter; title: string; n: number; hex: string; sub: string }[] = [
    { k: "err", title: "全部错误", n: errCount, hex: "#ff7875", sub: `误报 ${counts.fp} + 漏报 ${counts.fn}` },
    { k: "fp", title: "误报窗口", n: counts.fp, hex: "#faad14", sub: "没动作却乱报" },
    { k: "fn", title: "漏报窗口", n: counts.fn, hex: "#ff4d4f", sub: "有动作没报出" },
    { k: "edge", title: `起止偏差 >${edgeTolSec}s`, n: counts.edgeBad, hex: "#722ed1", sub: "命中但边界不齐" },
    { k: "tp", title: "命中窗口", n: counts.tp, hex: "#52c41a", sub: "有动作且报对" },
    { k: "tn", title: "正常通过", n: counts.tn, hex: "#5c7cfa", sub: "无动作没乱报" },
    { k: "all", title: "全部窗口", n: total, hex: "#8c8c8c", sub: `准确率 ${pct((counts.tp + counts.tn) / total)}` },
  ];

  const selectVerdict = (k: typeof filter) => {
    setFilter(k);
    setDiagFilter(null);
  };
  const toggleDiag = (code: string, verdict: "fn" | "fp") => {
    if (diagFilter === code) {
      setDiagFilter(null);
    } else {
      setFilter(verdict);
      setDiagFilter(code);
    }
  };

  return (
    <div style={{ padding: "12px 14px", borderRadius: 8, border: "1px solid rgba(128,128,128,0.22)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Typography.Text strong>
          片段级可视化与错例分析 · {row.label ? `【${row.label}】 · ` : ""}{row.group} · {row.version}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          点下方色块筛选错误 / 起止偏差 / 正确片段，点「看视频」可直接跳到该窗口排查原因
        </Typography.Text>
      </div>

      {/* 堆叠占比条 */}
      <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "rgba(128,128,128,0.15)" }}>
        {(["tp", "tn", "fp", "fn"] as const).map((k) => counts[k] > 0 && (
          <Tooltip key={k} title={`${VERDICT_META[k].label}：${counts[k]} 段（${pct(counts[k] / total)}）`}>
            <div onClick={() => selectVerdict(k)} style={{ flex: counts[k], background: VERDICT_META[k].hex, cursor: "pointer", transition: "flex .25s" }} />
          </Tooltip>
        ))}
      </div>

      {/* 可点击筛选卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        {cards.map((c) => {
          const active = filter === c.k && !diagFilter;
          return (
            <div key={c.k} onClick={() => selectVerdict(c.k)} style={{
              cursor: "pointer", padding: "8px 10px", borderRadius: 8,
              border: `1.5px solid ${active ? c.hex : "rgba(128,128,128,0.22)"}`,
              background: active ? `${c.hex}18` : "transparent",
              transition: "all .15s",
            }}>
              <div style={{ fontSize: 12, color: active ? c.hex : "#999" }}>{c.title}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: c.hex, lineHeight: 1.2 }}>{c.n}</div>
              <div style={{ fontSize: 11, color: "#888" }}>{c.sub}</div>
            </div>
          );
        })}
      </div>

      {/* 错例自动归因总览（点标签可一键筛同类错例） */}
      {(diagSummary.fn.length > 0 || diagSummary.fp.length > 0) && (
        <div style={{
          padding: "8px 12px", borderRadius: 8,
          background: "rgba(128,128,128,0.08)",
          border: "1px solid rgba(128,128,128,0.18)",
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", fontSize: 12,
        }}>
          <Typography.Text strong style={{ fontSize: 12 }}>自动归因总览</Typography.Text>
          {diagSummary.fn.length > 0 && (
            <Space size={4} wrap>
              <span style={{ color: "#ff7875" }}>漏报：</span>
              {diagSummary.fn.map((item) => {
                const active = diagFilter === item.code;
                return (
                  <Tag
                    key={`fn-${item.code}`}
                    color={DIAG_COLOR[item.code] ?? "default"}
                    onClick={() => toggleDiag(item.code, "fn")}
                    style={{
                      cursor: "pointer", marginInlineEnd: 0,
                      outline: active ? "1.5px solid #fff" : undefined,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {item.title} × {item.count}
                  </Tag>
                );
              })}
            </Space>
          )}
          {diagSummary.fp.length > 0 && (
            <Space size={4} wrap>
              <span style={{ color: "#faad14" }}>误报：</span>
              {diagSummary.fp.map((item) => {
                const active = diagFilter === item.code;
                return (
                  <Tag
                    key={`fp-${item.code}`}
                    color={DIAG_COLOR[item.code] ?? "default"}
                    onClick={() => toggleDiag(item.code, "fp")}
                    style={{
                      cursor: "pointer", marginInlineEnd: 0,
                      outline: active ? "1.5px solid #fff" : undefined,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {item.title} × {item.count}
                  </Tag>
                );
              })}
            </Space>
          )}
          {diagFilter && (
            <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => setDiagFilter(null)}>
              清除归因筛选
            </Button>
          )}
        </div>
      )}

      {/* 片段明细表 */}
      <Table
        size="small"
        rowKey={(d) => `${d.sample_id}-${d.start_ms}-${d.end_ms}`}
        dataSource={shown}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1240 }}
        locale={{ emptyText: filter === "err" ? "太棒了，这一组没有误报或漏报窗口！" : "该分类下暂无片段" }}
        columns={[
          {
            title: "结果", width: 88,
            render: (_: unknown, d: WindowDetail) => <Tag color={VERDICT_META[d.verdict].color}>{VERDICT_META[d.verdict].label}</Tag>,
          },
          {
            title: "狗 / 场地", width: 170,
            render: (_: unknown, d: WindowDetail) => {
              const it = itemByWin.get(`${d.sample_id}:${d.start_ms}:${d.end_ms}`);
              return it ? (
                <span>
                  <b>{it.dog_name ?? "未知"}</b>{it.size ? `（${it.size}）` : ""}
                  <div style={{ fontSize: 11, color: "#888" }}>{it.site ?? ""} · {it.date ?? ""}</div>
                </span>
              ) : `样本 #${d.sample_id}`;
            },
          },
          {
            title: "窗口", width: 120,
            render: (_: unknown, d: WindowDetail) => (
              <span>
                {fmtMs(d.start_ms)}–{fmtMs(d.end_ms)}
                <div style={{ fontSize: 11, color: "#888" }}>{fmtSec((d.end_ms - d.start_ms) / 1000)}</div>
              </span>
            ),
          },
          {
            title: <Tooltip title="上轨绿色 = 人工标注；下轨蓝色/橙色 = 模型预测（点下方具体时间胶囊可直接跳到该秒数）">标注 vs 预测</Tooltip>, width: 265,
            render: (_: unknown, d: WindowDetail) => {
              const it = itemByWin.get(`${d.sample_id}:${d.start_ms}:${d.end_ms}`);
              return (
                <div>
                  <MiniTimeline d={d} />
                  <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                    标 {d.truth_n} / 预 {d.pred_n}
                    {d.mean_iou != null && ` · IoU ${Math.round(d.mean_iou * 100)}%`}
                    {d.max_edge_err_ms != null && (
                      <span style={{ color: d.edge_aligned === false ? "#b37feb" : undefined }}>
                        {` · 偏 ${(d.max_edge_err_ms / 1000).toFixed(1)}s`}
                      </span>
                    )}
                  </div>
                  {(d.pred_segs.length > 0 || d.truth_segs.length > 0) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                      {d.pred_segs.slice(0, 2).map(([s, e, conf], idx) => (
                        <Tag key={`p-${idx}`} color={d.verdict === "fp" ? "orange" : "blue"}
                          style={{ marginInlineEnd: 0, fontSize: 11, cursor: it ? "pointer" : "default" }}
                          onClick={() => it && openDetailAt(d, it, [d.start_ms + s, d.start_ms + e])}>
                          预 {fmtMs(d.start_ms + s)}–{fmtMs(d.start_ms + e)}{conf != null ? ` (${conf})` : ""}
                        </Tag>
                      ))}
                      {d.pred_segs.length > 2 && <span style={{ fontSize: 11, color: "#888" }}>+{d.pred_segs.length - 2}</span>}
                      {d.truth_segs.slice(0, 2).map(([s, e], idx) => (
                        <Tag key={`t-${idx}`} color="green"
                          style={{ marginInlineEnd: 0, fontSize: 11, cursor: it ? "pointer" : "default" }}
                          onClick={() => it && openDetailAt(d, it, [d.start_ms + s, d.start_ms + e])}>
                          标 {fmtMs(d.start_ms + s)}–{fmtMs(d.start_ms + e)}
                        </Tag>
                      ))}
                      {d.truth_segs.length > 2 && <span style={{ fontSize: 11, color: "#888" }}>+{d.truth_segs.length - 2}</span>}
                    </div>
                  )}
                </div>
              );
            },
          },
          {
            title: "归因与调优方向", width: 295,
            render: (_: unknown, d: WindowDetail) => {
              if (!d.diag) {
                return d.edge_aligned === false
                  ? <Tag color="purple" style={{ marginInlineEnd: 0 }}>起止边界偏差 &gt;2s</Tag>
                  : <span style={{ color: "#666", fontSize: 12 }}>—</span>;
              }
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 3, lineHeight: 1.45 }}>
                  <div>
                    <Tag color={DIAG_COLOR[d.diag.code] ?? "default"} style={{ marginInlineEnd: 0, fontWeight: 500 }}>
                      {d.diag.title}
                    </Tag>
                  </div>
                  <div style={{ fontSize: 12 }}>{d.diag.detail}</div>
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>→ {d.diag.tip}</div>
                </div>
              );
            },
          },
          {
            title: "窗口内实际动作", width: 185,
            render: (_: unknown, d: WindowDetail) => {
              const it = itemByWin.get(`${d.sample_id}:${d.start_ms}:${d.end_ms}`);
              const lbs = Object.entries(it?.labels ?? {});
              return lbs.length ? (
                <Space size={4} wrap>
                  {lbs.map(([k, v]) => <Tag key={k} color={colorOf(k)} style={{ marginInlineEnd: 0 }}>{k} {v.n}次·{fmtSec(v.sec)}</Tag>)}
                </Space>
              ) : <span style={{ color: "#888", fontSize: 12 }}>无标注</span>;
            },
          },
          {
            title: "操作", width: 165, fixed: "right" as const,
            render: (_: unknown, d: WindowDetail) => {
              const it = itemByWin.get(`${d.sample_id}:${d.start_ms}:${d.end_ms}`);
              return it ? (
                <Space size={6}>
                  <Tooltip title="直接跳到该窗口内的目标动作/误报时刻前 2 秒并循环播放">
                    <Button size="small" type="link" style={{ padding: 0 }} loading={opening === it.task_id}
                      onClick={() => openDetailAt(d, it)}>看视频 / 纠偏</Button>
                  </Tooltip>
                  {!frozen && (
                    <Popconfirm
                      title="确认标注无误：审核通过入数据池并从当前测试集剥离？"
                      okText="入池并剥离"
                      onConfirm={() => onPromoteItem(it.id)}
                    >
                      <Button size="small" type="link" style={{ padding: 0 }} loading={promoting === it.id}>入池剥离</Button>
                    </Popconfirm>
                  )}
                </Space>
              ) : null;
            },
          },
        ]}
      />
    </div>
  );
}

function EvalNotes({ notes, hasRows }: { notes: string[]; hasRows: boolean }) {
  if (!notes.length) return null;
  if (!hasRows) return <Alert type="warning" showIcon message={notes.join("；")} />;
  return (
    <Collapse
      size="small"
      items={[{
        key: "notes",
        label: <span style={{ fontSize: 12, color: "#888" }}>评测说明（{notes.length} 条，点此展开）</span>,
        children: (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#aaa", lineHeight: 1.7 }}>
            {notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        ),
      }]}
    />
  );
}

function buildReportPayload(
  testSet: TestSet,
  coverage: Coverage | null | undefined,
  items: TestItem[],
  evalLabel: string,
  iouMin: number,
  edgeTolSec: number,
  rows: EvalRow[],
  active: EvalRow | null | undefined,
  reporter?: string,
): TestReportInput {
  const itemByWin = new Map<string, TestItem>();
  items.forEach((it) => itemByWin.set(`${it.sample_id}:${it.start_ms ?? 0}:${it.end_ms ?? 0}`, it));
  const details = active?.r.window_details ?? [];
  let fp = 0, fn = 0, tp = 0, tn = 0, boundaryBad = 0;
  const errorCases: ReportErrorCase[] = [];
  for (const d of details) {
    if (d.verdict === "fp") fp += 1;
    else if (d.verdict === "fn") fn += 1;
    else if (d.verdict === "tp") tp += 1;
    else tn += 1;
    const isEdgeBad = d.edge_aligned === false;
    if (isEdgeBad) boundaryBad += 1;
    if (d.verdict === "fp" || d.verdict === "fn" || isEdgeBad) {
      const it = itemByWin.get(`${d.sample_id}:${d.start_ms}:${d.end_ms}`);
      const maxConf = d.pred_segs.reduce<number | null>((mx, seg) => {
        const c = seg[2];
        return c != null && (mx == null || c > mx) ? c : mx;
      }, null);
      const actualLabels = Object.entries(it?.labels ?? {}).map(([k, v]) => `${k} ${v.n}次·${fmtSec(v.sec)}`);
      errorCases.push({
        verdict: d.verdict,
        boundaryBad: isEdgeBad,
        dog: it?.dog_name ?? `样本 #${d.sample_id}`,
        site: it?.site ?? "",
        size: it?.size ?? "",
        winText: `${fmtMs(d.start_ms)}–${fmtMs(d.end_ms)}`,
        durText: fmtSec((d.end_ms - d.start_ms) / 1000),
        truthN: d.truth_n,
        predN: d.pred_n,
        maxConf,
        minIou: d.mean_iou ?? null,
        truthSegs: d.truth_segs,
        predSegs: d.pred_segs,
        winDurMs: Math.max(1, d.end_ms - d.start_ms),
        actualLabels,
        tag: d.diag?.title ?? (isEdgeBad ? `起止边界偏差 >${edgeTolSec}s` : d.verdict === "fp" ? "误报" : "漏报"),
        reason: d.diag?.detail ?? (isEdgeBad && d.max_edge_err_ms != null ? `边界最大偏差 ${(d.max_edge_err_ms / 1000).toFixed(1)}s` : ""),
        advice: d.diag?.tip ?? "",
      });
    }
  }
  return {
    testSet,
    coverage,
    items,
    evalLabel,
    iouMin,
    edgeTolSec,
    rows,
    activeRow: active ?? rows[0] ?? null,
    errorCases,
    summaryCounts: { total: details.length, err: fp + fn, fp, fn, boundaryBad, tp, tn },
    reporter,
  };
}

interface CachedEvalPayload {
  rows: EvalRow[];
  notes: string[];
  cachedAt: string;
}
const EVAL_MEM_CACHE = new Map<string, CachedEvalPayload>();

/** 生成稳定的打分缓存键（包含测试集、所选模型、类别、范围、IoU、核对模式、体型拆分及窗口签名） */
function buildEvalCacheKey(
  setId: number,
  picked: string[],
  labels: string[],
  scope: SeenScope,
  iou: number,
  checkedOnly: boolean,
  bySize: boolean,
  items: TestItem[],
): string {
  const sig = JSON.stringify([
    setId,
    [...picked].sort(),
    [...labels].sort(),
    scope,
    Math.round(iou * 1000),
    checkedOnly ? 1 : 0,
    bySize ? 1 : 0,
    items.length,
    items.map((i) => `${i.id}:${i.start_ms ?? 0}:${i.end_ms ?? 0}:${i.checked ? 1 : 0}`).join(","),
  ]);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < sig.length; i++) {
    const c = sig.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return `v1_${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function EvalTab({ setId, testSet, coverage, planTarget, items: allItems, colors, opening, promoting, frozen, onOpenTask, onPromoteItem }: {
  setId: number; testSet: TestSet; coverage?: Coverage | null; planTarget?: string | null; items: TestItem[]; colors: Record<string, string>;
  opening: number | null; promoting: number | null; frozen?: boolean;
  onOpenTask: (taskId: number, seekMs: number, opts?: OpenTaskOpts) => void;
  onPromoteItem: (itemId: number) => void;
}) {
  const user = useAuthStore((s) => s.userInfo);
  const targetLb = planTarget || "抓挠";
  const p = useEvalPicker(setId, targetLb);
  const items = useMemo(() => (p.checkedOnly ? allItems.filter((i) => i.checked) : allItems), [allItems, p.checkedOnly]);
  const { options: modeOptions } = useInferModes();
  const [runModes, setRunModes] = useState<string[]>([]);
  const [bySize, setBySize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allRows, setAllRows] = useState<EvalRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [edgeTolSec, setEdgeTolSec] = useState<number>(2);
  const [showIouDetail, setShowIouDetail] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareModal, setShareModal] = useState<{ url: string; title: string } | null>(null);
  const evalSeqRef = useRef(0);
  const forceNextRef = useRef(false);
  const prevStatus = useRef<string | undefined>(undefined);
  const { data: prog, refetch: refetchProg } = useQuery({
    queryKey: ["eval-run-progress"], queryFn: getEvalRunProgress,
    refetchInterval: 3000,
  });

  // 统计当前测试集（数据集）里实际各标了多少次，并结合已选模型输出的类别动态生成类别切换栏
  const datasetCounts = useMemo(() => {
    const c: Record<string, number> = {};
    items.forEach((it) => {
      Object.entries(it.labels ?? {}).forEach(([k, v]) => { c[k] = (c[k] ?? 0) + v.n; });
      Object.entries(it.leaf ?? {}).forEach(([k, n]) => { if (!(k in c)) c[k] = (c[k] ?? 0) + n; });
    });
    return c;
  }, [items]);

  const modelClasses = useMemo(
    () => Array.from(new Set(p.pickedRuns.flatMap((r) => r.classes ?? []))),
    [p.pickedRuns],
  );

  const evalLabels = useMemo(() => {
    const raw = modelClasses.length > 0
      ? Array.from(new Set([targetLb, ...modelClasses]))
      : Array.from(new Set([targetLb, ...Object.keys(items.reduce<Record<string, 1>>((m, it) => {
          Object.keys(it.labels ?? {}).forEach((k) => { m[k] = 1; });
          return m;
        }, {})), ...EVAL_LABELS]));
    const rankOf = (x: string) => {
      if (x === targetLb) return -1;
      const i = LABEL_ORDER.indexOf(x);
      return i < 0 ? 99 : i;
    };
    return raw.sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
  }, [targetLb, modelClasses, items]);

  const extraDatasetLabels = useMemo(() => {
    const topCounts: Record<string, number> = {};
    items.forEach((it) => {
      Object.entries(it.labels ?? {}).forEach(([k, v]) => { topCounts[k] = (topCounts[k] ?? 0) + v.n; });
    });
    return Object.entries(topCounts).filter(([k, n]) => n > 0 && !evalLabels.includes(k));
  }, [items, evalLabels]);

  useEffect(() => {
    if (p.label !== "ALL" && !evalLabels.includes(p.label)) {
      p.setLabel(evalLabels[0] ?? targetLb);
    }
  }, [evalLabels, p.label, targetLb]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkedCount = useMemo(() => allItems.filter((i) => i.checked).length, [allItems]);
  const targetSamples = useMemo(() => Array.from(new Set(items.map((i) => i.sample_id))), [items]);

  const run = async () => {
    if (!runModes.length) return message.warning("请先选要测的模型");
    if (!targetSamples.length) {
      return message.warning(p.checkedOnly ? "还没有已核对的片段，请先去「片段」页核对或切到「测全部」" : "当前测试集还没有片段");
    }
    const r = await startEvalRun({ test_set_id: setId, sample_ids: targetSamples, modes: runModes });
    message[r.started ? "success" : "warning"](
      r.started
        ? `开始跑：${r.n_samples} 个样本（${p.checkedOnly ? `已核对 ${items.length} 段` : `全部 ${items.length} 段`}）× ${r.modes.length} 个模型，跑完自动记录并出分`
        : "已经有一批在跑了，请等它跑完",
    );
    refetchProg();
  };

  const removeRecordedPicked = async () => {
    evalSeqRef.current += 1;
    setBusy(false);
    setAllRows([]);
    setSelectedKey(null);
    setNotes([]);
    for (const vk of p.picked) {
      await deleteTestSetEvalRun(setId, vk);
    }
    const res = await p.refetchRuns();
    const rem = (res.data?.runs ?? []).map((r) => `${r.model_tag}::${r.mode}`);
    p.setPicked(rem.slice(0, 1));
    message.success("已从当前测试集移除该模型的跑批记录");
  };

  const scoreWith = async (usePicked: string[], labelsToEval: string[], force = false) => {
    const seq = ++evalSeqRef.current;
    const vers = usePicked.map((x) => { const [model_tag, mode] = x.split("::"); return { model_tag, mode }; });
    if (!vers.length) { setAllRows([]); setSelectedKey(null); setNotes([]); setCachedAt(null); setBusy(false); return; }
    if (!items.length) {
      setAllRows([]);
      setSelectedKey(null);
      setCachedAt(null);
      setNotes([p.checkedOnly ? "还没有核对过的片段：可到「片段」页点「一键全部通过」，或在右上角「设置」里取消勾选「只用核对过的」" : "当前测试集没有片段"]);
      setBusy(false);
      return;
    }
    const ck = buildEvalCacheKey(setId, usePicked, labelsToEval, p.scope, 0.3, p.checkedOnly, bySize, items);
    const memKey = `${setId}:${ck}`;
    if (!force) {
      const mem = EVAL_MEM_CACHE.get(memKey);
      if (mem) {
        setAllRows(mem.rows);
        setNotes(mem.notes);
        setCachedAt(mem.cachedAt);
        setBusy(false);
        return;
      }
    }
    setBusy(true);
    try {
      if (!force) {
        try {
          const hit = await getEvalCache<CachedEvalPayload>(setId, ck);
          if (seq !== evalSeqRef.current) return;
          if (hit.hit && hit.data && Array.isArray(hit.data.rows)) {
            EVAL_MEM_CACHE.set(memKey, hit.data);
            setAllRows(hit.data.rows);
            setNotes(hit.data.notes ?? []);
            setCachedAt(hit.data.cachedAt ?? null);
            return;
          }
        } catch {
          // 缓存读取失败不阻塞正常打分
        }
      }
      const ns: string[] = [];
      const parts = await scopeParts(setId, items, usePicked, p.scope, ns);
      if (seq !== evalSeqRef.current) return;
      const groups: [string, number[]][] = [];
      for (const [pname, use] of parts) {
        if (!use.length) continue;
        groups.push([pname, use]);
        if (bySize) {
          for (const sz of [...SIZES, null]) {
            const ids = Array.from(new Set(items.filter((i) => (sz == null ? !SIZES.includes(i.size ?? "") : i.size === sz)
              && use.includes(i.sample_id)).map((i) => i.sample_id)));
            if (ids.length) groups.push([`${pname}·${sz == null ? "体型未知" : `${sz}型犬`}`, ids]);
          }
        }
      }
      if (!groups.length) {
        ns.push("当前筛选条件下没有符合的样本，可在「设置」里切换为「全部」或「见过 / 没见过 分开看」");
      }
      // 一次拉回模型与数据集对应的全部类别（后端共享缓存 + 并发合并读 NAS），之后切换类别 0ms 本地过滤
      const jobs = labelsToEval.flatMap((lb) =>
        groups.filter(([, ids]) => ids.length).map(([g, ids]) => ({ lb, g, ids }))
      );
      const results = await Promise.all(
        jobs.map(async ({ lb, g, ids }) => ({
          lb, g, ids,
          r: await compareModels({
            sample_ids: ids,
            versions: vers,
            label: lb,
            iou_min: 0.3,
            windows: windowsOf(items, ids),
            task_ids: taskIdsOf(items, ids),
            include_curve: false,
          }),
        }))
      );
      if (seq !== evalSeqRef.current) return;
      const out: EvalRow[] = [];
      for (const { lb, g, ids, r } of results) {
        r.warnings.forEach((w) => ns.push(w.includes("没有人工标的") ? `【${lb}】${g}：${w}` : `${g}：${w}`));
        r.versions.forEach((v) => out.push({
          key: `${lb}-${g}-${v.key}`,
          label: lb,
          group: g,
          n: ids.length,
          version: formatEvalVersion(v.model_tag, v.mode, p.mvByJob),
          r: v,
        }));
      }
      const uniqNotes = Array.from(new Set(ns));
      const payload: CachedEvalPayload = { rows: out, notes: uniqNotes, cachedAt: new Date().toISOString() };
      EVAL_MEM_CACHE.set(memKey, payload);
      saveEvalCache(setId, ck, payload).catch(() => {});
      setAllRows(out);
      setNotes(uniqNotes);
      setCachedAt(payload.cachedAt);
    } finally {
      if (seq === evalSeqRef.current) setBusy(false);
    }
  };

  const rows = useMemo(() => {
    const filtered = p.label === "ALL" ? allRows : allRows.filter((r) => r.label === p.label);
    return filtered.map((x) => ({ ...x, r: recomputeVersionAt(x.r, p.iou, edgeTolSec) }));
  }, [allRows, p.label, p.iou, edgeTolSec]);

  const activeRowForPanel = useMemo(
    () => rows.find((r) => r.key === selectedKey) ?? rows.find((r) => r.r.window_details?.length) ?? rows[0] ?? null,
    [rows, selectedKey],
  );

  const iouAnalysis = useMemo(
    () => (activeRowForPanel?.r.window_details?.length ? analyzeIouAndEdge(activeRowForPanel.r.window_details, p.iou) : null),
    [activeRowForPanel, p.iou],
  );

  // 只要已选模型 / 设置 / 模型输出类别变了，优先读已存快照（秒切免重算），未命中再算；切换类别与调 IoU/容差全部 0ms 本地重算
  const pickedKey = p.picked.join(",");
  const labelsKey = evalLabels.join(",");
  useEffect(() => {
    const force = forceNextRef.current;
    forceNextRef.current = false;
    if (p.picked.length) scoreWith(p.picked, evalLabels, force);
    else {
      evalSeqRef.current += 1;
      setBusy(false);
      setAllRows([]);
      setSelectedKey(null);
      setNotes([]);
      setCachedAt(null);
    }
  }, [setId, pickedKey, labelsKey, p.scope, p.checkedOnly, bySize, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // 推理刚从 running 变成 done：优先选中刚跑完的 produced 模型，自动强制重算并更新缓存
  useEffect(() => {
    const wasRunning = prevStatus.current === "running";
    prevStatus.current = prog?.status;
    if (wasRunning && prog?.status === "done") {
      p.refetchRuns().then((res) => {
        const produced = prog.produced ?? [];
        const ns = targetSamples.length || (res.data?.n_scope ?? 0);
        const fallback = (res.data?.runs ?? []).filter((r) => !ns || r.n_samples >= ns * 0.8).map((r) => `${r.model_tag}::${r.mode}`);
        const next = produced.length ? produced : fallback.slice(0, 1);
        if (next.length) {
          forceNextRef.current = true;
          if (next.join(",") === p.picked.join(",")) {
            scoreWith(next, evalLabels, true);
          } else {
            p.setPicked(next);
          }
          message.success("推理完成，已自动比对出分");
        }
      });
    }
  }, [prog?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const colorOf = (k: string): string | undefined => colors[k] ?? (k === "其他" ? "#8c8c8c" : undefined);
  const pctProg = prog?.total ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0;
  const settingsContent = (
    <Space direction="vertical" size={10} style={{ width: 240 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>样本范围</span>
        <Select size="small" style={{ width: 155 }} value={p.scope} onChange={(v) => p.setScope(v as SeenScope)} options={SCOPE_OPTIONS} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Tooltip title="预测段和标注段重叠比例达到多少算命中（默认 0.3）"><span>重叠门槛 IoU ≥</span></Tooltip>
        <InputNumber size="small" min={0.05} max={0.95} step={0.05} value={p.iou} onChange={(v) => p.setIou(v ?? 0.3)} style={{ width: 80 }} />
      </div>
      <Checkbox checked={p.checkedOnly} onChange={(e) => p.setCheckedOnly(e.target.checked)}>只用核对过的片段</Checkbox>
      <Checkbox checked={bySize} onChange={(e) => setBySize(e.target.checked)}>按小 / 中 / 大型犬拆开看</Checkbox>
    </Space>
  );

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      {/* 极简主栏：选模型 → 选范围（已核对 / 全部） → 跑并打分，高级参数收进「设置」 */}
      <Space wrap align="center">
        <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ minWidth: 360 }}
          popupMatchSelectWidth={false}
          dropdownStyle={{ minWidth: 520, maxWidth: "85vw" }}
          placeholder="选模型来跑测试集（可多选，搜 #61 等）"
          value={runModes} onChange={setRunModes} options={modeOptions as never} maxTagCount={3} />
        <Segmented
          value={p.checkedOnly ? "checked" : "all"}
          onChange={(v) => p.setCheckedOnly(v === "checked")}
          options={[
            { value: "checked", label: `只测已核对 (${checkedCount})` },
            { value: "all", label: `测全部 (${allItems.length})` },
          ]}
        />
        <Button type="primary" onClick={run} disabled={prog?.status === "running" || !targetSamples.length}>
          {prog?.status === "running"
            ? `正在跑 ${prog.done}/${prog.total}…`
            : `跑并打分（${targetSamples.length} 个样本 · ${items.length} 段）`}
        </Button>
        <Popover trigger="click" title="评测设置" content={settingsContent}>
          <Button icon={<SettingOutlined />}>设置</Button>
        </Popover>
      </Space>

      {prog?.status === "running" && (
        <div>
          <Progress percent={pctProg} size="small" status="active" format={() => `${prog.done}/${prog.total}`} />
          {prog.current && <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前：{prog.current}</Typography.Text>}
        </div>
      )}
      {prog?.status === "error" && (
        <Alert type="error" showIcon message={`推理出错：${prog.detail.slice(-3).join("；") || "请查看后端日志"}`} />
      )}

      {/* 类别一键切换（自动对齐模型输出类别与当前测试集标注） + 本测试集已跑过的模型 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Space wrap size={6} align="center" style={{ maxWidth: "100%" }}>
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <Segmented
              value={p.label}
              onChange={(v) => { p.setLabel(String(v)); setSelectedKey(null); }}
              options={[
                { value: "ALL", label: "全部类别" },
                ...evalLabels.map((x) => ({
                  value: x,
                  label: (
                    <span>
                      {x}
                      {datasetCounts[x] != null && (
                        <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 3 }}>{datasetCounts[x]}</span>
                      )}
                    </span>
                  ),
                })),
              ]}
            />
          </div>
          {extraDatasetLabels.length > 0 && (
            <Tooltip title="测试集窗口里还标了这些负例锚点动作，但当前所选模型的后处理未单独输出该类别（通常并入「活动」）">
              <Typography.Text type="secondary" style={{ fontSize: 11, cursor: "help" }}>
                另有标注：{extraDatasetLabels.map(([k, n]) => `${k} ${n}`).join("、")}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
        {p.options.length > 0 && (
          <Space wrap align="center" size={[6, 6]}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>本集已跑模型：</Typography.Text>
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" size="small"
              style={{ width: 340, maxWidth: "100%" }} popupMatchSelectWidth={false}
              placeholder="勾选在本测试集跑过的模型看分"
              value={p.picked} onChange={p.setPicked} options={p.options} maxTagCount={1} />
            <Tooltip title="强制按最新标注重新比对并刷新缓存（平时切换模型直接复用已存结果）">
              <Button size="small" loading={busy} onClick={() => scoreWith(p.picked, evalLabels, true)} disabled={!p.picked.length}>刷新打分</Button>
            </Tooltip>
            {!busy && cachedAt && rows.length > 0 && (
              <Tooltip title={`已存结果（${new Date(cachedAt).toLocaleString()}），切换模型或刷新页面直接秒开；若刚改过标注可点「刷新打分」重算`}>
                <Typography.Text type="secondary" style={{ fontSize: 11, cursor: "help" }}>
                  已缓存 {new Date(cachedAt).toTimeString().slice(0, 5)}
                </Typography.Text>
              </Tooltip>
            )}
            <Tooltip title="导出独立的离线 HTML 标准测试报告（含指标对比、数据覆盖图、可筛选错例时间轴，支持打印/转 PDF）">
              <Button size="small" icon={<DownloadOutlined />} disabled={!rows.length} onClick={() => {
                const activeRow = rows.find((r) => r.key === selectedKey) ?? rows.find((r) => r.r.window_details?.length) ?? rows[0];
                const html = buildTestReportHtml(buildReportPayload(
                  testSet, coverage, items, p.label, p.iou, edgeTolSec, rows, activeRow, user?.display_name || user?.username,
                ));
                const safeName = (testSet.name || `set_${setId}`).replace(/[\\/:*?"<>|\s]+/g, "_");
                const lbName = (p.label === "ALL" ? "全部类别" : p.label).replace(/[\\/:*?"<>|\s]+/g, "_");
                const dStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
                const blob = new Blob([html], { type: "text/html;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `测试报告_${safeName}_${lbName}_${dStr}.html`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                message.success("已导出标准 HTML 测试报告");
              }}>导出 HTML</Button>
            </Tooltip>
            <Tooltip title="生成只读测试报告分享链接，发给团队成员即可免登录直接打开查看">
              <Button size="small" icon={<ShareAltOutlined />} loading={sharing} disabled={!rows.length} onClick={async () => {
                setSharing(true);
                try {
                  const activeRow = rows.find((r) => r.key === selectedKey) ?? rows.find((r) => r.r.window_details?.length) ?? rows[0];
                  const lbName = p.label === "ALL" ? "全部类别" : p.label;
                  const title = `${testSet.name} · ${lbName} 测试报告`;
                  const html = buildTestReportHtml(buildReportPayload(
                    testSet, coverage, items, p.label, p.iou, edgeTolSec, rows, activeRow, user?.display_name || user?.username,
                  ));
                  const res = await publishTestReport(setId, html, title);
                  const fullUrl = `${window.location.origin}${res.url}`;
                  try { await navigator.clipboard?.writeText(fullUrl); } catch { /* ignore */ }
                  setShareModal({ url: fullUrl, title });
                } finally {
                  setSharing(false);
                }
              }}>分享链接</Button>
            </Tooltip>
            {p.picked.length > 0 && (
              <Popconfirm
                title="从本测试集移除当前选中的模型跑批记录？"
                description="移除后它不再出现在本测试集的下拉框里（重跑即可恢复）。"
                okText="移除记录"
                okButtonProps={{ danger: true }}
                onConfirm={removeRecordedPicked}
              >
                <Button size="small" type="text" danger>移除记录</Button>
              </Popconfirm>
            )}
          </Space>
        )}
      </div>

      {/* 实时评估门槛试算条（0ms 本地重算，不重新请求后端） */}
      {rows.length > 0 && (
        <div style={{
          padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,0.22)",
          background: "rgba(128,128,128,0.04)", display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <Space wrap size={10} align="center">
              <Tooltip title="预测动作时段与人工标注的重叠比例门槛（交并比）。拖动滑块可 0ms 实时看事件级 F1 变化">
                <span style={{ fontSize: 12, fontWeight: 600, color: "#b37feb", cursor: "help" }}>
                  事件重叠门槛 (IoU ≥ {Math.round(p.iou * 100)}%)
                </span>
              </Tooltip>
              <Slider
                min={0.05} max={0.8} step={0.05} value={p.iou}
                onChange={(v) => p.setIou(v)}
                tooltip={{ formatter: (v) => `IoU ≥ ${Math.round((v ?? 0) * 100)}%` }}
                style={{ width: 150, margin: "0 4px" }}
              />
              <Space size={4}>
                {[0.1, 0.2, 0.3, 0.5].map((v) => (
                  <Button key={v} size="small" type={Math.abs(p.iou - v) < 0.001 ? "primary" : "default"}
                    style={{ padding: "0 7px", fontSize: 11, height: 22 }}
                    onClick={() => p.setIou(v)}>
                    {Math.round(v * 100)}%
                  </Button>
                ))}
              </Space>
            </Space>
            <Space wrap size={10} align="center">
              <Tooltip title="抓对的动作里，开始/结束时间偏差在多少秒内算「对齐」（动作本身较长或有滑窗延迟时可放宽到 ±3s 或 ±5s）">
                <span style={{ fontSize: 12, fontWeight: 600, color: "#36cfc9", cursor: "help" }}>起止容差：</span>
              </Tooltip>
              <Segmented size="small" value={edgeTolSec} onChange={(v) => setEdgeTolSec(Number(v))}
                options={[1, 2, 3, 5].map((s) => ({ value: s, label: `±${s}s` }))} />
              {iouAnalysis && (
                <Button size="small" type={showIouDetail ? "primary" : "default"} ghost={showIouDetail}
                  onClick={() => setShowIouDetail((v) => !v)}>
                  {showIouDetail ? "收起 IoU 分布" : "查看 IoU 分布与各档对比"}
                </Button>
              )}
            </Space>
          </div>

          {showIouDetail && iouAnalysis && (
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14,
              paddingTop: 8, borderTop: "1px dashed rgba(128,128,128,0.22)",
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  所有重叠配对的 IoU 分布（共 {iouAnalysis.totalOverlapped} 对有重叠 / 人工 {iouAnalysis.totalTruth} 次 / 预测 {iouAnalysis.totalPred} 次）
                </div>
                {(() => {
                  const maxC = Math.max(1, ...iouAnalysis.buckets.map((b) => b.count));
                  return iouAnalysis.buckets.map((b) => {
                    const passed = b.min >= p.iou - 1e-6;
                    return (
                      <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}>
                        <span style={{ width: 58, color: passed ? "#ddd" : "#888" }}>{b.label}</span>
                        <div style={{ flex: 1, height: 14, background: "rgba(128,128,128,0.16)", borderRadius: 3, overflow: "hidden" }}>
                          <div style={{
                            width: `${b.count ? Math.max(4, Math.round((b.count / maxC) * 100)) : 0}%`,
                            height: "100%", background: b.color, opacity: passed ? 1 : 0.4,
                          }} />
                        </div>
                        <span style={{ width: 62, textAlign: "right", fontSize: 11, color: passed ? "#52c41a" : "#888" }}>
                          {b.count} 对 {passed ? "✓" : ""}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>各 IoU 门槛下的事件级表现（点击行可直接切换）</div>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: "#999", borderBottom: "1px solid rgba(128,128,128,0.22)" }}>
                      <th style={{ textAlign: "left", padding: "3px 4px" }}>IoU 门槛</th>
                      <th style={{ textAlign: "right", padding: "3px 4px" }}>精确率</th>
                      <th style={{ textAlign: "right", padding: "3px 4px" }}>召回率</th>
                      <th style={{ textAlign: "right", padding: "3px 4px" }}>事件 F1</th>
                      <th style={{ textAlign: "right", padding: "3px 4px" }}>对/误/漏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {iouAnalysis.iouSweep.map((s) => {
                      const cur = Math.abs(s.iou - p.iou) < 0.001;
                      return (
                        <tr key={s.iou} onClick={() => p.setIou(s.iou)} style={{
                          cursor: "pointer",
                          background: cur ? "rgba(179,127,235,0.14)" : undefined,
                          borderBottom: "1px solid rgba(128,128,128,0.12)",
                        }}>
                          <td style={{ padding: "4px", fontWeight: cur ? 700 : 400 }}>≥ {Math.round(s.iou * 100)}%</td>
                          <td style={{ textAlign: "right", padding: "4px" }}>{pct(s.precision)}</td>
                          <td style={{ textAlign: "right", padding: "4px" }}>{pct(s.recall)}</td>
                          <td style={{ textAlign: "right", padding: "4px", fontWeight: 700, color: "#b37feb" }}>{pct(s.f1)}</td>
                          <td style={{ textAlign: "right", padding: "4px", fontSize: 11 }}>{s.tp}/{s.fp}/{s.fn}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: "#999", marginTop: 6 }}>
                  当前 IoU 下起止对齐率：
                  {iouAnalysis.edgeSweep.map((e) => (
                    <Tag key={e.tolSec} color={e.tolSec === edgeTolSec ? "cyan" : "default"}
                      style={{ cursor: "pointer", marginInlineEnd: 4, fontSize: 11 }}
                      onClick={() => setEdgeTolSec(e.tolSec)}>
                      ±{e.tolSec}s: {e.ratio != null ? pct(e.ratio) : "-"}
                    </Tag>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 && <EvalNotes notes={notes} hasRows={false} />}
      <Table
        size="small" bordered rowKey="key" pagination={false} loading={busy} scroll={{ x: 1320 }} dataSource={rows}
        columns={evalColumns("范围", p.label === "ALL", colorOf, p.iou, edgeTolSec)}
        onRow={(r) => ({
          onClick: () => setSelectedKey(r.key),
          style: { cursor: "pointer", background: (selectedKey ?? rows[0]?.key) === r.key ? "rgba(22, 119, 255, 0.08)" : undefined },
        })}
        locale={{
          emptyText: "在上方选好模型，点「跑并打分」，跑完后会自动跟标注比对并显示结果",
        }}
      />
      {rows.length > 0 && <EvalNotes notes={notes} hasRows />}
      {activeRowForPanel ? (
        <EvalVisualPanel row={activeRowForPanel} iouMin={p.iou} edgeTolSec={edgeTolSec} items={items} colors={colors} opening={opening}
          promoting={promoting} frozen={frozen} onOpenTask={onOpenTask} onPromoteItem={onPromoteItem} />
      ) : null}
      <Modal
        open={!!shareModal}
        title="测试报告分享链接已生成"
        onCancel={() => setShareModal(null)}
        footer={[
          <Button key="open" icon={<ExportOutlined />} onClick={() => shareModal && window.open(shareModal.url, "_blank", "noopener")}>
            新标签页预览
          </Button>,
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={async () => {
            if (!shareModal) return;
            try {
              await navigator.clipboard.writeText(shareModal.url);
              message.success("链接已复制到剪贴板");
            } catch {
              message.info("请手动复制输入框中的链接");
            }
          }}>复制链接</Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={10}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            该链接为独立静态 HTML 测试报告，团队成员在内网无需登录即可只读查看或打印为 PDF：
          </Typography.Text>
          <Input readOnly value={shareModal?.url ?? ""} onFocus={(e) => e.target.select()} />
        </Space>
      </Modal>
    </Space>
  );
}

/** 多批交叉对比：同一组模型在几批测试集上各打一次分，看平均和波动——只在一批上好，可能是那一批碰巧 */
function CrossTab({ sets }: { sets: TestSet[] }) {
  const [setIds, setSetIds] = useState<number[]>([]);
  const p = useEvalPicker(undefined, "抓挠", setIds);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  const score = async () => {
    if (setIds.length < 2) return message.warning("至少选两批测试集");
    if (!p.versions.length) return message.warning("选要比的版本");
    setBusy(true);
    try {
      const out: EvalRow[] = [];
      const ns: string[] = [];
      for (const sid of setIds) {
        const s = sets.find((x) => x.id === sid)!;
        const got = await getTestItems(sid);
        const items = p.checkedOnly ? got.items.filter((i) => i.checked) : got.items;
        if (p.checkedOnly) ns.push(`「${s.name}」只用核对过的 ${items.length} / ${got.items.length} 段`);
        if (!items.length) continue;
        const parts = await scopeParts(sid, items, p.picked, p.scope, ns, `「${s.name}」`);
        for (const [pname, use] of parts) {
          if (!use.length) { ns.push(`${pname}没有可用样本`); continue; }
          const r = await compareModels({ sample_ids: use, versions: p.versions, label: p.label, iou_min: p.iou, windows: windowsOf(items, use), task_ids: taskIdsOf(items, use) });
          r.versions.forEach((v) => out.push({ key: `${sid}-${pname}-${v.key}`, group: parts.length > 1 ? `${s.name}·${pname.replace(`「${s.name}」`, "")}` : s.name, n: use.length, version: formatEvalVersion(v.model_tag, v.mode, p.mvByJob), r: v }));
        }
      }
      setRows(out);
      setNotes(Array.from(new Set(ns)));
    } finally {
      setBusy(false);
    }
  };

  // 每个版本：几批的 F1 / 精确率 / 召回率 平均 ± 标准差
  const summary = useMemo(() => {
    const by = new Map<string, EvalRow[]>();
    // 分开看时，见过 / 没见过各算各的平均，不混在一起
    const keyOf = (r: EvalRow) => r.version + (r.group.endsWith("·见过") ? "（见过）" : r.group.endsWith("·没见过") ? "（没见过）" : "");
    rows.forEach((r) => by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]));
    return Array.from(by.entries()).map(([version, rs]) => {
      const P = rs.map((x) => x.r.precision), R = rs.map((x) => x.r.recall), F = rs.map((x) => f1(x.r.precision, x.r.recall));
      return { version, n: rs.length, P, R, F };
    });
  }, [rows]);
  const ms = (xs: number[]) => `${pct(mean(xs))} ± ${(std(xs) * 100).toFixed(1)}`;

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={
        <span>交叉验证：同一组模型在<b>几批互不重叠</b>的测试集上各打一次分，看平均和波动（±）。
          波动大说明结论不稳：要么某批数据太少，要么模型对某些狗 / 场景特别差。
          几批最好按不同的狗 / 日期分，别是同一批数据随便切几刀。</span>} />
      <Space wrap>
        <Select mode="multiple" style={{ minWidth: 320 }} placeholder="选几批测试集" value={setIds} onChange={setSetIds}
          options={sets.map((s) => ({ value: s.id, label: `${s.name}（${s.n_samples} 个样本）${s.frozen ? " · 已冻结" : ""}` }))} />
      </Space>
      <EvalPickerBar p={p} extra={<Button type="primary" loading={busy} onClick={score}>打分</Button>} />
      {rows.length === 0 && <EvalNotes notes={notes} hasRows={false} />}
      {summary.length > 0 && (
        <Table size="small" rowKey="version" pagination={false} dataSource={summary}
          columns={[
            { title: "版本", dataIndex: "version" },
            { title: "批数", dataIndex: "n", width: 60 },
            { title: "F1 平均 ± 标准差", render: (_, x) => <b>{ms(x.F)}</b> },
            { title: "精确率", render: (_, x) => ms(x.P) },
            { title: "召回率", render: (_, x) => ms(x.R) },
            { title: "最差一批 F1", render: (_, x) => pct(Math.min(...x.F)) },
          ]} />
      )}
      <Table size="small" rowKey="key" pagination={false} dataSource={rows} columns={evalColumns("测试集", false, undefined, p.iou)} />
      {rows.length > 0 && <EvalNotes notes={notes} hasRows />}
    </Space>
  );
}

// ───────────────────────── 见没见过 ─────────────────────────
function SeenTab({ setId }: { setId: number }) {
  const [ids, setIds] = useState<number[]>([]);
  const { data: mvs } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions });
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["model-test-seen", setId, ids], queryFn: () => getTestSeen(setId, ids), enabled: false,
  });
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        「见过」= 这段所在的样本在模型训练用的数据集里。不选就看「上架的 + 最近 5 个训练完的」。正式成绩只看没见过的。
      </Typography.Text>
      <Space wrap>
        <Select mode="multiple" style={{ minWidth: 420 }} placeholder="选训练记录（可空）" value={ids} onChange={setIds}
          options={(mvs ?? []).filter((m) => m.status === "done").map((m) => ({ value: m.id, label: `#${m.id} train${m.algo_job_id} ${m.model_version ?? ""}` }))} />
        <Button type="primary" loading={isFetching} onClick={() => refetch()}>查</Button>
      </Space>
      {data && (
        <Table size="small" rowKey="model_id" pagination={false} dataSource={data.models}
          columns={[
            { title: "训练记录", render: (_, m) => <span>#{m.model_id} train{m.algo_job_id} {m.listed && <Tag color="green">已启用</Tag>}</span> },
            { title: "版本", dataIndex: "model_version" },
            { title: "没见过", render: (_, m) => <b style={{ color: "#52c41a" }}>{m.n_unseen}</b> },
            { title: "见过", render: (_, m) => <span style={{ color: m.n_seen ? "#ff4d4f" : undefined }}>{m.n_seen}</span> },
            { title: "训练数据集", render: (_, m) => (
              <Space size={2} wrap>
                {m.datasets.map((d) => <Tag key={d} color={m.missing_datasets.includes(d) ? "red" : undefined}>
                  {d}{m.missing_datasets.includes(d) ? "（找不到导出文件，不知道）" : ""}</Tag>)}
              </Space>) },
          ]} />
      )}
    </Space>
  );
}

// ───────────────────────── 一批测试集 ─────────────────────────
function SetDetail({ setId }: { setId: number }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);
  const [wsWin, setWsWin] = useState<{
    startMs: number;
    endMs: number;
    loopRange?: { startMs: number; endMs: number };
    evalHint?: EvalWindowHint;
  } | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["model-test-items", setId], queryFn: () => getTestItems(setId) });
  // 在这一页直接打开工作台看 / 标：开在窗口开头。没认领时只读，工作台里点「认领」就能标
  const userId = useAuthStore((st) => st.userInfo?.id);
  const role = useAuthStore((st) => st.userInfo?.role);
  // 管理员 / 超管不用认领，没通过的任务直接改（后端 save_draft 放行）；已通过的要先「继续编辑」
  const isAdmin = role === "admin" || role === "super_admin";
  const [wsTask, setWsTask] = useState<Task | null>(null);
  const [wsLabels, setWsLabels] = useState<LabelDefinition[]>([]);
  const [wsSeekMs, setWsSeekMs] = useState<number | null>(null);
  const [wsItemId, setWsItemId] = useState<number | null>(null);
  const [wsWasApproved, setWsWasApproved] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [promoting, setPromoting] = useState<number | null>(null);
  const [pickedTestIds, setPickedTestIds] = useState<number[]>([]);
  const [batchPromoting, setBatchPromoting] = useState(false);
  const [batchRemoving, setBatchRemoving] = useState(false);
  const [itemSiteFilter, setItemSiteFilter] = useState<string | null>(null);
  useEffect(() => { setPickedTestIds([]); setItemSiteFilter(null); }, [setId]);
  const batchRemoveSelected = async () => {
    if (!pickedTestIds.length) return;
    setBatchRemoving(true);
    try {
      const r = await batchRemoveTestItems(setId, pickedTestIds);
      message.success(
        `已从本测试集移出 ${r.removed} 段，并保留在测试数据池（原标注和已核对状态不丢失，其他测试集复用可继续续上）`,
        5,
      );
      setPickedTestIds([]);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      qc.invalidateQueries({ queryKey: ["test-pool"] });
    } finally {
      setBatchRemoving(false);
    }
  };
  const batchPromoteSelected = async () => {
    if (!pickedTestIds.length) return;
    setBatchPromoting(true);
    try {
      const r = await batchPromoteTestItems(pickedTestIds);
      message.success(
        `已将 ${r.moved_windows} 个窗口拨到训练数据池（${r.pooled_segments} 条片段入训练池，移出 ${r.removed_from_sets} 条测试项）`,
        5,
      );
      setPickedTestIds([]);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      qc.invalidateQueries({ queryKey: ["data-pool"] });
      qc.invalidateQueries({ queryKey: ["test-pool"] });
    } finally {
      setBatchPromoting(false);
    }
  };
  const [checkingAll, setCheckingAll] = useState(false);
  const [itemCheckFilter, setItemCheckFilter] = useState<"all" | "unchecked" | "checked">("all");
  const [itemCleanFilter, setItemCleanFilter] = useState<"all" | "dedupe" | "merge">("all");
  const [itemSort, setItemSort] = useState<"default" | "dedupe" | "merge">("default");
  const [cleaning, setCleaning] = useState<"" | "dedupe" | "merge">("");
  const runDedupe = async (ids?: number[]) => {
    setCleaning("dedupe");
    try {
      const r = await dedupeTestSet(setId, ids);
      const parts: string[] = [];
      if (r.removed) parts.push(`合并/删重 ${r.removed} 条`);
      if (r.carved) parts.push(`挖空运动 ${r.carved} 处`);
      if (r.conflicts) parts.push(`剩余异类冲突 ${r.conflicts} 处需人工看`);
      message.success(parts.length ? `一键去重完成（${r.tasks_cleaned} 个任务）：${parts.join("，")}` : "没有需要自动去重的重叠片段", 5);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
    } finally {
      setCleaning("");
    }
  };
  const runMergeAdjacent = async (ids?: number[]) => {
    setCleaning("merge");
    try {
      const r = await mergeAdjacentTestSet(setId, ids, 1500);
      message.success(
        r.groups_merged
          ? `一键合并完成（${r.windows_cleaned} 个窗口）：合并 ${r.groups_merged} 组、消掉 ${r.removed} 条碎片`
          : "没有间隔 ≤1.5s 的相邻同类可合并",
        5,
      );
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
    } finally {
      setCleaning("");
    }
  };
  const [detailTab, setDetailTab] = useState<string>(() => {
    try { return localStorage.getItem("smart-label:model-test-tab") || "plan"; } catch { return "plan"; }
  });
  const onDetailTabChange = (k: string) => {
    setDetailTab(k);
    try { localStorage.setItem("smart-label:model-test-tab", k); } catch { /* ignore */ }
  };
  const openTask = async (taskId: number, seekMs: number, opts?: OpenTaskOpts) => {
    setOpening(taskId);
    try {
      const t = await getTask(taskId);
      setWsLabels(await listLabels(t.project_id));
      setWsSeekMs(seekMs);
      // 挂在原任务（整段样本）上的窗口：窗口边界保持完整，seekMs / loopRange 可直接定位到窗口内的具体秒数
      setWsWin(
        opts?.winStartMs != null && opts?.winEndMs != null
          ? { startMs: opts.winStartMs, endMs: opts.winEndMs, loopRange: opts.loopRange, evalHint: opts.evalHint }
          : null,
      );
      setWsItemId(opts?.itemId ?? null);
      setWsWasApproved(t.status === "APPROVED");
      setWsTask(t);
    } finally {
      setOpening(null);
    }
  };
  const closeWs = () => {
    setWsTask(null);
    setWsItemId(null);
    setWsWasApproved(false);
    // 标了东西回来，覆盖率 / 配额表跟着变
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
  };
  const promoteItem = async (itemId: number, restoreApproved = false) => {
    setPromoting(itemId);
    try {
      const r = await promoteTestItemToPool(itemId, restoreApproved);
      const extra = r.still_in_other_sets.length
        ? `（提示：其他测试集「${r.still_in_other_sets.join("、")}」仍包含该时段）`
        : "";
      message.success(`已人工审核通过 ${r.n_pooled} 条片段入数据池，并从本测试集剥离${extra}`);
      if (wsItemId === itemId) {
        setWsTask(null);
        setWsItemId(null);
        setWsWasApproved(false);
      }
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
    } finally {
      setPromoting(null);
    }
  };
  if (isLoading || !data) return <Table loading />;
  const frozen = data.set.frozen;
  const colors = data.colors ?? {};
  // 没配颜色的（「其他」之类）给个中性灰，免得一片白看不出来
  const colorOf = (k: string): string | undefined => colors[k] ?? (k === "其他" ? "#8c8c8c" : undefined);
  const labelRank = (k: string) => { const i = LABEL_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  const del = async (id: number) => {
    await deleteTestItem(id);
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
    qc.invalidateQueries({ queryKey: ["model-test-sets"] });
  };
  const toggleCheck = async (id: number, checked: boolean) => {
    await checkTestItem(id, checked);
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
  };
  const confirmItemChecked = async (itemId: number) => {
    await checkTestItem(itemId, true);
    message.success("已保存并标记为「已核对」（保留在测试集内，不入训练池）");
    closeWs();
  };
  const checkedCount = data.items.filter((i) => i.checked).length;
  const uncheckedCount = data.items.length - checkedCount;
  const dedupeWinCount = data.items.filter((i) => (i.n_dedupe ?? 0) > 0 || (i.n_conflict ?? 0) > 0).length;
  const dedupeAutoWinCount = data.items.filter((i) => (i.n_dedupe ?? 0) > 0).length;
  const mergeWinCount = data.items.filter((i) => (i.n_mergeable ?? 0) > 0).length;
  const totalMergeGroups = data.items.reduce((s, i) => s + (i.n_mergeable ?? 0), 0);
  const pendingCandsOf = (r: TestItem) =>
    Object.values(r.cands ?? {}).reduce((sum, v) => sum + (v.pending ?? 0), 0);
  const siteCounts = new Map<string, number>();
  for (const it of data.items) {
    const sk = it.site || "未知场地";
    siteCounts.set(sk, (siteCounts.get(sk) ?? 0) + 1);
  }
  const filteredItems = data.items
    .filter((i) => {
      if (itemCheckFilter === "checked" && !i.checked) return false;
      if (itemCheckFilter === "unchecked" && i.checked) return false;
      if (itemSiteFilter && (i.site || "未知场地") !== itemSiteFilter) return false;
      if (itemCleanFilter === "dedupe" && !((i.n_dedupe ?? 0) > 0 || (i.n_conflict ?? 0) > 0)) return false;
      if (itemCleanFilter === "merge" && !(i.n_mergeable ?? 0)) return false;
      return true;
    })
    .sort((a, b) => {
      if (itemSort === "dedupe") {
        return ((b.n_dedupe ?? 0) + (b.n_conflict ?? 0)) - ((a.n_dedupe ?? 0) + (a.n_conflict ?? 0));
      }
      if (itemSort === "merge") {
        return (b.n_mergeable ?? 0) - (a.n_mergeable ?? 0);
      }
      return 0;
    });
  const wsFromEval = !!wsWin?.evalHint;
  const checkAll = async (checked: boolean) => {
    setCheckingAll(true);
    try {
      const r = await checkAllTestItems(setId, checked);
      message.success(checked ? `已将全部 ${r.updated} 段标记为核对通过` : `已取消全部 ${r.updated} 段的核对`);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
    } finally {
      setCheckingAll(false);
    }
  };
  return (
    <>
      <Tabs activeKey={detailTab} onChange={onDetailTabChange} items={[
        { key: "plan", label: "配比", children: (
          <ModelTestPlan setId={setId} initial={data.set.plan ?? null} frozen={frozen} existing={data.items.length}
            accent={colors[data.set.plan?.target ?? "抓挠"] ?? "#27AE60"} />) },
        { key: "cov", label: "配额表", children: data.items.length ? <CoverageView cov={data.coverage} /> : <Empty description="还没有片段：点「片段」→「加片段」" /> },
        {
          key: "items", label: `片段 ${data.items.length}`, children: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Tooltip title="按场地 / 狗 / 日期 / 类别（含部位）从已有的标注片段里挑，先看配比再加">
                  <Button disabled={frozen} onClick={() => setComposing(true)}>按条件挑</Button>
                </Tooltip>
                <Button disabled={frozen} onClick={() => setAdding(true)}>手动加</Button>
                {data.items.length > 0 && (
                  <>
                    <Popconfirm
                      title={`将全部 ${data.items.length} 段标记为核对通过？`}
                      description="仅勾选测试集的「核对」状态（不动原标注任务状态），方便直接进入打分测试流程。"
                      okText="全部通过"
                      disabled={frozen || checkedCount === data.items.length}
                      onConfirm={() => checkAll(true)}
                    >
                      <Button type="primary" ghost loading={checkingAll} disabled={frozen || checkedCount === data.items.length}>
                        一键全部通过
                      </Button>
                    </Popconfirm>
                    {checkedCount > 0 && !frozen && (
                      <Popconfirm title="取消全部片段的核对状态？" okText="取消全部" onConfirm={() => checkAll(false)}>
                        <Button size="small" type="text" loading={checkingAll}>取消全部核对</Button>
                      </Popconfirm>
                    )}
                    <Segmented
                      size="small"
                      value={itemCheckFilter}
                      onChange={(v) => setItemCheckFilter(v as "all" | "unchecked" | "checked")}
                      options={[
                        { label: `全部 ${data.items.length}`, value: "all" },
                        { label: `未核对 ${uncheckedCount}`, value: "unchecked" },
                        { label: `已核对 ${checkedCount}`, value: "checked" },
                      ]}
                    />
                    <Segmented
                      size="small"
                      value={itemCleanFilter}
                      onChange={(v) => setItemCleanFilter(v as "all" | "dedupe" | "merge")}
                      options={[
                        { label: "全部质量", value: "all" },
                        {
                          label: <span style={{ color: dedupeWinCount > 0 ? "#fa8c16" : undefined }}>可去重 {dedupeWinCount}</span>,
                          value: "dedupe",
                        },
                        {
                          label: <span style={{ color: mergeWinCount > 0 ? "#13c2c2" : undefined }}>可合并 {mergeWinCount}</span>,
                          value: "merge",
                        },
                      ]}
                    />
                    <Select
                      size="small"
                      style={{ width: 126 }}
                      value={itemSort}
                      onChange={(v) => setItemSort(v)}
                      options={[
                        { value: "default", label: "默认排序" },
                        { value: "dedupe", label: "可去重排前" },
                        { value: "merge", label: "可合并排前" },
                      ]}
                    />
                    {!frozen && (dedupeAutoWinCount > 0 || pickedTestIds.length > 0) && (
                      <Popconfirm
                        title={pickedTestIds.length > 0
                          ? `对勾选的 ${pickedTestIds.length} 段执行一键去重？`
                          : `对整个测试集可去重的 ${dedupeAutoWinCount} 段执行一键去重？`}
                        description="自动合并同类重叠、细类压粗类、行为/活动挖空静止（不动已核对状态，异类冲突留给人工看）。"
                        okText="一键去重"
                        onConfirm={() => runDedupe(pickedTestIds.length > 0 ? pickedTestIds : undefined)}
                      >
                        <Button size="small" danger={dedupeAutoWinCount > 0} ghost loading={cleaning === "dedupe"}>
                          一键去重{pickedTestIds.length > 0 ? `（已选 ${pickedTestIds.length}）` : ` (${dedupeAutoWinCount}段)`}
                        </Button>
                      </Popconfirm>
                    )}
                    {!frozen && (mergeWinCount > 0 || pickedTestIds.length > 0) && (
                      <Popconfirm
                        title={pickedTestIds.length > 0
                          ? `合并勾选的 ${pickedTestIds.length} 段内相邻同类（间隔 ≤1.5s）？`
                          : `合并整个测试集 ${mergeWinCount} 段内的 ${totalMergeGroups} 组相邻同类（间隔 ≤1.5s）？`}
                        description="仅合并窗口内同类别且间隔 ≤1.5 秒的碎片；原本全部已通过的合并后继续保持已通过。"
                        okText="一键合并"
                        onConfirm={() => runMergeAdjacent(pickedTestIds.length > 0 ? pickedTestIds : undefined)}
                      >
                        <Button size="small" loading={cleaning === "merge"} style={{ borderColor: "#13c2c2", color: "#13c2c2" }}>
                          一键合并相邻{pickedTestIds.length > 0 ? `（已选 ${pickedTestIds.length}）` : ` (${totalMergeGroups}组)`}
                        </Button>
                      </Popconfirm>
                    )}
                    {siteCounts.size > 1 && (
                      <Select
                        size="small"
                        allowClear
                        placeholder="按场地筛"
                        style={{ minWidth: 150 }}
                        value={itemSiteFilter}
                        onChange={(v) => { setItemSiteFilter(v ?? null); setPickedTestIds([]); }}
                        options={Array.from(siteCounts.entries()).map(([site, n]) => ({
                          value: site,
                          label: `${site} (${n})`,
                        }))}
                      />
                    )}
                    {!frozen && pickedTestIds.length > 0 && (
                      <>
                        <Popconfirm
                          title={`从本测试集移出勾选的 ${pickedTestIds.length} 段？`}
                          description="移出后会保留在测试数据池，原标注和已核对进度不会丢失，下次其他测试集用到可直接续上。"
                          okText="确认移出（保留标注）"
                          onConfirm={batchRemoveSelected}
                        >
                          <Button size="small" loading={batchRemoving}>
                            移出测试集·保留标注（{pickedTestIds.length}）
                          </Button>
                        </Popconfirm>
                        <Popconfirm
                          title={`将勾选的 ${pickedTestIds.length} 段拨到训练数据池？`}
                          description="拨出后解除测试隔离、从未冻结测试集移出，窗内已核对标注直接进入训练数据池（下次训练立刻可用）。"
                          okText="确认拨入训练池"
                          onConfirm={batchPromoteSelected}
                        >
                          <Button size="small" type="primary" loading={batchPromoting}>
                            ➡️ 拨到训练数据池（{pickedTestIds.length}）
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                    <Typography.Text style={{ fontSize: 12, color: uncheckedCount > 0 ? "#faad14" : "#52c41a" }}>
                      {uncheckedCount > 0
                        ? `已核对 ${checkedCount} / ${data.items.length} 段 · 还剩 ${uncheckedCount} 段未核对`
                        : `全部 ${data.items.length} 段已核对完成`}
                    </Typography.Text>
                  </>
                )}
                {frozen && <Typography.Text type="secondary">这一版已冻结；要补数据先「复制成新版本」</Typography.Text>}
              </Space>
              <Table<TestItem>
                size="small" rowKey="id" dataSource={filteredItems} pagination={{ pageSize: 50 }}
                rowSelection={!frozen ? {
                  selectedRowKeys: pickedTestIds,
                  onChange: (keys) => setPickedTestIds(keys as number[]),
                } : undefined}
                onRow={(r) => (r.checked && itemCheckFilter === "all" ? { style: { opacity: 0.68 } } : {})}
                columns={[
                  {
                    title: <Tooltip title="人工看过这段窗口、疑似片段和 AI 预标都确认无误后勾上。测试集打分默认只用已核对的段">核对</Tooltip>,
                    width: 126,
                    render: (_, r) => {
                      const pendCand = pendingCandsOf(r);
                      const pendAi = r.n_ai_pending ?? 0;
                      const parts: string[] = [];
                      if (pendCand > 0) parts.push(`${pendCand} 疑似`);
                      if (pendAi > 0) parts.push(`${pendAi} 待确认`);
                      return (
                        <Space size={5}>
                          <Checkbox checked={!!r.checked} disabled={frozen} onChange={(e) => toggleCheck(r.id, e.target.checked)} />
                          {r.checked ? (
                            <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 11 }}>✓ 已核对</Tag>
                          ) : parts.length > 0 ? (
                            <Tooltip title={`窗口内还有 ${parts.join("、")} 未处理，点右侧「看 / 标」处理完后点「保存并标记已核对」`}>
                              <Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 11 }}>余 {parts.join("·")}</Tag>
                            </Tooltip>
                          ) : (
                            <Tooltip title="窗口内疑似片段和 AI 预标已全部确认完，勾上左侧核对框或进工作台点「保存并标记已核对」">
                              <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11 }}>待核对</Tag>
                            </Tooltip>
                          )}
                        </Space>
                      );
                    },
                  },
                  {
                    title: "任务 / 项目",
                    width: 118,
                    render: (_, r) => (
                      <div style={{ lineHeight: 1.35 }}>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>#{r.task_id}</div>
                        <Tooltip title={[r.project_name, r.date].filter(Boolean).join(" · ")}>
                          <div style={{ fontSize: 11, color: "#888", maxWidth: 108, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.project_name || r.date || "—"}
                          </div>
                        </Tooltip>
                      </div>
                    ),
                  },
                  {
                    title: "狗 / 场地",
                    width: 124,
                    render: (_, r) => (
                      <div style={{ lineHeight: 1.35 }}>
                        <div style={{ fontSize: 12 }}>
                          {r.dog_name ?? "未知"}{r.size ? `（${r.size}）` : ""}
                          {r.dog_source === "推断" && <Tooltip title="按场地 + IMU 号推断的"><Tag style={{ marginLeft: 3, marginInlineEnd: 0, fontSize: 10, lineHeight: "15px", padding: "0 3px" }}>推</Tag></Tooltip>}
                          {r.dog_unsure && <Tooltip title="老影棚数据，推断常对不上：按狗 / 体型统计不可靠"><Tag color="red" style={{ marginLeft: 3, marginInlineEnd: 0, fontSize: 10, lineHeight: "15px", padding: "0 3px" }}>?</Tag></Tooltip>}
                        </div>
                        <div style={{ fontSize: 11, color: "#888" }}>{(r.site ?? "未知").replace("狗场", "")}</div>
                      </div>
                    ),
                  },
                  {
                    title: "窗口",
                    width: 112,
                    render: (_, r) => (
                      <div style={{ lineHeight: 1.35 }}>
                        <div style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>{fmtMs(r.start_ms)}–{fmtMs(r.end_ms)}</div>
                        <Tag color={r.kind === "短片段" ? "cyan" : r.kind === "中片段" ? "blue" : "purple"} style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "15px", padding: "0 4px", marginTop: 2 }}>
                          {r.kind}
                        </Tag>
                      </div>
                    ),
                  },
                  { title: "标了什么", render: (_, r) => (
                    <Space size={[4, 4]} wrap>
                      {/* 颜色跟工作台里的标签一样；抓挠排最前。实心 = 已有片段，虚线框 = 疑似片段待判 */}
                      {Object.entries(r.labels).sort(([a], [b]) => labelRank(a) - labelRank(b)).map(([k, v]) => (
                        <Tag key={k} color={colorOf(k)} style={{ ...TAG_SOLID, marginInlineEnd: 0 }}>{k} {v.n}次 · {fmtSec(v.sec)}</Tag>))}
                      {r.n_uncertain > 0 && <Tag color="gold" style={{ ...TAG_SOLID, marginInlineEnd: 0 }}>待定 {r.n_uncertain}</Tag>}
                      {Object.entries(r.cands ?? {}).map(([k, v]) => (v.pending ?? 0) > 0 && (
                        <Tooltip key={`c-${k}`} title="疑似片段（还没判）：工作台往下滚到「疑似片段」面板，确认 / 排除 / 调起止">
                          <Tag style={{ ...TAG_SOLID, marginInlineEnd: 0, background: "transparent", color: colorOf(k) ?? "#2f54eb",
                            border: `1.5px dashed ${colorOf(k) ?? "#2f54eb"}` }}>？疑似{k.replace(/^疑似/, "")} {v.pending} 待判</Tag>
                        </Tooltip>))}
                      {!Object.keys(r.labels).length && !Object.values(r.cands ?? {}).some((v) => (v.pending ?? 0) > 0)
                        && <span style={{ color: "#ff4d4f" }}>窗口里没有标注</span>}
                      {(r.n_dedupe ?? 0) > 0 && (!frozen ? (
                        <Popconfirm
                          title={`对这条任务 #${r.task_id} 执行单条去重？`}
                          description="合并同类重叠、细类压粗类、行为/活动挖空静止。"
                          okText="去重"
                          onConfirm={() => runDedupe([r.id])}
                        >
                          <Tag color="warning" style={{ marginInlineEnd: 0, fontSize: 11, cursor: "pointer" }}>
                            ⚠ 可去重 {r.n_dedupe}
                          </Tag>
                        </Popconfirm>
                      ) : (
                        <Tag color="warning" style={{ marginInlineEnd: 0, fontSize: 11 }}>⚠ 可去重 {r.n_dedupe}</Tag>
                      ))}
                      {(r.n_conflict ?? 0) > 0 && (
                        <Tooltip title="窗口内有同轨异类重叠冲突，需点右侧「看/标」人工判断">
                          <Tag color="error" style={{ marginInlineEnd: 0, fontSize: 11 }}>冲突 {r.n_conflict}</Tag>
                        </Tooltip>
                      )}
                      {(r.n_mergeable ?? 0) > 0 && (!frozen ? (
                        <Popconfirm
                          title={`合并该窗口内 ${r.n_mergeable} 组相邻同类（≤1.5s）？`}
                          okText="合并"
                          onConfirm={() => runMergeAdjacent([r.id])}
                        >
                          <Tag color="cyan" style={{ marginInlineEnd: 0, fontSize: 11, cursor: "pointer" }}>
                            🔗 可合并 {r.n_mergeable}组
                          </Tag>
                        </Popconfirm>
                      ) : (
                        <Tag color="cyan" style={{ marginInlineEnd: 0, fontSize: 11 }}>🔗 可合并 {r.n_mergeable}组</Tag>
                      ))}
                    </Space>) },
                  {
                    title: <Tooltip title="上方为窗口标注覆盖率（低于 80% 标红），下方为原任务状态">覆盖 / 状态</Tooltip>,
                    width: 90,
                    render: (_, r) => (
                      <div style={{ lineHeight: 1.4 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: r.label_cover < 0.8 ? "#ff4d4f" : "#ccc", fontVariantNumeric: "tabular-nums" }}>
                          {pct(r.label_cover)}
                        </div>
                        <div style={{ marginTop: 2 }}>{r.task_status ? <TaskStatusTag status={r.task_status as TaskStatus} /> : "-"}</div>
                      </div>
                    ),
                  },
                  {
                    title: "来源 / 备注", dataIndex: "note", width: 175,
                    render: (note: string | null) => {
                      if (!note) return <span style={{ color: "#666" }}>—</span>;
                      if (note.startsWith("选样·") || note.startsWith("按条件挑·") || note.startsWith("替换影棚·")) {
                        const parts = note.split("·").slice(1).filter(Boolean);
                        const tagColor = (t: string) => {
                          if (t.startsWith("有")) return "red";
                          if (t.startsWith("无")) return "geekblue";
                          if (t.endsWith("分钟")) {
                            const m = parseFloat(t);
                            return m <= 1.5 ? "cyan" : m <= 2.5 ? "blue" : "purple";
                          }
                          if (t.includes("像抓挠") || t.includes("为中心")) return "orange";
                          if (t.includes("活动")) return "lime";
                          if (t.includes("未佩戴")) return "volcano";
                          if (t.includes("人工")) return "green";
                          if (t.includes("AI")) return "gold";
                          if (t.includes("休息") || t.includes("睡眠")) return "default";
                          return "magenta";
                        };
                        return (
                          <Tooltip title={note}>
                            <Space size={[3, 3]} wrap>
                              {parts.map((t, idx) => (
                                <Tag key={`${idx}-${t}`} color={tagColor(t)} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "17px", padding: "0 4px" }}>
                                  {t}
                                </Tag>
                              ))}
                            </Space>
                          </Tooltip>
                        );
                      }
                      return (
                        <Tooltip title={note}>
                          <span style={{ display: "inline-block", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>
                            {note}
                          </span>
                        </Tooltip>
                      );
                    },
                  },
                  { title: "操作", width: 96, render: (_, r) => (
                    <Space size={6}>
                      <Tooltip title="打开工作台，从窗口开头放。管理员不用认领、直接改（已通过的要先「继续编辑」）；其他人认领了才能标">
                        <Button size="small" type="link" style={{ padding: 0 }} loading={opening === r.task_id}
                          onClick={() => openTask(r.task_id, r.start_ms, { winStartMs: r.start_ms, winEndMs: r.end_ms, itemId: r.id })}>看/标</Button>
                      </Tooltip>
                      {!frozen && <Popconfirm title="从测试集拿掉这段？" onConfirm={() => del(r.id)}><a>拿掉</a></Popconfirm>}
                    </Space>) },
                ]}
              />
            </Space>
          ),
        },
        { key: "seen", label: "模型见没见过", children: <SeenTab setId={setId} /> },
        { key: "eval", label: "打分", children: (
          <EvalTab setId={setId} testSet={data.set} coverage={data.coverage} planTarget={data.set.plan?.target} items={data.items} colors={colors} opening={opening}
            promoting={promoting} frozen={frozen} onOpenTask={openTask} onPromoteItem={(itemId) => promoteItem(itemId, false)} />
        ) },
      ]} />
      {adding && <AddItemsModal setId={setId} open={adding} onClose={() => setAdding(false)} />}
      {composing && <ComposeModal setId={setId} open={composing} onClose={() => setComposing(false)} />}
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        initialSeekMs={wsSeekMs}
        focusWindow={wsWin}
        readOnly={!((isAdmin && wsTask?.status !== "APPROVED") || (wsTask?.status === "IN_PROGRESS" && wsTask?.locked_by === userId))}
        onClaim={
          wsTask && wsTask.status !== "APPROVED" && !isAdmin
            ? async () => setWsTask(await claimTask(wsTask.id))
            : undefined
        }
        onEditAgain={
          isAdmin && wsTask?.status === "APPROVED"
            ? async () => setWsTask(await editAgain(wsTask.id))
            : undefined
        }
        hideSubmit={!wsFromEval && wsItemId != null}
        onApprove={
          wsItemId != null && !frozen
            ? wsFromEval
              ? (isAdmin ? () => promoteItem(wsItemId, wsWasApproved) : undefined)
              : () => confirmItemChecked(wsItemId)
            : undefined
        }
        approveText={wsFromEval ? "审核入池并剥离测试集" : "保存并标记已核对（留在测试集）"}
        approveConfirmTitle={
          wsFromEval
            ? "将本窗口调整后的标注视为人工审核通过、直接进入数据池，并从当前测试集剥离？"
            : "保存当前窗口标注并标记为「已核对」？（保留在测试集内，不会进入训练数据池）"
        }
        onClose={closeWs}
        onSaved={() => qc.invalidateQueries({ queryKey: ["model-test-items", setId] })}
        onSubmitted={closeWs}
      />
    </>
  );
}

// ───────────────────────── 页面 ─────────────────────────
export default function ModelTest() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["model-test-sets"], queryFn: listTestSets });
  const sets = data?.sets ?? [];
  const [cur, setCurState] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem("smart-label:model-test-cur-set"));
      return Number.isInteger(v) && v > 0 ? v : null;
    } catch { return null; }
  });
  const setCur = (id: number | null) => {
    setCurState(id);
    try {
      if (id == null) localStorage.removeItem("smart-label:model-test-cur-set");
      else localStorage.setItem("smart-label:model-test-cur-set", String(id));
    } catch { /* ignore */ }
  };
  const [name, setName] = useState("");
  const [copyOf, setCopyOf] = useState<TestSet | null>(null);
  const [copyName, setCopyName] = useState("");
  const [editOf, setEditOf] = useState<TestSet | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const doEdit = async () => {
    if (!editOf || !editName.trim()) return message.warning("名字不能空");
    await updateTestSet(editOf.id, { name: editName.trim(), note: editNote });
    setEditOf(null);
    refresh();
    qc.invalidateQueries({ queryKey: ["model-test-items", editOf.id] });
  };
  useEffect(() => {
    if (!sets.length) return;
    if (cur == null || !sets.some((s) => s.id === cur)) {
      setCur(sets[0].id);
    }
  }, [sets, cur]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["model-test-sets"] });
  const create = async () => {
    if (!name.trim()) return message.warning("给测试集起个名字，比如「测试集 v1」");
    const s = await createTestSet({ name: name.trim() });
    setName(""); refresh(); setCur(s.id);
  };
  const doCopy = async () => {
    if (!copyOf || !copyName.trim()) return message.warning("给新版本起个名字");
    const s = await copyTestSet(copyOf.id, { name: copyName.trim() });
    setCopyOf(null); setCopyName(""); refresh(); setCur(s.id);
  };

  // 一个测试集的操作：顶上那一行和「全部测试集」列表共用
  const actions = (s: TestSet) => (
    <Space size={12} onClick={(e) => e.stopPropagation()}>
      <a onClick={() => { setEditOf(s); setEditName(s.name); setEditNote(s.note ?? ""); }}>编辑</a>
      {!s.frozen && (
        <Popconfirm title="冻结后这一版不能再增删，确定？" onConfirm={async () => { await freezeTestSet(s.id); refresh(); }}>
          <a>冻结</a>
        </Popconfirm>)}
      <a onClick={() => { setCopyOf(s); setCopyName(`${s.name} 补充`); }}>复制成新版本</a>
      <Popconfirm
        title={`删除测试集「${s.name}」？`}
        description={<div style={{ maxWidth: 300 }}>
          会删掉这个测试集和它的 {s.n_items} 条片段记录{s.frozen ? "（这一版已冻结，删了以后用它做的成绩就对不上版本了）" : ""}。
          任务、标注、疑似片段都不动；这些窗口以后不再挡训练导出（别的测试集里还有的照样挡）。删了不能恢复。</div>}
        okText="删除" okButtonProps={{ danger: true }}
        onConfirm={async () => {
          const r = await deleteTestSet(s.id);
          message.success(`已删除「${s.name}」（${r.deleted_items} 条片段记录）`);
          if (cur === s.id) setCur(null);
          refresh();
        }}>
        <a style={{ color: "#ff4d4f" }}>删除</a>
      </Popconfirm>
    </Space>
  );
  const curSet = sets.find((s) => s.id === cur) ?? null;

  return (
    <div>
      <Tabs items={[
        {
          key: "sets", label: "测试集", children: (
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              {/* 选一个测试集：几十个也不用滚 */}
              <Space wrap size={[12, 8]}>
                <Select showSearch optionFilterProp="label" style={{ minWidth: 380 }} value={cur ?? undefined} onChange={setCur}
                  placeholder="选测试集"
                  options={sets.map((s) => ({
                    value: s.id,
                    label: `${s.is_demo ? "[示例] " : ""}${s.name} · ${s.n_items} 段${s.seen_ref && s.n_items > 0 ? ` · 没见过 ${s.n_unseen ?? 0}` : ""}${s.creator_name ? ` · ${s.creator_name}` : ""}${s.frozen ? " · 已冻结" : ""}`,
                  }))} />
                {curSet && actions(curSet)}
                <Popover trigger="click" placement="bottom" content={
                  <Space>
                    <Input style={{ width: 220 }} placeholder="新测试集名字" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} />
                    <Button type="primary" onClick={create}>新建</Button>
                  </Space>}>
                  <Button size="small" icon={<PlusOutlined />}>新建测试集</Button>
                </Popover>
              </Space>
              {curSet && (
                <Space wrap size={[8, 4]} style={{ fontSize: 12 }}>
                  {curSet.is_demo && <Tag color="purple" style={{ marginInlineEnd: 0 }}>系统示例</Tag>}
                  {curSet.creator_name && <Typography.Text type="secondary">创建人：{curSet.creator_name}</Typography.Text>}
                  {curSet.created_at && <Typography.Text type="secondary">创建于：{curSet.created_at.slice(0, 16).replace("T", " ")}</Typography.Text>}
                  {curSet.n_items > 0 && (
                    <Typography.Text type="secondary">
                      已核对 {curSet.n_checked ?? 0}/{curSet.n_items} 段
                    </Typography.Text>
                  )}
                  {curSet.seen_ref && curSet.n_items > 0 && (
                    <Tooltip title={`相对最新训练模型 ${curSet.seen_ref}（样本级）`}>
                      <Space size={4}>
                        <Tag color="green" style={{ marginInlineEnd: 0 }}>没见过 {curSet.n_unseen ?? 0}</Tag>
                        <Tag color="orange" style={{ marginInlineEnd: 0 }}>见过 {curSet.n_seen ?? 0}</Tag>
                      </Space>
                    </Tooltip>
                  )}
                  {curSet.note && <Typography.Text type="secondary">{curSet.note}</Typography.Text>}
                </Space>
              )}
              <Collapse size="small" items={[{
                key: "all", label: `全部测试集（${sets.length}）`,
                children: (
                  <Table<TestSet>
                    size="small" rowKey="id" pagination={sets.length > 15 ? { pageSize: 15 } : false} dataSource={sets}
                    scroll={{ x: 1080 }}
                    rowClassName={(s) => (s.id === cur ? "ant-table-row-selected" : "")}
                    onRow={(s) => ({ onClick: () => setCur(s.id), style: { cursor: "pointer" } })}
                    columns={[
                      {
                        title: "名字", width: 210,
                        render: (_, s) => (
                          <Space size={6} wrap>
                            <b>{s.name}</b>
                            {s.is_demo && <Tag color="purple" style={{ marginInlineEnd: 0 }}>系统示例</Tag>}
                          </Space>
                        ),
                      },
                      {
                        title: "创建人 / 时间", width: 155,
                        render: (_, s) => (
                          <div style={{ lineHeight: 1.35 }}>
                            <div>{s.creator_name ?? "系统"}</div>
                            <div style={{ fontSize: 11, color: "#888" }}>{s.created_at ? s.created_at.slice(5, 16).replace("T", " ") : "-"}</div>
                          </div>
                        ),
                      },
                      {
                        title: "片段 / 核对", width: 125,
                        render: (_, s) => (
                          <div style={{ lineHeight: 1.35 }}>
                            <div>{s.n_items} 段 <span style={{ color: "#888", fontSize: 11 }}>({s.n_samples} 样本)</span></div>
                            <div style={{ fontSize: 11, color: (s.n_checked ?? 0) === s.n_items && s.n_items > 0 ? "#52c41a" : "#888" }}>
                              已核对 {s.n_checked ?? 0}/{s.n_items}
                            </div>
                          </div>
                        ),
                      },
                      {
                        title: <Tooltip title="相对最新训练模型（样本级）：「没见过」越多越适合做正式考试">模型见过 / 没见过</Tooltip>, width: 165,
                        render: (_, s) => (s.seen_ref && s.n_items > 0 ? (
                          <Tooltip title={`相对最新训练模型 ${s.seen_ref}（按样本统计）`}>
                            <Space size={4} wrap>
                              <Tag color="green" style={{ marginInlineEnd: 0 }}>没见过 {s.n_unseen ?? 0}</Tag>
                              <Tag color="orange" style={{ marginInlineEnd: 0 }}>见过 {s.n_seen ?? 0}</Tag>
                            </Space>
                          </Tooltip>
                        ) : <span style={{ color: "#888" }}>—</span>),
                      },
                      { title: "状态", width: 120, render: (_, s) => (s.frozen ? <Tag color="blue">已冻结 {s.frozen_at?.slice(5, 16).replace("T", " ")}</Tag> : <Tag>可编辑</Tag>) },
                      { title: "备注", dataIndex: "note", ellipsis: true },
                      { title: "", width: 220, render: (_, s) => actions(s) },
                    ]}
                  />),
              }]} />
              {cur != null && sets.some((s) => s.id === cur) && <SetDetail key={cur} setId={cur} />}
            </Space>
          ),
        },
        { key: "cross", label: "多批交叉对比", children: <CrossTab sets={sets} /> },
        {
          // 说明收进问号：不占地方，鼠标移上去才看
          key: "help", disabled: true, label: (
            <Tooltip placement="bottomLeft" overlayStyle={{ maxWidth: 420 }} title={<div>
              测试集是给模型「考试」的数据：<b>测试窗口前后各 60 秒以后不进任何训练导出</b>（整个任务加进来的，整个样本都不进；现在涉及 {data?.n_excluded_samples ?? 0} 个样本）。
              <br />正式成绩只算模型<b>没见过</b>的；多样性优先（体型、狗、场地、白天 / 夜里、日期），数量按批补。
              <br />一版定下来就「冻结」，补数据「复制成新版本」再加——报告注明用的哪一版，前后才比得了。
            </div>}>
              <QuestionCircleOutlined style={{ cursor: "help", fontSize: 15 }} />
            </Tooltip>
          ),
        },
      ]} />
      <Modal title="编辑测试集" open={!!editOf} onCancel={() => setEditOf(null)} onOk={doEdit} okText="保存">
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="名字" maxLength={100} />
          <Input.TextArea value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="备注（可空）" maxLength={500} autoSize={{ minRows: 3, maxRows: 8 }} />
        </Space>
      </Modal>
      <Modal title={`复制「${copyOf?.name ?? ""}」成新版本`} open={!!copyOf} onCancel={() => setCopyOf(null)} onOk={doCopy} okText="复制">
        <Input value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="新版本名字" />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          原样复制所有片段，新版本可以继续加。原来那版不动。
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
