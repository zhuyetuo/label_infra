import { useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { sizeCurve, type SizeCurve, type SizeCurveRow } from "@/api/training";

/**
 * 体积曲线：这一版剪到多小、F1 掉多少。
 *
 * rf   棵数 × 深度 的网格。**不重训**：把训好的树在深度 d 剪断、取前 n 棵，是精确操作。
 *      体积按板上的紧凑编码算，F1 用板上那套特征在留出集上算——表里的数就是导到板上
 *      会看到的数。看中哪一格，点「按这个规格重训」：重训比剪枝准（分裂点会重新选）。
 * cnn  filters 决定体积，换 filters 必须重训，所以只给几档的 int8 体积；F1 只有当前这档。
 *
 * 第一次点要算几十秒到几分钟（留出集逐条过一遍树），算过的存在训练记录里，再点直接显示。
 */

const KB = (b: number) => `${(b / 1024).toFixed(1)} KB`;
const f1Color = (f1: number | null | undefined) =>
  f1 == null ? undefined : f1 >= 0.8 ? "green" : f1 >= 0.6 ? "gold" : "red";

export default function SizeCurveModal({
  versionId, modelType, cached, budgetKb = 50, onClose, onRetrain,
}: {
  versionId: number | null;
  modelType: string;
  /** 训练记录 metrics.size_curve 里存过的，有就不用重算 */
  cached: SizeCurve | null;
  budgetKb?: number;
  onClose: () => void;
  /** 「按这个规格重训」：带着规格打开训练弹窗 */
  onRetrain: (spec: { edge_trees?: number; edge_depth?: number; edge_filters?: number[] }) => void;
}) {
  const [data, setData] = useState<SizeCurve | null>(cached);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const compute = async () => {
    if (versionId == null) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await sizeCurve(versionId));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(cached);
    setErr(null);
    if (versionId != null && !cached) void compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  const budget = budgetKb * 1024;
  const rows = data?.rows ?? [];
  const classes = data?.classes ?? [];
  const isRf = (data?.kind ?? (modelType === "cnn" ? "cnn" : "rf")) === "rf";

  // rf：行 = 棵数，列 = 深度，格子里是 体积 / F1
  const depths = isRf ? [...new Set(rows.map((r) => r.depth as number))].sort((a, b) => a - b) : [];
  const trees = isRf ? [...new Set(rows.map((r) => r.trees as number))].sort((a, b) => a - b) : [];
  const cell = (t: number, d: number) => rows.find((r) => r.trees === t && r.depth === d);

  const renderCell = (r: SizeCurveRow | undefined) => {
    if (!r) return "-";
    const fits = r.flash_bytes <= budget;
    const pc = Object.entries(r.per_class ?? {}).map(([c, f]) => `${c} ${Number(f).toFixed(2)}`).join(" · ");
    return (
      <Tooltip title={`${r.nodes ?? ""} 节点 · ${pc}${r.current ? "（当前这版）" : ""}`}>
        <div
          style={{
            padding: "4px 6px", borderRadius: 4, cursor: "pointer", textAlign: "center",
            border: r.current ? "1px solid #722ed1" : "1px solid transparent",
            background: fits ? "rgba(82,196,26,0.12)" : "rgba(255,255,255,0.03)",
          }}
          onClick={() => onRetrain({ edge_trees: r.trees, edge_depth: r.depth })}
        >
          <div style={{ fontSize: 12, color: fits ? "#52c41a" : "#999" }}>{KB(r.flash_bytes)}</div>
          <Tag color={f1Color(r.macro_f1)} style={{ marginInlineEnd: 0 }}>{r.macro_f1 == null ? "-" : r.macro_f1.toFixed(3)}</Tag>
        </div>
      </Tooltip>
    );
  };

  return (
    <Modal
      title={`体积曲线 · 训练记录 #${versionId ?? ""}`}
      open={versionId != null}
      onCancel={onClose}
      footer={null}
      width={isRf ? Math.min(980, 260 + 130 * Math.max(depths.length, 3)) : 760}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={10}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isRf
            ? `棵数 × 深度，不重训直接剪：体积按板上紧凑编码算，F1 用板上那套特征在留出集（${data?.split ?? "val"} · ${data?.holdout_n ?? "?"} 窗）上算。绿底 = 不超过 ${budgetKb} KB。点一格 → 按这个规格重训（重训比剪枝准）。`
            : "1D-CNN 的体积由 filters 决定，换 filters 要重训才有 F1；下面是各档的 int8 体积（权重 + 偏置/乘子，不含运行时代码）。点一行 → 按这个规格重训。"}
        </Typography.Text>
        {err && <Alert type="error" showIcon message={err} />}
        {loading && <Alert type="info" showIcon message="在算，留出集要逐条过一遍树，几十秒到几分钟…" />}
        {isRf && data && (
          <Table
            size="small"
            rowKey="trees"
            pagination={false}
            loading={loading}
            dataSource={trees.map((t) => ({ trees: t }))}
            columns={[
              { title: "棵数 \\ 深度", dataIndex: "trees", width: 100, render: (t: number) => <b>{t} 棵</b> },
              ...depths.map((d) => ({
                title: `深 ${d}`,
                width: 120,
                align: "center" as const,
                render: (_: unknown, row: { trees: number }) => renderCell(cell(row.trees, d)),
              })),
            ]}
          />
        )}
        {!isRf && data && (
          <Table
            size="small"
            rowKey={(r: SizeCurveRow) => (r.filters ?? []).join(",")}
            pagination={false}
            loading={loading}
            dataSource={rows}
            onRow={(r) => ({ onClick: () => onRetrain({ edge_filters: r.filters }), style: { cursor: "pointer" } })}
            columns={[
              { title: "filters", render: (_, r: SizeCurveRow) => <span>{(r.filters ?? []).join(" / ")}{r.current && <Tag color="purple" style={{ marginLeft: 6 }}>当前</Tag>}</span> },
              {
                title: "int8 体积", width: 110,
                render: (_, r: SizeCurveRow) => <span style={{ color: r.flash_bytes <= budget ? "#52c41a" : undefined }}>{KB(r.flash_bytes)}</span>,
              },
              { title: "每窗乘加", width: 110, render: (_, r: SizeCurveRow) => r.macs?.toLocaleString() ?? "-" },
              {
                title: "F1（训练时）", width: 110,
                render: (_, r: SizeCurveRow) => (r.macro_f1 == null ? <span style={{ color: "#888" }}>要重训</span> : <Tag color={f1Color(r.macro_f1)}>{r.macro_f1.toFixed(3)}</Tag>),
              },
            ]}
          />
        )}
        {data && classes.length > 0 && isRf && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            鼠标放到格子上看各类 F1（{classes.join("、")}）。
          </Typography.Text>
        )}
        <Space>
          <Button size="small" onClick={compute} loading={loading}>重新算</Button>
          {data?.computed_at && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              算于 {new Date(data.computed_at * 1000).toLocaleString()}
            </Typography.Text>
          )}
          {!data && !loading && !err && (
            <Button size="small" type="primary" onClick={compute}>算一下</Button>
          )}
        </Space>
        {data === null && err && (
          <Button size="small" onClick={() => message.info("看训练记录的「日志」，最后一段是体积曲线的输出")}>哪里看报错</Button>
        )}
      </Space>
    </Modal>
  );
}
