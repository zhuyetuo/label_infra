import { Modal, Typography } from "antd";

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

const COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1"];

/** 极简 SVG 折线图：不引图表库（前端已有 uplot 但要手动管 DOM，这里画 5 条线不值当） */
function Lines({ series, yLabel, minY = 0, maxY }: {
  series: { name: string; color: string; dashed?: boolean; data: { x: number; y: number }[] }[];
  yLabel: string;
  minY?: number;
  maxY?: number;
}) {
  const W = 620;
  const H = 220;
  const P = { l: 48, r: 12, t: 12, b: 26 };
  const pts = series.flatMap((s) => s.data);
  if (!pts.length) return <Typography.Text type="secondary">没有曲线数据</Typography.Text>;
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const yMin = Math.min(minY, ...pts.map((p) => p.y));
  const yMax = maxY ?? Math.max(...pts.map((p) => p.y));
  const sx = (x: number) => P.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * (H - P.t - P.b);
  const ticks = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} stroke="rgba(127,127,127,0.25)" strokeDasharray="3 3" />
          <text x={P.l - 6} y={sy(t) + 4} textAnchor="end" fontSize="10" fill="currentColor" opacity={0.65}>
            {yMax <= 1.5 ? t.toFixed(2) : t.toFixed(1)}
          </text>
        </g>
      ))}
      <text x={P.l} y={H - 8} fontSize="10" fill="currentColor" opacity={0.65}>{yLabel} · 第 {x0} 轮</text>
      <text x={W - P.r} y={H - 8} textAnchor="end" fontSize="10" fill="currentColor" opacity={0.65}>第 {x1} 轮</text>
      {series.map((s) => {
        if (!s.data.length) return null;
        const d = s.data.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
        return (
          <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 2.4 : 1.4}
                strokeDasharray={s.dashed ? "6 4" : undefined} opacity={s.dashed ? 1 : 0.75} />
        );
      })}
    </svg>
  );
}

export default function TrainCurvesModal({ open, title, curves, onClose }: {
  open: boolean;
  title: string;
  curves: TrainCurves | null;
  onClose: () => void;
}) {
  const folds = curves?.folds ?? [];
  const final = curves?.final ?? [];
  const withHist = folds.filter((f) => (f.history?.length ?? 0) > 0);
  const lossSeries = [
    ...withHist.map((f, i) => ({
      name: `第 ${f.fold} 折`, color: COLORS[i % COLORS.length], dashed: false,
      data: (f.history ?? []).map((p) => ({ x: p.epoch, y: p.loss })),
    })),
    ...(final.length ? [{ name: "全量训练", color: "#cf1322", dashed: true, data: final.map((p) => ({ x: p.epoch, y: p.loss })) }] : []),
  ];
  const accSeries = [
    ...withHist.map((f, i) => ({
      name: `第 ${f.fold} 折`, color: COLORS[i % COLORS.length], dashed: false,
      data: (f.history ?? []).map((p) => ({ x: p.epoch, y: p.train_acc })),
    })),
    ...(final.length ? [{ name: "全量训练", color: "#cf1322", dashed: true, data: final.map((p) => ({ x: p.epoch, y: p.train_acc })) }] : []),
  ];
  return (
    <Modal open={open} title={`训练曲线 · ${title}`} onCancel={onClose} footer={null} width={720}>
      {withHist.length > 0 ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每折的训练集 loss / 训练准确率（训练时按 batch 累计，含数据增强，所以比验证指标略低）。
            虚线是最后用全部数据重训的那次。
          </Typography.Text>
          <div style={{ display: "flex", gap: 16, margin: "8px 0 4px", fontSize: 12 }}>
            {[...withHist.map((f, i) => ({ k: `f${f.fold}`, n: `第 ${f.fold} 折`, c: COLORS[i % COLORS.length] })),
              ...(final.length ? [{ k: "final", n: "全量训练", c: "#cf1322" }] : [])].map((x) => (
              <span key={x.k}><span style={{ display: "inline-block", width: 10, height: 10, background: x.c, marginRight: 4, borderRadius: 2 }} />{x.n}</span>
            ))}
          </div>
          <Typography.Text strong style={{ fontSize: 12 }}>loss</Typography.Text>
          <Lines series={lossSeries} yLabel="loss" />
          <Typography.Text strong style={{ fontSize: 12 }}>训练准确率</Typography.Text>
          <Lines series={accSeries} yLabel="train_acc" maxY={1} />
        </>
      ) : (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这次是树模型 / 没有逐轮曲线。下面是各折的留出成绩（按天+项圈分组，每折都是训练时没见过的）。
        </Typography.Paragraph>
      )}
      <Typography.Text strong style={{ fontSize: 12 }}>各折成绩</Typography.Text>
      <div style={{ marginTop: 6 }}>
        {folds.length === 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>没有分折数据（数据量太少，没做交叉验证）</Typography.Text>}
        {folds.map((f) => (
          <div key={f.fold} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}>
            <span style={{ width: 52, opacity: 0.7 }}>第 {f.fold} 折</span>
            {(["accuracy", "macro_f1"] as const).map((k) => {
              const v = f[k];
              if (typeof v !== "number") return null;
              return (
                <span key={k} style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 60, opacity: 0.7 }}>{k === "accuracy" ? "准确率" : "macro-F1"}</span>
                  <span style={{ flex: 1, height: 8, background: "rgba(127,127,127,0.18)", borderRadius: 4 }}>
                    <span style={{ display: "block", width: `${Math.max(2, v * 100)}%`, height: 8, borderRadius: 4, background: k === "accuracy" ? "#1677ff" : "#52c41a" }} />
                  </span>
                  <span style={{ width: 40, textAlign: "right" }}>{v.toFixed(3)}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}
