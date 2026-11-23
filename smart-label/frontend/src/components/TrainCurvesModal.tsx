import { useRef, useState, type MouseEvent } from "react";
import { Modal, Slider, Typography } from "antd";

/** 训练脚本写进 metrics.curves 的结构 */
export interface CurvePoint {
  epoch: number;
  loss: number;
  train_acc: number;
}
export interface CurveFold {
  fold: number;
  accuracy?: number;
  macro_f1?: number;
  history?: CurvePoint[];
}
export interface TrainCurves {
  folds?: CurveFold[];
  final?: CurvePoint[];
}

const FOLD_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2", "#2f54eb"];
const FINAL_COLOR = "#cf1322";

type Pt = { x: number; y: number };
interface Series {
  name: string;
  color: string;
  dashed?: boolean;
  data: Pt[];
}

/** wandb 那种指数滑动平均：只影响画出来的线，右侧悬浮的原始值不变 */
const smooth = (pts: Pt[], alpha: number): Pt[] => {
  if (alpha <= 0) return pts;
  let last: number | undefined;
  return pts.map((p) => {
    last = last === undefined ? p.y : alpha * last + (1 - alpha) * p.y;
    return { x: p.x, y: last };
  });
};

const num = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

/** 单张折线图：网格 + 刻度 + 图例开关 + 十字线悬浮读数 */
function LineChart({
  title, series, minY, maxY, smoothing, hidden, onToggle,
}: {
  title: string;
  series: Series[];
  minY?: number;
  maxY?: number;
  smoothing: number;
  hidden: Set<string>;
  onToggle: (name: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement | null>(null);
  const W = 520;
  const H = 220;
  const P = { l: 52, r: 14, t: 14, b: 30 };
  const visible = series.filter((s) => !hidden.has(s.name) && s.data.length);
  const raw = series.flatMap((s) => s.data);
  const empty = <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.55, fontSize: 12 }}>没有数据</div>;
  if (!raw.length) return <div><div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}</div>{empty}</div>;

  const x0 = Math.min(...raw.map((p) => p.x));
  const x1 = Math.max(...raw.map((p) => p.x));
  const yMinRaw = Math.min(...raw.map((p) => p.y));
  const yMaxRaw = Math.max(...raw.map((p) => p.y));
  const pad = Math.max((yMaxRaw - yMinRaw) * 0.08, 1e-6);
  const lo = minY !== undefined ? Math.min(minY, yMinRaw) : yMinRaw - pad;
  const hi = maxY !== undefined ? maxY : yMaxRaw + pad;
  const sx = (x: number) => P.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - lo) / Math.max(1e-9, hi - lo)) * (H - P.t - P.b);

  const xs = Array.from(new Set(raw.map((p) => p.x))).sort((a, b) => a - b);
  const xTicks = Array.from({ length: 5 }, (_, i) => Math.round(x0 + ((x1 - x0) * i) / 4)).filter((v, i, a) => a.indexOf(v) === i);
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < P.l - 4 || px > W - P.r + 4) { setHover(null); return; }
    const x = x0 + ((px - P.l) / Math.max(1, W - P.l - P.r)) * (x1 - x0);
    let best = xs[0];
    for (const v of xs) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
    setHover(best);
  };

  const hoverVals = hover == null ? [] : visible
    .map((s) => {
      const hit = s.data.find((p) => p.x === hover);
      return hit ? { name: s.name, color: s.color, y: hit.y } : null;
    })
    .filter((v): v is { name: string; color: string; y: number } => v != null)
    .sort((a, b) => b.y - a.y);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
          {series.map((s) => (
            <span
              key={s.name}
              onClick={() => onToggle(s.name)}
              style={{ cursor: "pointer", opacity: hidden.has(s.name) ? 0.35 : 1, userSelect: "none" }}
            >
              <span style={{ display: "inline-block", width: 9, height: 3, background: s.color, marginRight: 4, verticalAlign: "middle", borderRadius: 2 }} />
              {s.name}
            </span>
          ))}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} stroke="rgba(127,127,127,0.22)" strokeDasharray="3 3" />
              <text x={P.l - 6} y={sy(t) + 3.5} textAnchor="end" fontSize={9.5} fill="currentColor" opacity={0.6}>{num(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={sx(t)} x2={sx(t)} y1={P.t} y2={H - P.b} stroke="rgba(127,127,127,0.12)" />
              <text x={sx(t)} y={H - P.b + 12} textAnchor="middle" fontSize={9.5} fill="currentColor" opacity={0.6}>{t}</text>
            </g>
          ))}
          <text x={W - P.r} y={H - 4} textAnchor="end" fontSize={9.5} fill="currentColor" opacity={0.5}>epoch</text>
          {visible.map((s) => {
            const draw = smoothing > 0 ? smooth(s.data, smoothing) : s.data;
            const d = draw.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
            return (
              <g key={s.name}>
                {smoothing > 0 && (
                  <path d={s.data.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")}
                        fill="none" stroke={s.color} strokeWidth={0.9} opacity={0.16} />
                )}
                <path d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 2 : 1.6}
                      strokeDasharray={s.dashed ? "6 4" : undefined} opacity={0.95} />
              </g>
            );
          })}
          {hover != null && (
            <g>
              <line x1={sx(hover)} x2={sx(hover)} y1={P.t} y2={H - P.b} stroke="rgba(127,127,127,0.5)" strokeDasharray="3 3" />
              {hoverVals.map((v) => (
                <circle key={v.name} cx={sx(hover)} cy={sy(v.y)} r={2.6} fill={v.color} stroke="#fff" strokeWidth={0.8} />
              ))}
            </g>
          )}
        </svg>
        {hover != null && hoverVals.length > 0 && (
          <div style={{
            position: "absolute", top: 6, left: `${Math.min(80, Math.max(12, (sx(hover) / W) * 100))}%`,
            transform: "translateX(-50%)", pointerEvents: "none", background: "rgba(20,20,20,0.88)", color: "#fff",
            borderRadius: 6, padding: "5px 8px", fontSize: 11, lineHeight: 1.6, minWidth: 96,
          }}>
            <div style={{ opacity: 0.7, marginBottom: 2 }}>epoch {hover}</div>
            {hoverVals.map((v) => (
              <div key={v.name} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: v.color }}>{v.name}</span>
                <span>{v.y.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 各折留出成绩：分组柱状图 + 均值线 */
function FoldBars({ folds }: { folds: CurveFold[] }) {
  const rows = folds.filter((f) => typeof f.accuracy === "number" || typeof f.macro_f1 === "number");
  const W = 520;
  const H = 200;
  const P = { l: 40, r: 12, t: 16, b: 28 };
  if (!rows.length) return <div style={{ fontSize: 12, opacity: 0.55 }}>没有分折数据</div>;
  const y = (v: number) => H - P.b - v * (H - P.t - P.b);
  const groupW = (W - P.l - P.r) / rows.length;
  const barW = Math.min(20, groupW * 0.3);
  const accVals = rows.map((f) => f.accuracy).filter((v): v is number => typeof v === "number");
  const f1Vals = rows.map((f) => f.macro_f1).filter((v): v is number => typeof v === "number");
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const accAvg = avg(accVals);
  const f1Avg = avg(f1Vals);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, marginBottom: 2 }}>
        <span><span style={{ display: "inline-block", width: 9, height: 9, background: "#1677ff", marginRight: 4, borderRadius: 2 }} />准确率</span>
        <span><span style={{ display: "inline-block", width: 9, height: 9, background: "#52c41a", marginRight: 4, borderRadius: 2 }} />macro-F1</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="rgba(127,127,127,0.2)" strokeDasharray="3 3" />
            <text x={P.l - 5} y={y(t) + 3.5} textAnchor="end" fontSize={9.5} fill="currentColor" opacity={0.6}>{t.toFixed(2)}</text>
          </g>
        ))}
        {rows.map((f, i) => {
          const cx = P.l + groupW * (i + 0.5);
          return (
            <g key={f.fold}>
              {typeof f.accuracy === "number" && (
                <g>
                  <rect x={cx - barW - 2} y={y(f.accuracy)} width={barW} height={H - P.b - y(f.accuracy)} fill="#1677ff" opacity={0.85} rx={2} />
                  <text x={cx - barW / 2 - 2} y={y(f.accuracy) - 3} textAnchor="middle" fontSize={8.5} fill="currentColor" opacity={0.75}>{f.accuracy.toFixed(2)}</text>
                </g>
              )}
              {typeof f.macro_f1 === "number" && (
                <g>
                  <rect x={cx + 2} y={y(f.macro_f1)} width={barW} height={H - P.b - y(f.macro_f1)} fill="#52c41a" opacity={0.85} rx={2} />
                  <text x={cx + barW / 2 + 2} y={y(f.macro_f1) - 3} textAnchor="middle" fontSize={8.5} fill="currentColor" opacity={0.75}>{f.macro_f1.toFixed(2)}</text>
                </g>
              )}
              <text x={cx} y={H - P.b + 12} textAnchor="middle" fontSize={9.5} fill="currentColor" opacity={0.6}>折 {f.fold}</text>
            </g>
          );
        })}
        {accAvg != null && <line x1={P.l} x2={W - P.r} y1={y(accAvg)} y2={y(accAvg)} stroke="#1677ff" strokeDasharray="5 3" opacity={0.7} />}
        {f1Avg != null && <line x1={P.l} x2={W - P.r} y1={y(f1Avg)} y2={y(f1Avg)} stroke="#52c41a" strokeDasharray="5 3" opacity={0.7} />}
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 11, opacity: 0.8 }}>
        {accAvg != null && <span>准确率均值 {accAvg.toFixed(3)}</span>}
        {f1Avg != null && <span>macro-F1 均值 {f1Avg.toFixed(3)}</span>}
        <span style={{ opacity: 0.6 }}>虚线为均值</span>
      </div>
    </div>
  );
}

/** 顶部的关键数字（wandb 的 run summary） */
function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 120, padding: "8px 12px", border: "1px solid rgba(127,127,127,0.22)", borderRadius: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, opacity: 0.55 }}>{sub}</div>}
    </div>
  );
}

export default function TrainCurvesModal({ open, title, curves, onClose }: {
  open: boolean;
  title: string;
  curves: TrainCurves | null;
  onClose: () => void;
}) {
  const [smoothing, setSmoothing] = useState(0.6);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const folds = curves?.folds ?? [];
  const final = curves?.final ?? [];
  const withHist = folds.filter((f) => (f.history?.length ?? 0) > 0);
  const toggle = (name: string) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const foldSeries = (pick: (p: CurvePoint) => number): Series[] => [
    ...withHist.map((f, i) => ({
      name: `第 ${f.fold} 折`, color: FOLD_COLORS[i % FOLD_COLORS.length], dashed: false,
      data: (f.history ?? []).map((p) => ({ x: p.epoch, y: pick(p) })),
    })),
    ...(final.length ? [{ name: "全量训练", color: FINAL_COLOR, dashed: true, data: final.map((p) => ({ x: p.epoch, y: pick(p) })) }] : []),
  ];

  const epochs = Math.max(...[...withHist.map((f) => f.history?.length ?? 0), final.length]);
  const lastFinal = final.length ? final[final.length - 1].train_acc : (withHist.length ? withHist[withHist.length - 1].history!.slice(-1)[0].train_acc : null);
  const f1s = folds.map((f) => f.macro_f1).filter((v): v is number => typeof v === "number");
  const accs = folds.map((f) => f.accuracy).filter((v): v is number => typeof v === "number");
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const std = (a: number[]) => {
    const m = mean(a);
    return m == null || a.length < 2 ? null : Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const f1Mean = mean(f1s);
  const f1Std = std(f1s);
  const accMean = mean(accs);

  return (
    <Modal open={open} title={`训练曲线 · ${title}`} onCancel={onClose} footer={null} width={1000}>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <SummaryCard label="交叉验证" value={folds.length ? `${folds.length} 折` : "未做"} sub="按（天, 项圈）分组" />
        <SummaryCard label="训练轮数" value={epochs ? `${epochs}` : "-"} sub={final.length ? "含最后全量重训" : "只有各折"} />
        <SummaryCard label="最终训练准确率" value={lastFinal != null ? lastFinal.toFixed(3) : "-"} sub="训练集（含增强）" />
        <SummaryCard label="留出 macro-F1" value={f1Mean != null ? f1Mean.toFixed(3) : "-"} sub={f1Std != null ? `± ${f1Std.toFixed(3)}` : undefined} />
        <SummaryCard label="留出准确率" value={accMean != null ? accMean.toFixed(3) : "-"} sub="各折平均" />
      </div>

      {withHist.length > 0 ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>平滑（EMA）</span>
            <Slider min={0} max={0.95} step={0.05} value={smoothing} onChange={setSmoothing} style={{ width: 180 }} />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              实线是平滑后的；细淡线是原始逐轮值。训练集的数含数据增强，比留出指标低是正常的。点图例可以临时隐藏某条线
            </Typography.Text>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
            <LineChart title="loss" series={foldSeries((p) => p.loss)} smoothing={smoothing} hidden={hidden} onToggle={toggle} />
            <LineChart title="训练准确率" series={foldSeries((p) => p.train_acc)} minY={0} maxY={1} smoothing={smoothing} hidden={hidden} onToggle={toggle} />
          </div>
        </>
      ) : (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这次是树模型（RF / XGBoost），训练过程没有逐轮曲线。下面是各折在留出集上的成绩——
          每折都是训练时没见过的（按天 + 项圈分组），比训练集上的数更能说明换一只狗/换一天的表现。
        </Typography.Paragraph>
      )}

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>各折留出成绩</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <FoldBars folds={folds} />
          <div style={{ fontSize: 12 }}>
            {folds.length === 0 && <Typography.Text type="secondary">没有分折数据（数据量太少，没做交叉验证）</Typography.Text>}
            {folds.map((f) => (
              <div key={f.fold} style={{ display: "flex", gap: 12, padding: "3px 0", borderBottom: "1px solid rgba(127,127,127,0.12)" }}>
                <span style={{ width: 46, opacity: 0.7 }}>第 {f.fold} 折</span>
                <span style={{ flex: 1 }}>准确率 {typeof f.accuracy === "number" ? f.accuracy.toFixed(3) : "-"}</span>
                <span style={{ flex: 1 }}>macro-F1 {typeof f.macro_f1 === "number" ? f.macro_f1.toFixed(3) : "-"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
