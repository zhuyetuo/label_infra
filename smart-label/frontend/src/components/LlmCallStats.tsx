import { useMemo, useState } from "react";
import { Button, Empty, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  getImuModelStats, getLlmCallStats, getLocalModelStats, listLocalModels, resetLocalModelMeter,
  type LlmCallRow, type LlmCallSummary,
} from "@/api/llmProviders";
import "./LlmCallStats.css";

const { Text } = Typography;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtN = (n: number) => n.toLocaleString("zh-CN");
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : fmtN(n));

/** 「3 分钟前」这种。给的是 ISO 字符串，没有就返回 null */
function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 卡片右上角的「最近一次调用」。悬停看完整时刻 */
function LastCall({ at }: { at: string | null | undefined }) {
  const rel = ago(at);
  if (!rel) return <span className="llm-card__last">没调过</span>;
  return (
    <Tooltip title={`最近一次调用：${at!.replace("T", " ")}`}>
      <span className="llm-card__last">最近 {rel}</span>
    </Tooltip>
  );
}

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

/** 横轴标哪几天：首尾加中间几个，均匀摊开，最多 5 个。
 *  原来是「每 N 个标一次，外加最后一个」——最后那个常常紧挨着前一个，
 *  两个日期叠在一起糊成「09-1⁠9⁠0-20」。 */
function tickIndexes(n: number): Set<number> {
  if (n <= 1) return new Set([0]);
  const want = Math.min(5, n);
  const out = new Set<number>();
  for (let i = 0; i < want; i++) out.add(Math.round((i * (n - 1)) / (want - 1)));
  return out;
}

/** 按天的柱状图。一天一根，柱子用所在板块的主题色，失败那截用状态红；悬停看那天的数 */
function DayBars({ days, rows, value, failed, unit, height = 84 }: {
  days: number; rows: { day: string }[]; value: (r: { day: string } | null) => number;
  failed?: (r: { day: string } | null) => number; unit: string; height?: number;
}) {
  const cols = useMemo(() => fillDays(days, rows), [days, rows]);
  const max = Math.max(1, ...cols.map((c) => value(c.row)));
  const ticks = useMemo(() => tickIndexes(cols.length), [cols.length]);
  return (
    <div>
      <div className="llm-bars" style={{ height }}>
        {cols.map((c) => {
          const v = value(c.row);
          const f = failed ? failed(c.row) : 0;
          return (
            <Tooltip key={c.day} title={`${c.day}：${fmtN(v)} ${unit}${f ? `，失败 ${f}` : ""}`}>
              <div className="llm-bars__col" style={{ height }}>
                <div className="llm-bars__bar" style={{ height: v > 0 ? Math.max(3, (v / max) * height) : 0 }}>
                  {f > 0 && <div className="llm-bars__fail" style={{ height: Math.max(2, (f / max) * height) }} />}
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
      <div className="llm-bars__ticks">
        {cols.map((c, i) => <div key={c.day} className="llm-bars__tick">{ticks.has(i) ? c.day.slice(5) : ""}</div>)}
      </div>
    </div>
  );
}

interface Metric { label: string; value: React.ReactNode; tip?: string; bad?: boolean }

function Metrics({ items }: { items: Metric[] }) {
  return (
    <div className="llm-metrics">
      {items.map((m) => (
        <div key={m.label}>
          <Tooltip title={m.tip}>
            <div className={`llm-metric__k${m.tip ? " llm-metric--dashed" : ""}`} style={{ display: "inline-block" }}>{m.label}</div>
          </Tooltip>
          <div className={`llm-metric__v${m.bad ? " llm-metric__v--bad" : ""}`}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}

/** 一张模型卡：名字 + 几个数 + 按天柱图。顶边是所在板块的主题色 */
function ModelCard({ title, tag, lastAt, metrics, chart }: {
  title: React.ReactNode; tag?: React.ReactNode; lastAt?: string | null;
  metrics: Metric[]; chart?: React.ReactNode;
}) {
  return (
    <div className="llm-card">
      <div className="llm-card__hd">
        <span className="llm-card__name">{title}</span>
        {tag}
        {lastAt !== undefined && <LastCall at={lastAt} />}
      </div>
      <Metrics items={metrics} />
      {chart}
    </div>
  );
}

/** 一块统计：主题色标题条（竖杠 + 淡底）+ 合计 + 下面一排卡 */
function Section({ tone, title, tip, chips, extra, children }: {
  tone: 1 | 2 | 3; title: string; tip: string;
  chips?: { k: string; v: React.ReactNode }[]; extra?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className={`llm-sec llm-sec--${tone}`}>
      <div className="llm-sec__hd">
        <Tooltip title={tip}>
          <span className="llm-sec__title" style={{ borderBottom: "1px dashed var(--viz-ring)" }}>{title}</span>
        </Tooltip>
        {chips && chips.length > 0 && (
          <div className="llm-sec__chips">
            {chips.map((c) => <span key={c.k} className="llm-sec__chip">{c.k} <b>{c.v}</b></span>)}
          </div>
        )}
        <span style={{ marginLeft: "auto" }}>{extra}</span>
      </div>
      <div className="llm-sec__bd">{children}</div>
    </section>
  );
}

// 「模型服务」→「调用统计」：一个时间范围管三块——算法机上的本地模型、IMU 预测模型（AI 预标注）、
// 大模型 API。三块各一个主题色，块内每个模型一张卡：几个数 + 按天柱图，悬停柱子看那天的数。
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
    const extra = (live.data?.models ?? []).filter((m) => !seen.has(m.key)).map((m) => ({ key: m.key, name: m.name, calls: 0, frames: 0, errors: 0, total_ms: 0, avg_ms: 0, avg_ms_per_frame: 0, last_call_at: null as string | null, by_day: [] }));
    return [...(local.data?.models ?? []), ...extra];
  }, [local.data, live.data]);

  /** 最近一次调用：库里记的（跨重启保留）和视觉服务内存里的（更实时），谁新用谁 */
  const localLastAt = (key: string, fromDb: string | null): string | null => {
    const ts = liveByKey.get(key)?.meter?.last_at;
    const fromLive = ts ? new Date(ts * 1000).toISOString() : null;
    if (!fromDb) return fromLive;
    if (!fromLive) return fromDb;
    return new Date(fromLive) > new Date(fromDb) ? fromLive : fromDb;
  };

  const localSum = useMemo(() => localModels.reduce(
    (a, m) => ({ calls: a.calls + m.calls, frames: a.frames + m.frames, errors: a.errors + m.errors }),
    { calls: 0, frames: 0, errors: 0 }), [localModels]);
  const imuModels = imu.data?.models ?? [];
  const imuSum = useMemo(() => imuModels.reduce(
    (a, m) => ({ samples: a.samples + m.samples, segments: a.segments + m.segments, candidates: a.candidates + m.candidates }),
    { samples: 0, segments: 0, candidates: 0 }), [imuModels]);

  return (
    <div className="llm-stats">
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented value={days} onChange={(v) => setDays(v as number)} options={PERIODS} />
        <Text type="secondary" style={{ fontSize: 12 }}>三块统计共用这个时间范围；柱子是每天的量，悬停看具体数</Text>
      </Space>

      <div className="llm-stats__sections">
        <Section
          tone={1}
          title="本地模型（视觉服务）"
          tip="算法机（视觉服务）上的模型。它的计数在进程内存里，平台按小时落表：开着这页每 20 秒采一次、没人看时调度器每 5 分钟采一次，所以这里近乎实时又能按天看；「帧」是处理过的图片数，批量检测一次几十张。视觉服务重启不影响这里的历史"
          chips={[
            { k: "模型", v: localModels.length },
            { k: "调用", v: fmtN(localSum.calls) },
            { k: "帧", v: fmtK(localSum.frames) },
            ...(localSum.errors ? [{ k: "失败", v: <span style={{ color: "var(--viz-crit)" }}>{fmtN(localSum.errors)}</span> }] : []),
          ]}
          extra={
            <Popconfirm title="把视觉服务里的实时计数清零？（这里按天的历史不受影响）" onConfirm={async () => { await resetLocalModelMeter(); message.success("已清零"); live.refetch(); }}>
              <Button size="small" type="text">清零实时计数</Button>
            </Popconfirm>
          }
        >
          {localModels.map((m) => {
            const lv = liveByKey.get(m.key);
            return (
              <ModelCard
                key={m.key}
                title={m.name}
                tag={lv ? (lv.available ? <Tag color="green">已加载</Tag> : <Tag>未加载</Tag>) : undefined}
                lastAt={localLastAt(m.key, m.last_call_at)}
                metrics={[
                  { label: "调用", value: fmtN(m.calls), tip: "这段日期里的推理次数" },
                  { label: "帧", value: fmtK(m.frames), tip: "处理过的图片数，批量检测一次几十张" },
                  { label: "每帧耗时", value: m.frames ? `${m.avg_ms_per_frame} ms` : "—" },
                  { label: "失败", value: m.errors ? fmtN(m.errors) : "0", bad: m.errors > 0 },
                ]}
                chart={m.calls
                  ? <DayBars days={days} rows={m.by_day} value={(r) => (r as { calls?: number } | null)?.calls ?? 0} failed={(r) => (r as { errors?: number } | null)?.errors ?? 0} unit="次" />
                  : <div className="llm-empty">这段日期没调过</div>}
              />
            );
          })}
          {localModels.length === 0 && <Empty description={live.data?.error ? `连不上视觉服务：${live.data.error}` : "还没有数据"} />}
        </Section>

        <Section
          tone={2}
          title="IMU 预测模型（AI 预标注）"
          tip="IMU 行为预测模型（AI 预标注）。每次给一份样本跑预标注记一行：跑了几份样本、切了多少个窗口、出了多少段 / 多少个候选。同一份样本同一个模型重跑算同一次"
          chips={imuModels.length ? [
            { k: "模型", v: imuModels.length },
            { k: "样本", v: fmtN(imuSum.samples) },
            { k: "片段", v: fmtK(imuSum.segments) },
            { k: "候选", v: fmtK(imuSum.candidates) },
          ] : undefined}
        >
          {imuModels.map((m) => (
            <ModelCard
              key={`${m.model_tag}|${m.mode}`}
              title={m.model_tag}
              tag={<Tag>{m.mode}</Tag>}
              lastAt={m.last_at}
              metrics={[
                { label: "样本", value: fmtN(m.samples), tip: "跑过预标注的样本数" },
                { label: "窗口", value: fmtK(m.windows), tip: "切出来送模型的窗口数（2 秒一个）" },
                { label: "片段", value: fmtK(m.segments), tip: "预标出来的行为片段数" },
                { label: "候选", value: fmtK(m.candidates), tip: "送去人工确认的疑似片段数" },
              ]}
              chart={<DayBars days={days} rows={m.by_day} value={(r) => (r as { samples?: number } | null)?.samples ?? 0} unit="份样本" />}
            />
          ))}
          {imuModels.length === 0 && <Empty description="这段日期没跑过 AI 预标注" />}
        </Section>

        <Section
          tone={3}
          title="大模型 API"
          tip="「画面找片段」每问一段就是一次调用，「测试」也算一次。花费按各家价格估的，账以各家后台为准"
          chips={llm.data ? [
            { k: "累计", v: `${fmtN(llm.data.all_time.calls)} 次` },
            { k: "token", v: fmtK(llm.data.all_time.total_tokens) },
            { k: "花费", v: `$${llm.data.all_time.est_usd.toFixed(2)}` },
          ] : undefined}
        >
          <ModelCard
            title="这段日期合计"
            lastAt={llm.data?.last_at}
            metrics={[
              { label: "调用", value: llm.isLoading ? "…" : fmtN(t?.calls ?? 0) },
              { label: "失败", value: fmtN(t?.errors ?? 0), bad: (t?.errors ?? 0) > 0 },
              { label: "token", value: llm.isLoading ? "…" : fmtK(t?.total_tokens ?? 0), tip: `输入 ${fmtN(t?.input_tokens ?? 0)} / 输出 ${fmtN(t?.output_tokens ?? 0)}；单次 ${fmtN(t?.avg_tokens_per_call ?? 0)}` },
              { label: "花费", value: `$${(t?.est_usd ?? 0).toFixed(t && t.est_usd >= 1 ? 2 : 4)}`, tip: "按各家价格估的，账以各家后台为准" },
              { label: "耗时", value: t?.calls ? fmtMs(t.p50_latency_ms) : "—", tip: t?.calls ? `中位数。九成在 ${fmtMs(t.p90_latency_ms)} 内，最慢 ${fmtMs(t.max_latency_ms)}` : "一次调用从发出到收到回答" },
            ]}
            chart={
              <>
                <div className="llm-cap">每天调用次数（各家合计，红色是失败）</div>
                <DayBars days={days} rows={llm.data?.by_day ?? []} value={(r) => (r as LlmCallSummary | null)?.calls ?? 0} failed={(r) => (r as LlmCallSummary | null)?.errors ?? 0} unit="次" />
              </>
            }
          />
          {(llm.data?.by_model ?? []).map((m) => (
            <ModelCard
              key={`${m.provider}:${m.model}`}
              title={<Tooltip title={m.model}>{m.model.split("/").pop()}</Tooltip>}
              tag={<Tag>{m.provider}</Tag>}
              lastAt={m.last_at}
              metrics={[
                { label: "调用", value: fmtN(m.calls) },
                { label: "失败", value: fmtN(m.errors), bad: m.errors > 0 },
                { label: "token", value: fmtK(m.total_tokens), tip: `输入 ${fmtN(m.input_tokens)} / 输出 ${fmtN(m.output_tokens)}` },
                { label: "花费", value: `$${m.est_usd.toFixed(m.est_usd >= 1 ? 2 : 4)}` },
                { label: "耗时", value: fmtMs(m.p50_latency_ms), tip: "中位数" },
              ]}
            />
          ))}
          <div style={{ flex: "1 1 100%" }}>
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
        </Section>
      </div>
    </div>
  );
}
