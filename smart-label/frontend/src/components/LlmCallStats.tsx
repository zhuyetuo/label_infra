import { useState } from "react";
import { Button, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getLlmCallStats, listLocalModels, resetLocalModelMeter, type LlmCallRow, type LlmCallSummary } from "@/api/llmProviders";

const { Text } = Typography;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtN = (n: number) => n.toLocaleString("zh-CN");
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : fmtN(n));

// 一个主色（次数 / token）、一个状态色（失败）、一个中性色（轨道）。深浅色下都能看
const BLUE = "#2a78d6";
const RED = "#e34948";
const TRACK = "rgba(128,128,128,0.18)";

/** 一个大数字 + 一行小字。解释放 tooltip，不铺在页面上 */
function Tile({ title, value, sub, tip }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: string }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 150, padding: "10px 14px", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
      <Tooltip title={tip}>
        <Text type="secondary" style={{ fontSize: 12, borderBottom: tip ? "1px dashed rgba(128,128,128,0.6)" : undefined }}>{title}</Text>
      </Tooltip>
      <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.3, marginTop: 2 }}>{value}</div>
      {sub && <Text type="secondary" style={{ fontSize: 12 }}>{sub}</Text>}
    </div>
  );
}

/** 一行一个条：名字 | 条 | 数字。条长按这一组里的最大值算 */
function BarRow({ name, value, max, label, extra, failed }: { name: React.ReactNode; value: number; max: number; label: string; extra?: React.ReactNode; failed?: number }) {
  const w = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  const fw = max > 0 && failed ? (failed / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
      <div style={{ width: 220, flex: "0 0 220px", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      <div style={{ flex: 1, height: 10, background: TRACK, borderRadius: 4, position: "relative", overflow: "hidden" }}>
        <div style={{ width: `${w}%`, height: "100%", background: BLUE, borderRadius: 4 }} />
        {fw > 0 && <div style={{ position: "absolute", left: 0, top: 0, width: `${fw}%`, height: "100%", background: RED, borderRadius: 4 }} />}
      </div>
      <div style={{ width: 210, flex: "0 0 210px", fontSize: 12, textAlign: "right" }}>
        <b>{label}</b>
        {extra && <Text type="secondary" style={{ marginLeft: 6 }}>{extra}</Text>}
      </div>
    </div>
  );
}

/** 按天的柱：一天一根，失败的那部分红。悬停看数 */
function DayBars({ rows, pick, unit }: { rows: (LlmCallSummary & { day: string })[]; pick: (r: LlmCallSummary) => number; unit: string }) {
  const max = Math.max(1, ...rows.map(pick));
  const H = 72;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: H + 18, overflowX: "auto" }}>
      {rows.map((r) => {
        const v = pick(r);
        const h = (v / max) * H;
        const fh = unit === "次" && r.errors ? (r.errors / max) * H : 0;
        return (
          <Tooltip key={r.day} title={`${r.day}：${fmtN(v)} ${unit}${unit === "次" && r.errors ? `，失败 ${r.errors}` : ""}`}>
            <div style={{ flex: "1 0 8px", maxWidth: 28, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: H + 18 }}>
              <div style={{ width: "100%", height: Math.max(v > 0 ? 2 : 0, h), background: BLUE, borderRadius: "3px 3px 0 0", position: "relative" }}>
                {fh > 0 && <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: fh, background: RED, borderRadius: "3px 3px 0 0" }} />}
              </div>
              <div style={{ fontSize: 10, color: "#999", marginTop: 3, whiteSpace: "nowrap" }}>{r.day.slice(5)}</div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

// 「模型服务」→「调用统计」：一屏看完。数字放瓷砖里，占比用条，按天用柱，解释放 tooltip。
export default function LlmCallStats() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({ queryKey: ["llm-call-stats", days], queryFn: () => getLlmCallStats(days), refetchInterval: 30_000 });
  const local = useQuery({ queryKey: ["local-models"], queryFn: listLocalModels, refetchInterval: 30_000 });
  const t = data?.total;
  const models = local.data?.models ?? [];
  const maxCalls = Math.max(0, ...models.map((m) => m.meter.calls));
  const byModel = data?.by_model ?? [];
  const maxModel = Math.max(0, ...byModel.map((m) => m.calls));

  return (
    <Space direction="vertical" size={20} style={{ width: "100%" }}>
      <div>
        <Space style={{ marginBottom: 6 }}>
          <Tooltip title={`算法机上各模型的推理次数和耗时。计数在视觉服务进程里，服务重启归零${local.data?.uptime_s != null ? `（已运行 ${Math.round(local.data.uptime_s / 60)} 分钟）` : ""}。「帧」是处理过的图片数，批量检测一次几十张`}>
            <Text strong style={{ borderBottom: "1px dashed rgba(128,128,128,0.6)" }}>本地模型</Text>
          </Tooltip>
          <Popconfirm title="把本地模型的计数清零？" onConfirm={async () => { await resetLocalModelMeter(); message.success("已清零"); local.refetch(); }}>
            <Button size="small" type="text">清零</Button>
          </Popconfirm>
        </Space>
        {models.map((m) => (
          <BarRow
            key={m.key}
            name={<span>{m.available ? <Tag color="green" style={{ marginRight: 6 }}>在</Tag> : <Tag style={{ marginRight: 6 }}>未加载</Tag>}{m.name}</span>}
            value={m.meter.calls}
            max={maxCalls}
            failed={m.meter.errors}
            label={m.meter.calls ? `${fmtN(m.meter.calls)} 次` : "—"}
            extra={m.meter.calls ? `${fmtK(m.meter.frames)} 帧 · ${m.meter.avg_ms_per_frame} ms/帧${m.meter.errors ? ` · 失败 ${m.meter.errors}` : ""}` : "还没调过"}
          />
        ))}
      </div>

      <div>
        <Space style={{ marginBottom: 8 }} wrap>
          <Tooltip title="「画面找片段」每问一段就是一次调用，「测试」也算一次。花费按各家价格估的，账以各家后台为准。半分钟自动刷新">
            <Text strong style={{ borderBottom: "1px dashed rgba(128,128,128,0.6)" }}>大模型 API</Text>
          </Tooltip>
          <Segmented size="small" value={days} onChange={(v) => setDays(v as number)}
                     options={[{ label: "今天", value: 1 }, { label: "7 天", value: 7 }, { label: "30 天", value: 30 }, { label: "90 天", value: 90 }, { label: "一年", value: 365 }]} />
          {data && <Text type="secondary" style={{ fontSize: 12 }}>累计 {fmtN(data.all_time.calls)} 次 · {fmtK(data.all_time.total_tokens)} token · ${data.all_time.est_usd.toFixed(2)}</Text>}
        </Space>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Tile title="调用" value={isLoading ? "…" : fmtN(t?.calls ?? 0)} sub={t?.errors ? <span style={{ color: RED }}>失败 {t.errors}</span> : t?.calls ? "没有失败" : undefined} />
          <Tile title="token" value={isLoading ? "…" : fmtK(t?.total_tokens ?? 0)} sub={t?.calls ? `单次 ${fmtN(t.avg_tokens_per_call)}` : undefined} tip={`输入 ${fmtN(t?.input_tokens ?? 0)} / 输出 ${fmtN(t?.output_tokens ?? 0)}`} />
          <Tile title="花费" value={`$${(t?.est_usd ?? 0).toFixed(t && t.est_usd >= 1 ? 2 : 4)}`} tip="按各家价格估的，账以各家后台为准" />
          <Tile title="耗时" value={t?.calls ? fmtMs(t.p50_latency_ms) : "—"} sub={t?.calls ? `九成在 ${fmtMs(t.p90_latency_ms)} 内 · 最慢 ${fmtMs(t.max_latency_ms)}` : undefined} tip="一次调用从发出到收到回答。大数字是中位数（一半的调用比它快）" />
        </div>
        {(data?.by_day.length ?? 0) > 1 && (
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 320px" }}>
              <Text type="secondary" style={{ fontSize: 12 }}>每天调用次数（红色是失败）</Text>
              <DayBars rows={data!.by_day} pick={(r) => r.calls} unit="次" />
            </div>
            <div style={{ flex: "1 1 320px" }}>
              <Text type="secondary" style={{ fontSize: 12 }}>每天 token</Text>
              <DayBars rows={data!.by_day} pick={(r) => r.total_tokens} unit="token" />
            </div>
          </div>
        )}
        {byModel.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>按模型（条是调用次数，红色是失败）</Text>
            {byModel.map((m) => (
              <BarRow
                key={`${m.provider}:${m.model}`}
                name={<Tooltip title={m.model}><span><Text type="secondary">{m.provider}</Text> {m.model.split("/").pop()}</span></Tooltip>}
                value={m.calls}
                max={maxModel}
                failed={m.errors}
                label={`${fmtN(m.calls)} 次`}
                extra={`${fmtK(m.total_tokens)} token · $${m.est_usd.toFixed(m.est_usd >= 1 ? 2 : 4)} · ${fmtMs(m.p50_latency_ms)}`}
              />
            ))}
          </div>
        )}
        <Table
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={data?.recent ?? []}
          pagination={false}
          title={() => <Text type="secondary" style={{ fontSize: 12 }}>最近 {data?.recent.length ?? 0} 次</Text>}
          columns={[
            { title: "时间", dataIndex: "created_at", width: 150, render: (v: string | null) => (v ? v.replace("T", " ").slice(5, 19) : "—") },
            { title: "模型", width: 260, render: (_: unknown, r: LlmCallRow) => <span><Text type="secondary">{r.provider}</Text> {r.model.split("/").pop()}</span> },
            { title: "用途", dataIndex: "purpose", width: 80, render: (v: string, r: LlmCallRow) => (v === "test" ? <Tag>测试</Tag> : <Tag color="blue">找片段{r.task_id != null ? ` #${r.task_id}` : ""}</Tag>) },
            { title: "token", width: 110, render: (_: unknown, r: LlmCallRow) => <Tooltip title={`输入 ${fmtN(r.input_tokens)} / 输出 ${fmtN(r.output_tokens)}`}>{fmtN(r.input_tokens + r.output_tokens)}</Tooltip> },
            { title: "耗时", dataIndex: "latency_ms", width: 90, render: fmtMs },
            {
              title: "结果",
              render: (_: unknown, r: LlmCallRow) =>
                r.ok ? <Tag color="green">成功</Tag> : (
                  <Tooltip title={r.error ?? ""}>
                    <Tag color="red">失败</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{(r.error ?? "").slice(0, 50)}</Text>
                  </Tooltip>
                ),
            },
          ]}
        />
      </div>
    </Space>
  );
}
