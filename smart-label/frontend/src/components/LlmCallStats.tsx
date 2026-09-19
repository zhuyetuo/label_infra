import { useMemo, useState } from "react";
import { Button, Empty, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  getImuModelStats, getLlmCallStats, getLocalModelStats, listLocalModels, resetLocalModelMeter,
  type LlmCallRow, type LlmCallSummary,
} from "@/api/llmProviders";

const { Text } = Typography;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtN = (n: number) => n.toLocaleString("zh-CN");
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : fmtN(n));

const BLUE = "#2a78d6";
const RED = "#e34948";

const PERIODS = [
  { label: "今天", value: 1 }, { label: "7 天", value: 7 }, { label: "30 天", value: 30 }, { label: "90 天", value: 90 }, { label: "一年", value: 365 },
];

/** 把 by_day 补齐成这段日期里每一天都有一根柱（没数据的是 0），不然图会跟着数据缩水 */
function fillDays(days: number, rows: { day: string }[]) {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; row: { day: string } | null }[] = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ day: key, row: by.get(key) ?? null });
  }
  return out;
}

/** 按天的柱状图。一天一根，悬停看数；红色叠失败。天数多时只标部分日期 */
function DayBars({ days, rows, value, failed, unit, height = 90 }: {
  days: number; rows: { day: string }[]; value: (r: { day: string } | null) => number; failed?: (r: { day: string } | null) => number; unit: string; height?: number;
}) {
  const cols = useMemo(() => fillDays(days, rows), [days, rows]);
  const max = Math.max(1, ...cols.map((c) => value(c.row)));
  const step = cols.length > 45 ? 30 : cols.length > 14 ? 7 : 1;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: cols.length > 60 ? 1 : 2, height: height + 18 }}>
      {cols.map((c, i) => {
        const v = value(c.row);
        const f = failed ? failed(c.row) : 0;
        const h = (v / max) * height;
        const showLabel = i % step === 0 || i === cols.length - 1;
        return (
          <Tooltip key={c.day} title={`${c.day}：${fmtN(v)} ${unit}${f ? `，失败 ${f}` : ""}`}>
            <div style={{ flex: "1 1 0", minWidth: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: height + 18 }}>
              <div style={{ width: "100%", height: Math.max(v > 0 ? 2 : 0, h), background: BLUE, borderRadius: "3px 3px 0 0", position: "relative" }}>
                {f > 0 && <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: (f / max) * height, background: RED, borderRadius: "3px 3px 0 0" }} />}
              </div>
              <div style={{ fontSize: 10, color: "#999", marginTop: 3, whiteSpace: "nowrap", height: 14 }}>{showLabel ? c.day.slice(5) : ""}</div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** 一张模型卡：标题 + 几个数 + 按天柱图 */
function ModelCard({ title, tag, stats, chart }: { title: React.ReactNode; tag?: React.ReactNode; stats: { label: string; value: React.ReactNode; tip?: string }[]; chart: React.ReactNode }) {
  return (
    <div style={{ flex: "1 1 420px", minWidth: 360, padding: "10px 14px 6px", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <b style={{ fontSize: 14 }}>{title}</b>
        {tag}
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 }}>
        {stats.map((s) => (
          <div key={s.label}>
            <Tooltip title={s.tip}>
              <Text type="secondary" style={{ fontSize: 12, borderBottom: s.tip ? "1px dashed rgba(128,128,128,0.6)" : undefined }}>{s.label}</Text>
            </Tooltip>
            <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>{s.value}</div>
          </div>
        ))}
      </div>
      {chart}
    </div>
  );
}

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

function SectionTitle({ children, tip, extra }: { children: React.ReactNode; tip: string; extra?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 8px", flexWrap: "wrap" }}>
      <Tooltip title={tip}>
        <Text strong style={{ fontSize: 15, borderBottom: "1px dashed rgba(128,128,128,0.6)" }}>{children}</Text>
      </Tooltip>
      {extra}
    </div>
  );
}

// 「模型服务」→「调用统计」：一个时间范围管三块——算法机上的本地模型、IMU 预测模型（AI 预标注）、
// 大模型 API。每个模型一张卡：几个总数 + 按天的柱状图，悬停柱子看那天的数。
export default function LlmCallStats() {
  const [days, setDays] = useState(30);
  // 本地模型：这个接口每次会顺手从视觉服务采一次计数（20 秒限流），所以开着页面每 20 秒刷一次就是准实时
  const local = useQuery({ queryKey: ["local-model-stats", days], queryFn: () => getLocalModelStats(days), refetchInterval: 20_000 });
  const live = useQuery({ queryKey: ["local-models"], queryFn: listLocalModels, refetchInterval: 30_000 });
  const imu = useQuery({ queryKey: ["imu-model-stats", days], queryFn: () => getImuModelStats(days), refetchInterval: 60_000 });
  const llm = useQuery({ queryKey: ["llm-call-stats", days], queryFn: () => getLlmCallStats(days), refetchInterval: 30_000 });
  const t = llm.data?.total;
  const liveByKey = new Map((live.data?.models ?? []).map((m) => [m.key, m]));
  // 本地模型：没落过表的（比如从没调过）也列出来，名字用视觉服务给的
  const localModels = useMemo(() => {
    const seen = new Set((local.data?.models ?? []).map((m) => m.key));
    const extra = (live.data?.models ?? []).filter((m) => !seen.has(m.key)).map((m) => ({ key: m.key, name: m.name, calls: 0, frames: 0, errors: 0, total_ms: 0, avg_ms: 0, avg_ms_per_frame: 0, by_day: [] }));
    return [...(local.data?.models ?? []), ...extra];
  }, [local.data, live.data]);

  return (
    <Space direction="vertical" size={22} style={{ width: "100%" }}>
      <Space wrap>
        <Segmented value={days} onChange={(v) => setDays(v as number)} options={PERIODS} />
        <Text type="secondary" style={{ fontSize: 12 }}>三块统计共用这个时间范围；柱子是每天的量，悬停看具体数</Text>
      </Space>

      <div>
        <SectionTitle
          tip="算法机（视觉服务）上的模型。它的计数在进程内存里，平台按小时落表：开着这页每 20 秒采一次、没人看时调度器每 5 分钟采一次，所以这里近乎实时又能按天看；「帧」是处理过的图片数，批量检测一次几十张。视觉服务重启不影响这里的历史"
          extra={
            <Popconfirm title="把视觉服务里的实时计数清零？（这里按天的历史不受影响）" onConfirm={async () => { await resetLocalModelMeter(); message.success("已清零"); live.refetch(); }}>
              <Button size="small" type="text">清零实时计数</Button>
            </Popconfirm>
          }
        >
          本地模型
        </SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {localModels.map((m) => {
            const lv = liveByKey.get(m.key);
            return (
              <ModelCard
                key={m.key}
                title={m.name}
                tag={lv ? (lv.available ? <Tag color="green">已加载</Tag> : <Tag>未加载</Tag>) : undefined}
                stats={[
                  { label: "调用", value: fmtN(m.calls), tip: "这段日期里的推理次数" },
                  { label: "帧", value: fmtK(m.frames), tip: "处理过的图片数，批量检测一次几十张" },
                  { label: "每帧耗时", value: m.frames ? `${m.avg_ms_per_frame} ms` : "—" },
                  { label: "失败", value: m.errors ? <span style={{ color: RED }}>{m.errors}</span> : "0" },
                ]}
                chart={m.calls ? <DayBars days={days} rows={m.by_day} value={(r) => (r as { calls?: number } | null)?.calls ?? 0} failed={(r) => (r as { errors?: number } | null)?.errors ?? 0} unit="次" /> : <Text type="secondary" style={{ fontSize: 12 }}>这段日期没调过</Text>}
              />
            );
          })}
          {localModels.length === 0 && <Empty description={live.data?.error ? `连不上视觉服务：${live.data.error}` : "还没有数据"} />}
        </div>
      </div>

      <div>
        <SectionTitle tip="IMU 行为预测模型（AI 预标注）。每次给一份样本跑预标注记一行：跑了几份样本、切了多少个窗口、出了多少段 / 多少个候选。同一份样本同一个模型重跑算同一次">
          IMU 预测模型（AI 预标注）
        </SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {(imu.data?.models ?? []).map((m) => (
            <ModelCard
              key={`${m.model_tag}|${m.mode}`}
              title={m.model_tag}
              tag={<Tag>{m.mode}</Tag>}
              stats={[
                { label: "样本", value: fmtN(m.samples), tip: "跑过预标注的样本数" },
                { label: "窗口", value: fmtK(m.windows), tip: "切出来送模型的窗口数（2 秒一个）" },
                { label: "片段", value: fmtK(m.segments), tip: "预标出来的行为片段数" },
                { label: "候选", value: fmtK(m.candidates), tip: "送去人工确认的疑似片段数" },
              ]}
              chart={<DayBars days={days} rows={m.by_day} value={(r) => (r as { samples?: number } | null)?.samples ?? 0} unit="份样本" />}
            />
          ))}
          {(imu.data?.models?.length ?? 0) === 0 && <Empty description="这段日期没跑过 AI 预标注" />}
        </div>
      </div>

      <div>
        <SectionTitle tip="「画面找片段」每问一段就是一次调用，「测试」也算一次。花费按各家价格估的，账以各家后台为准">
          大模型 API
          {llm.data && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>累计 {fmtN(llm.data.all_time.calls)} 次 · {fmtK(llm.data.all_time.total_tokens)} token · ${llm.data.all_time.est_usd.toFixed(2)}</Text>}
        </SectionTitle>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <Tile title="调用" value={llm.isLoading ? "…" : fmtN(t?.calls ?? 0)} sub={t?.errors ? <span style={{ color: RED }}>失败 {t.errors}</span> : t?.calls ? "没有失败" : undefined} />
          <Tile title="token" value={llm.isLoading ? "…" : fmtK(t?.total_tokens ?? 0)} sub={t?.calls ? `单次 ${fmtN(t.avg_tokens_per_call)}` : undefined} tip={`输入 ${fmtN(t?.input_tokens ?? 0)} / 输出 ${fmtN(t?.output_tokens ?? 0)}`} />
          <Tile title="花费" value={`$${(t?.est_usd ?? 0).toFixed(t && t.est_usd >= 1 ? 2 : 4)}`} tip="按各家价格估的，账以各家后台为准" />
          <Tile title="耗时" value={t?.calls ? fmtMs(t.p50_latency_ms) : "—"} sub={t?.calls ? `九成在 ${fmtMs(t.p90_latency_ms)} 内 · 最慢 ${fmtMs(t.max_latency_ms)}` : undefined} tip="一次调用从发出到收到回答。大数字是中位数" />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          {(llm.data?.by_model ?? []).map((m) => {
            const rows = (llm.data?.by_day ?? []) as (LlmCallSummary & { day: string })[];
            return (
              <ModelCard
                key={`${m.provider}:${m.model}`}
                title={<Tooltip title={m.model}>{m.model.split("/").pop()}</Tooltip>}
                tag={<Tag>{m.provider}</Tag>}
                stats={[
                  { label: "调用", value: fmtN(m.calls) },
                  { label: "失败", value: m.errors ? <span style={{ color: RED }}>{m.errors}</span> : "0" },
                  { label: "token", value: fmtK(m.total_tokens), tip: `输入 ${fmtN(m.input_tokens)} / 输出 ${fmtN(m.output_tokens)}` },
                  { label: "花费", value: `$${m.est_usd.toFixed(m.est_usd >= 1 ? 2 : 4)}` },
                  { label: "耗时", value: fmtMs(m.p50_latency_ms), tip: "中位数" },
                ]}
                // 按天那张表是所有模型合在一起的，这里没法按模型拆：只有一家时它就是这家的
                chart={(llm.data?.by_model.length ?? 0) === 1 ? <DayBars days={days} rows={rows} value={(r) => (r as LlmCallSummary | null)?.calls ?? 0} failed={(r) => (r as LlmCallSummary | null)?.errors ?? 0} unit="次" /> : null}
              />
            );
          })}
        </div>
        {(llm.data?.by_model.length ?? 0) > 1 && (
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>每天调用次数（各家合计，红色是失败）</Text>
            <DayBars days={days} rows={llm.data!.by_day} value={(r) => (r as LlmCallSummary | null)?.calls ?? 0} failed={(r) => (r as LlmCallSummary | null)?.errors ?? 0} unit="次" />
          </div>
        )}
        <Table
          size="small"
          rowKey="id"
          loading={llm.isLoading}
          dataSource={llm.data?.recent ?? []}
          pagination={false}
          title={() => <Text type="secondary" style={{ fontSize: 12 }}>最近 {llm.data?.recent.length ?? 0} 次</Text>}
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
