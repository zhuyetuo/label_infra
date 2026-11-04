import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, InputNumber, Select, Space, Spin, Table, Tag, Tooltip, TreeSelect, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listLabels } from "@/api/labels";
import { listProjects } from "@/api/projects";
import { classCompare, comparePreview, type CompareFeature, type ComparePreviewSide, type CompareResult } from "@/api/dataPool";
import { fmtSecs } from "@/utils/fmtDuration";

const COLOR_A = "#fa8c16";
const COLOR_B = "#1677ff";

/** 数值显示：很小的用科学计数 */
const fmt = (v: number) => {
  if (!Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(3) : v.toFixed(4);
};

/** 两类叠在一起的直方图（SVG，不引图表库） */
function Hist({ f, w = 280, h = 70 }: { f: CompareFeature; w?: number; h?: number }) {
  const { token } = theme.useToken();
  const n = f.ha.length;
  const max = Math.max(...f.ha, ...f.hb, 1e-9);
  const bw = w / n;
  const cutX = ((f.cut - f.edges[0]) / (f.edges[n] - f.edges[0])) * w;
  return (
    <svg width={w} height={h + 14} style={{ display: "block" }}>
      {f.hb.map((v, i) => (
        <rect key={`b${i}`} x={i * bw} y={h - (v / max) * h} width={bw - 0.5} height={(v / max) * h} fill={COLOR_B} opacity={0.45} />
      ))}
      {f.ha.map((v, i) => (
        <rect key={`a${i}`} x={i * bw} y={h - (v / max) * h} width={bw - 0.5} height={(v / max) * h} fill={COLOR_A} opacity={0.45} />
      ))}
      {Number.isFinite(cutX) && cutX >= 0 && cutX <= w && (
        <line x1={cutX} x2={cutX} y1={0} y2={h} stroke={token.colorText} strokeDasharray="3 2" strokeWidth={1} />
      )}
      <text x={0} y={h + 12} fontSize={10} fill={token.colorTextTertiary}>{fmt(f.edges[0])}</text>
      <text x={w} y={h + 12} fontSize={10} fill={token.colorTextTertiary} textAnchor="end">{fmt(f.edges[n])}</text>
    </svg>
  );
}

/**
 * 类别对比：两类已标注片段的原始 IMU 数据，按维度（晃动大小、呼吸 / 心跳频段能量、陀螺本底、姿态…）
 * 逐个比。回答「模型老把 A 判成 B，是不是两类数据本来就几乎一样」，以及「哪个量能把它们分开」。
 */
export default function ClassCompare() {
  const { data: labels } = useQuery({ queryKey: ["labels-all"], queryFn: () => listLabels() });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const names = useMemo(
    () => [...new Set((labels ?? []).map((l) => l.display_name))].sort((x, y) => x.localeCompare(y)),
    [labels],
  );
  // 类别按层级摆（抓挠 → 头颈耳 / 肩胸 / 躯干…），按名字合并各项目的同名标签；选上级就含全部细类
  type TNode = { value: string; title: string; full: string; children?: TNode[] };
  const tree = useMemo<TNode[]>(() => {
    const byId = new Map((labels ?? []).map((l) => [l.id, l]));
    const parentName = new Map<string, string | null>();
    for (const l of labels ?? []) {
      const p = l.parent_id != null ? byId.get(l.parent_id)?.display_name ?? null : null;
      if (!parentName.has(l.display_name) || (p && !parentName.get(l.display_name))) parentName.set(l.display_name, p);
    }
    const kids = new Map<string | null, string[]>();
    for (const [n, p] of parentName) kids.set(p, [...(kids.get(p) ?? []), n]);
    const build = (p: string | null): TNode[] =>
      (kids.get(p) ?? []).sort((x, y) => x.localeCompare(y)).map((n) => {
        const ch = build(n);
        const short = p && n.startsWith(p + "-") ? n.slice(p.length + 1) : n;
        return { value: n, title: short, full: n, ...(ch.length ? { children: ch } : {}) };
      });
    return build(null);
  }, [labels]);
  const pick = (want: string[]) => names.filter((n) => want.includes(n)).slice(0, 1);
  const [a, setA] = useState<string[] | null>(null);
  const [b, setB] = useState<string[] | null>(null);
  const valA = a ?? pick(["未佩戴"]);
  const valB = b ?? pick(["静止/休息", "睡觉", "静止"]);
  const [projectIds, setProjectIds] = useState<number[]>([]);
  // 默认只用数据池：池里是认可过、标得准的；全部已标注里混着没人看过的 AI 片段，比出来不可信
  const [poolOnly, setPoolOnly] = useState(true);
  const [winS, setWinS] = useState(10);
  const [maxSeg, setMaxSeg] = useState(80);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CompareResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setRes(await classCompare({
        a: valA, b: valB, project_ids: projectIds.length ? projectIds : undefined, pool_only: poolOnly,
        win_s: winS, max_segments: maxSeg,
      }));
    } finally {
      setBusy(false);
    }
  };

  // 对比之前先看两类各有多少数据能用（不读 CSV，很快）
  const { data: pv, isFetching: pvLoading } = useQuery({
    queryKey: ["cmp-preview", valA, valB, projectIds, poolOnly, winS],
    queryFn: () => comparePreview({ a: valA, b: valB, project_ids: projectIds.length ? projectIds : undefined, pool_only: poolOnly, win_s: winS }),
    enabled: valA.length > 0 || valB.length > 0,
  });
  const pvLine = (side: "A" | "B", color: string, d?: ComparePreviewSide) => {
    if (!d) return null;
    if (!d.segments) {
      return (
        <div style={{ color: "#ff4d4f" }}>
          <Tag color={color}>{side}</Tag>没有数据{poolOnly ? "（数据池里还没有这一类？取消「只用数据池」试试，或者先去项目页把认可的片段加入数据池）" : ""}
        </div>
      );
    }
    return (
      <div>
        <Tag color={color}>{side}</Tag>
        {d.segments} 段 · {d.samples} 个样本 · 共 {fmtSecs(d.total_s)}
        <Typography.Text type="secondary">
          {" "}——≥{winS} 秒的 {d.long} 段{d.short ? `，比窗口短的 ${d.short} 段整段算` : ""}{d.too_short ? `，不到 1 秒的 ${d.too_short} 段不用` : ""}，约 {d.windows} 个窗口
          {d.samples < 5 ? "；样本少，比出来的可能是设备差异" : ""}
        </Typography.Text>
      </div>
    );
  };
  const noData = !!pv && (!pv.a.windows || !pv.b.windows);

  // 结论按「跨设备可靠」的维度里最好的那个说
  const top = res?.features?.find((f) => !f.device_sensitive) ?? res?.features?.[0];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="两类片段的原始数据逐个维度比"
        description="从两类已标注片段里各抽一批，切成固定长度的窗口，逐个特征比分布。AUC 0.5 = 两类这个量一样、分不开；越靠近 0 或 1 越好分。所有维度都分不开，说明原始数据本来就几乎一样，模型怎么训都难，得加新的输入（更高采样率、更长窗口）或者规则；某个维度明显能分开，就把它喂给模型或做成规则。"
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text><Tag color={COLOR_A}>A</Tag>
          <TreeSelect multiple showSearch treeLine style={{ minWidth: 220 }} popupMatchSelectWidth={false} value={valA}
            onChange={(v) => setA(v as string[])} treeData={tree} treeNodeFilterProp="full" treeNodeLabelProp="full"
            placeholder="类别 A（选上级含细类）" />
        </Typography.Text>
        <Typography.Text>对比 <Tag color={COLOR_B}>B</Tag>
          <TreeSelect multiple showSearch treeLine style={{ minWidth: 220 }} popupMatchSelectWidth={false} value={valB}
            onChange={(v) => setB(v as string[])} treeData={tree} treeNodeFilterProp="full" treeNodeLabelProp="full"
            placeholder="类别 B（选上级含细类）" />
        </Typography.Text>
        <Select mode="multiple" allowClear placeholder="项目（默认全部）" style={{ minWidth: 200 }} value={projectIds}
          onChange={setProjectIds} optionFilterProp="label" options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <Tooltip title="只用数据池里认可过的片段（标得准的）">
          <Checkbox checked={poolOnly} onChange={(e) => setPoolOnly(e.target.checked)}>只用数据池</Checkbox>
        </Tooltip>
        <Tooltip title="窗口越长，呼吸 / 心跳这类微振动越稳；片段比窗口短的不参与">
          <InputNumber min={1} max={120} value={winS} onChange={(v) => setWinS(v ?? 10)} addonBefore="窗口" addonAfter="秒" style={{ width: 150 }} />
        </Tooltip>
        <Tooltip title="每类最多抽这么多段（越多越准，也越慢：要读原始 CSV）">
          <InputNumber min={5} max={300} value={maxSeg} onChange={(v) => setMaxSeg(v ?? 80)} addonBefore="每类" addonAfter="段" style={{ width: 150 }} />
        </Tooltip>
        <Button type="primary" loading={busy} disabled={!valA.length || !valB.length || noData} onClick={run}>对比</Button>
      </Space>
      {/* 要用哪些数据：选完类别就出来，先确认有数据再比 */}
      <Spin spinning={pvLoading} size="small">
        <div style={{ fontSize: 12, lineHeight: 2, marginBottom: 12, minHeight: 24 }}>
          <Typography.Text type="secondary">将使用{poolOnly ? "数据池里" : "全部已标注"}的片段：</Typography.Text>
          {pvLine("A", COLOR_A, pv?.a)}
          {pvLine("B", COLOR_B, pv?.b)}
        </div>
      </Spin>

      <Spin spinning={busy} tip="读原始数据、算特征…（要读几十个 CSV，可能要几十秒）">
        {res?.error && <Alert type="warning" showIcon message={res.error} style={{ marginBottom: 12 }} />}
        {res && !res.error && (
          <>
            <Space size={24} wrap style={{ marginBottom: 8 }}>
              <Typography.Text><Tag color={COLOR_A}>A {res.a.names.join("、")}</Tag>{res.a.segments} 段 · {res.a.windows} 个窗口 · {res.a.samples} 个样本</Typography.Text>
              <Typography.Text><Tag color={COLOR_B}>B {res.b.names.join("、")}</Tag>{res.b.segments} 段 · {res.b.windows} 个窗口 · {res.b.samples} 个样本</Typography.Text>
              <Typography.Text type="secondary">窗口 {res.win_s} 秒</Typography.Text>
            </Space>
            {(res.warnings ?? []).map((w) => (
              <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 8 }} />
            ))}
            {top && (
              <Alert
                style={{ marginBottom: 12 }}
                type={top.sep >= 0.6 ? "success" : top.sep >= 0.3 ? "warning" : "error"}
                showIcon
                message={
                  top.sep >= 0.6
                    ? `能分开：「${top.name}」一刀切在 ${fmt(top.cut)}（${top.cut_side}）能对 ${(top.cut_acc * 100).toFixed(0)}%`
                    : top.sep >= 0.3
                      ? `勉强能分：最好的是「${top.name}」，一刀切只能对 ${(top.cut_acc * 100).toFixed(0)}%，要几个量组合起来用`
                      : `基本分不开：最好的「${top.name}」也只能对 ${(top.cut_acc * 100).toFixed(0)}%——这个采样率 / 窗口下两类原始数据几乎一样`
                }
              />
            )}
            {!!res.unreadable.length && (
              <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                有 {res.unreadable.length} 个 CSV 读不了，已跳过
              </Typography.Text>
            )}
            <Table<CompareFeature>
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={res.features}
              columns={[
                {
                  title: "维度",
                  width: 230,
                  render: (_, f) => (
                    <div>
                      <b>{f.name}</b>
                      {f.device_sensitive && (
                        <Tooltip title="这个量主要随设备标定 / 放置角度变：两类来自不同项圈时，比出来的差多半是换了项圈，不是类别差异">
                          <Tag color="default" style={{ marginLeft: 6, fontSize: 11 }}>跨设备不可靠</Tag>
                        </Tooltip>
                      )}
                      <div style={{ fontSize: 11, color: "#888" }}>{f.hint}</div>
                    </div>
                  ),
                },
                {
                  title: <Tooltip title="|AUC−0.5|×2：0 分不开，1 一刀分开">可分性</Tooltip>,
                  width: 120,
                  render: (_, f) => (
                    <div>
                      <Tag color={f.sep >= 0.6 ? "success" : f.sep >= 0.3 ? "warning" : "default"}>{(f.sep * 100).toFixed(0)}%</Tag>
                      <div style={{ fontSize: 11, color: "#888" }}>AUC {f.auc.toFixed(2)}</div>
                    </div>
                  ),
                },
                {
                  title: <span>分布（<span style={{ color: COLOR_A }}>A</span> / <span style={{ color: COLOR_B }}>B</span>，虚线 = 一刀切）</span>,
                  width: 300,
                  render: (_, f) => <Hist f={f} />,
                },
                {
                  title: "中位数 [25%–75%]",
                  render: (_, f) => (
                    <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                      <div><span style={{ color: COLOR_A }}>A</span> {fmt(f.qa[2])} [{fmt(f.qa[1])} – {fmt(f.qa[3])}]</div>
                      <div><span style={{ color: COLOR_B }}>B</span> {fmt(f.qb[2])} [{fmt(f.qb[1])} – {fmt(f.qb[3])}]</div>
                    </div>
                  ),
                },
                {
                  title: "一刀切",
                  width: 150,
                  render: (_, f) => (
                    <div style={{ fontSize: 12 }}>
                      {fmt(f.cut)}（{f.cut_side}）
                      <div style={{ color: "#888" }}>能对 {(f.cut_acc * 100).toFixed(0)}%</div>
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </Spin>
    </div>
  );
}
