import { useMemo, useState } from "react";
import { Alert, Collapse, Drawer, Input, Progress, Space, Spin, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { mlExplain, mlFeatures, type MlFeatureInfo, type MlFeatureValue } from "@/api/skin";

const tierColor = (t?: string | null) => (t?.endsWith("2") ? "red" : t?.endsWith("1") ? "orange" : t ? "green" : undefined);
const fmtV = (v: unknown) => (v == null ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

/** 一档一档的概率条 */
function ProbaBars({ proba }: { proba: Record<string, number> }) {
  return (
    <div style={{ maxWidth: 360 }}>
      {Object.entries(proba).map(([k, v]) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Tag color={tierColor(k)} style={{ width: 36, textAlign: "center", marginRight: 0 }}>{k}</Tag>
          <Progress percent={Math.round(v * 100)} format={(p) => `${p}%`} size="small" strokeColor={tierColor(k) === "red" ? "#ff4d4f" : tierColor(k) === "orange" ? "#fa8c16" : "#52c41a"} />
        </div>
      ))}
    </div>
  );
}

/** 这个值在训练数据里大概在哪：低 / 正常 / 高，超出范围标红 */
function Position({ f }: { f: MlFeatureValue }) {
  if (f.pct == null) return <Typography.Text type="secondary">—</Typography.Text>;
  const txt = f.out_of_range ? "超出训练范围" : f.pct >= 90 ? "偏高" : f.pct <= 10 ? "偏低" : "正常范围";
  return (
    <Tooltip title={`训练数据里：10% 分位 ${fmtV(f.p10)}，中位数 ${fmtV(f.p50)}，90% 分位 ${fmtV(f.p90)}；这天排在第 ${Math.round(f.pct)} 百分位`}>
      <Tag color={f.out_of_range ? "error" : f.pct >= 90 || f.pct <= 10 ? "warning" : "default"}>{txt}</Tag>
    </Tooltip>
  );
}

/** 推高 / 拉低 这一档的条 */
function Contrib({ items, tier }: { items: MlFeatureValue[]; tier: string }) {
  const max = Math.max(0.01, ...items.map((x) => Math.abs(x.delta ?? 0)));
  if (!items.length) return <Typography.Text type="secondary">没有哪个维度单独起明显作用</Typography.Text>;
  return (
    <Table size="small" pagination={false} rowKey="feature" dataSource={items}
      columns={[
        {
          title: "维度", render: (_: unknown, f: MlFeatureValue) => (
            <Tooltip title={f.role || undefined}>
              <span>{f.name}</span><div style={{ fontSize: 11, color: "#888" }}>{f.group}</div>
            </Tooltip>
          ),
        },
        { title: "这天的值", render: (_: unknown, f: MlFeatureValue) => fmtV(f.value) },
        { title: "在训练数据里", render: (_: unknown, f: MlFeatureValue) => <Position f={f} /> },
        {
          title: <Tooltip title={`把这个维度换成训练数据里的典型值（中位数），判成 ${tier} 的概率会变多少。正 = 把它往 ${tier} 推；负 = 往别的档拉`}>对判成 {tier} 的作用</Tooltip>,
          width: 220,
          render: (_: unknown, f: MlFeatureValue) => {
            const d = f.delta ?? 0;
            const w = Math.round((Math.abs(d) / max) * 100);
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 120, height: 8, background: "#8882", borderRadius: 4, position: "relative" }}>
                  <div style={{ position: "absolute", left: d >= 0 ? 0 : undefined, right: d < 0 ? 0 : undefined, width: `${w}%`, height: 8, borderRadius: 4, background: d >= 0 ? "#fa541c" : "#1677ff" }} />
                </div>
                <span style={{ fontSize: 12, color: d >= 0 ? "#fa541c" : "#1677ff" }}>{d >= 0 ? "+" : ""}{Math.round(d * 100)}%</span>
              </div>
            );
          },
        },
      ]} />
  );
}

/** 某只狗某一天：ML 为什么这么判 */
export function MlExplainDrawer({ target, cPrefer, onClose }: {
  target: { imu: string; date: string; dog?: string } | null; cPrefer: "ai" | "human"; onClose: () => void;
}) {
  const { data, isFetching, error } = useQuery({
    queryKey: ["skin-ml-explain", target?.imu, target?.date, cPrefer],
    queryFn: () => mlExplain({ imu: target!.imu, date: target!.date, c_prefer: cPrefer }),
    enabled: !!target,
  });
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const m = new Map<string, MlFeatureValue[]>();
    for (const f of data?.features ?? []) {
      if (q && !f.name.includes(q) && !f.feature.includes(q)) continue;
      m.set(f.group, [...(m.get(f.group) ?? []), f]);
    }
    return [...m];
  }, [data, q]);
  return (
    <Drawer open={!!target} onClose={onClose} width={860} destroyOnClose
      title={target ? `为什么这么判：${target.dog ?? target.imu} · ${target.date}` : ""}>
      {isFetching && <Spin />}
      {error && <Alert type="error" showIcon message={(error as Error).message} />}
      {data && !data.ok && <Alert type="info" showIcon message={data.message} />}
      {data?.ok && (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {data.notes.map((n, i) => <Alert key={i} type="warning" showIcon message={n} />)}
          <div>
            <Typography.Title level={5}>模型 A（预测 C 档）：<Tag color={tierColor(data.a.tier)}>{data.a.tier}</Tag></Typography.Title>
            <ProbaBars proba={data.a.proba} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>起作用最大的维度：</Typography.Text>
            <Contrib items={data.a.top} tier={data.a.tier} />
          </div>
          <div>
            <Typography.Title level={5}>
              模型 B（预测 S 档）：<Tag color={tierColor(data.b.tier)}>{data.b.tier}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{data.b.source === "real" ? "兽医评级训练版" : "合成数据版"}</Typography.Text>
            </Typography.Title>
            <ProbaBars proba={data.b.proba} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>起作用最大的维度（「模型A判…的概率」= 模型 A 的结论在模型 B 里占的分量）：</Typography.Text>
            <Contrib items={data.b.top} tier={data.b.tier} />
          </div>
          <div>
            <Space style={{ marginBottom: 6 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>这天全部 {data.features.length} 个维度</Typography.Title>
              <Input.Search size="small" allowClear placeholder="搜维度" style={{ width: 180 }} onChange={(e) => setQ(e.target.value)} />
            </Space>
            <Collapse size="small" items={groups.map(([g, fs]) => ({
              key: g,
              label: <span>{g} <Typography.Text type="secondary">（{fs.length}）{fs.some((f) => f.out_of_range) && <Tag color="error" style={{ marginLeft: 6 }}>有超出范围的</Tag>}</Typography.Text></span>,
              children: (
                <Table size="small" pagination={false} rowKey="feature" dataSource={fs}
                  columns={[
                    { title: "维度", render: (_: unknown, f: MlFeatureValue) => <Tooltip title={f.role || f.feature}>{f.name}</Tooltip> },
                    { title: "这天的值", render: (_: unknown, f: MlFeatureValue) => fmtV(f.value) },
                    { title: "训练数据中位数", render: (_: unknown, f: MlFeatureValue) => fmtV(f.p50) },
                    { title: "在训练数据里", render: (_: unknown, f: MlFeatureValue) => <Position f={f} /> },
                  ]} />
              ),
            }))} />
          </div>
        </Space>
      )}
    </Drawer>
  );
}

/** ML 用了哪些维度、每个多重要 */
export function MlFeatureTable() {
  const { data, isFetching, error } = useQuery({ queryKey: ["skin-ml-features"], queryFn: mlFeatures, staleTime: 5 * 60_000 });
  const [q, setQ] = useState("");
  const rows = (data?.features ?? []).filter((f) => !q || f.name.includes(q) || f.feature.includes(q) || f.group.includes(q));
  const maxA = Math.max(0.001, ...rows.map((f) => f.imp_a ?? 0));
  const maxB = Math.max(0.001, ...rows.map((f) => f.imp_b ?? 0));
  const bar = (v: number | null | undefined, max: number, color: string) =>
    v == null ? <Typography.Text type="secondary">不用</Typography.Text> : (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 90, height: 8, background: "#8882", borderRadius: 4 }}>
          <div style={{ width: `${Math.max(0, (v / max) * 100)}%`, height: 8, borderRadius: 4, background: color }} />
        </div>
        <span style={{ fontSize: 11 }}>{(v * 100).toFixed(1)}%</span>
      </div>
    );
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        模型 A 用 IMU 抓挠数据算出来的维度预测 C 档；模型 B 在这些之上再加「模型 A 的判断」和 7 个问卷维度，预测 S 档。
        <b>重要性</b> = 在训练数据里把这一列打乱，模型准确率掉多少（掉得越多说明模型越依赖它；0 = 基本没用上）。
        训练数据见过的品种：{data?.breeds_seen?.join("、") ?? "…"}——别的品种模型当「不知道品种」处理。
        点表头排序；每只狗每天具体怎么判，在「ML 结果」里点档位看。
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={(error as Error).message} />}
      <Input.Search allowClear placeholder="搜维度 / 分组" style={{ width: 240, marginBottom: 8 }} onChange={(e) => setQ(e.target.value)} />
      {isFetching && !data && <Space><Spin /><Typography.Text type="secondary">第一次要算一两分钟（之后存下来，重训后才重算）</Typography.Text></Space>}
      <Table size="small" rowKey="feature" dataSource={rows} pagination={false} scroll={{ x: "max-content" }}
        columns={[
          { title: "维度", fixed: "left" as const, render: (_: unknown, f: MlFeatureInfo) => <div>{f.name}<div style={{ fontSize: 11, color: "#888" }}>{f.feature}</div></div> },
          { title: "分组", dataIndex: "group", filters: [...new Set((data?.features ?? []).map((f) => f.group))].map((g) => ({ text: g, value: g })), onFilter: (v, f: MlFeatureInfo) => f.group === v },
          { title: "模型 A 重要性", sorter: (a: MlFeatureInfo, b: MlFeatureInfo) => (a.imp_a ?? -1) - (b.imp_a ?? -1), render: (_: unknown, f: MlFeatureInfo) => bar(f.in_a ? f.imp_a : null, maxA, "#fa8c16") },
          { title: "模型 B 重要性", defaultSortOrder: "descend" as const, sorter: (a: MlFeatureInfo, b: MlFeatureInfo) => (a.imp_b ?? -1) - (b.imp_b ?? -1), render: (_: unknown, f: MlFeatureInfo) => bar(f.in_b ? f.imp_b : null, maxB, "#722ed1") },
          { title: "怎么算", dataIndex: "calc", width: 280, render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{v ?? "—"}</Typography.Text> },
          { title: "有什么用", dataIndex: "role", width: 280, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v ?? "—"}</Typography.Text> },
        ]} />
    </div>
  );
}
