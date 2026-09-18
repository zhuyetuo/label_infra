import { useState } from "react";
import { Card, Col, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getLlmCallStats, listLocalModels, resetLocalModelMeter, type LlmCallRow, type LlmCallSummary } from "@/api/llmProviders";
import { Button, Popconfirm, message } from "antd";

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const fmtN = (n: number) => n.toLocaleString("zh-CN");

// 「大模型 API」页下面的统计面板：调用了多少次、进出多少 token、单次平均多少、
// 每次从发出到回来多久、估了多少钱。视觉服务每问一段就是一次调用，平台落表后从这里汇总。
export default function LlmCallStats() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ["llm-call-stats", days],
    queryFn: () => getLlmCallStats(days),
    refetchInterval: 30_000,
  });
  const t = data?.total;
  // 本地模型的调用（视觉服务进程内存里的计数，重启归零）
  const local = useQuery({ queryKey: ["local-models"], queryFn: listLocalModels, refetchInterval: 30_000 });

  const summaryCols = [
    { title: "调用次数", dataIndex: "calls", width: 90, sorter: (a: LlmCallSummary, b: LlmCallSummary) => a.calls - b.calls },
    {
      title: "失败",
      dataIndex: "errors",
      width: 70,
      render: (v: number) => (v ? <span style={{ color: "#ff4d4f" }}>{v}</span> : 0),
    },
    {
      title: (
        <Tooltip title="输入 + 输出。输入是送进去的图和提示词，输出是模型回的那几十个字">总 token</Tooltip>
      ),
      dataIndex: "total_tokens",
      width: 120,
      sorter: (a: LlmCallSummary, b: LlmCallSummary) => a.total_tokens - b.total_tokens,
      render: (v: number, r: LlmCallSummary) => (
        <Tooltip title={`输入 ${fmtN(r.input_tokens)} / 输出 ${fmtN(r.output_tokens)}`}>{fmtN(v)}</Tooltip>
      ),
    },
    {
      title: <Tooltip title="平均每次调用消耗的 token（输入 + 输出）">单次 token</Tooltip>,
      dataIndex: "avg_tokens_per_call",
      width: 110,
      render: (v: number, r: LlmCallSummary) => (
        <Tooltip title={`输入 ${fmtN(r.avg_input_per_call)} / 输出 ${fmtN(r.avg_output_per_call)}`}>{fmtN(v)}</Tooltip>
      ),
    },
    {
      title: <Tooltip title="按各家价格估的，账以各家后台为准">估算花费</Tooltip>,
      dataIndex: "est_usd",
      width: 100,
      sorter: (a: LlmCallSummary, b: LlmCallSummary) => a.est_usd - b.est_usd,
      render: (v: number) => `$${v.toFixed(4)}`,
    },
    {
      title: <Tooltip title="一次调用从发出到收到回答的时间：平均 / 一半的调用在这以内 / 九成在这以内 / 最慢一次">耗时 均 / p50 / p90 / 最慢</Tooltip>,
      width: 260,
      render: (_: unknown, r: LlmCallSummary) =>
        r.calls ? `${fmtMs(r.avg_latency_ms)} / ${fmtMs(r.p50_latency_ms)} / ${fmtMs(r.p90_latency_ms)} / ${fmtMs(r.max_latency_ms)}` : "—",
    },
    {
      title: <Tooltip title="所有调用的耗时加起来（并行跑的话墙上时间比这短）">累计耗时</Tooltip>,
      dataIndex: "total_latency_s",
      width: 100,
      render: (v: number) => (v >= 60 ? `${(v / 60).toFixed(1)} 分` : `${v} 秒`),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>
          本地模型调用
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          算法机上狗检测 / SAM / 画面向量 / 姿态的推理次数和耗时。计数在视觉服务进程里，服务重启归零
          {local.data?.uptime_s != null ? `（已运行 ${Math.round(local.data.uptime_s / 60)} 分钟）` : ""}。
        </Typography.Text>
        <Popconfirm title="把本地模型的计数清零？" onConfirm={async () => { await resetLocalModelMeter(); message.success("已清零"); local.refetch(); }}>
          <Button size="small">清零</Button>
        </Popconfirm>
      </Space>
      <Table
        size="small"
        rowKey="key"
        loading={local.isLoading}
        dataSource={local.data?.models ?? []}
        pagination={false}
        style={{ marginBottom: 24 }}
        columns={[
          { title: "模型", dataIndex: "name", width: 240 },
          { title: "调用次数", width: 100, render: (_, m) => fmtN(m.meter.calls) },
          { title: <Tooltip title="处理过的图片数：批量检测一次几十张，所以帧数远大于次数">帧数</Tooltip>, width: 100, render: (_, m) => fmtN(m.meter.frames) },
          { title: "失败", width: 70, render: (_, m) => (m.meter.errors ? <span style={{ color: "#ff4d4f" }}>{m.meter.errors}</span> : 0) },
          { title: "单次平均耗时", width: 120, render: (_, m) => (m.meter.calls ? fmtMs(m.meter.avg_ms) : "—") },
          { title: "每帧平均耗时", width: 120, render: (_, m) => (m.meter.frames ? `${m.meter.avg_ms_per_frame} ms` : "—") },
          { title: "最慢一次", width: 100, render: (_, m) => (m.meter.calls ? fmtMs(m.meter.max_ms) : "—") },
          { title: "累计耗时", width: 100, render: (_, m) => (m.meter.total_ms >= 60000 ? `${(m.meter.total_ms / 60000).toFixed(1)} 分` : `${(m.meter.total_ms / 1000).toFixed(1)} 秒`) },
          { title: "最近一次", render: (_, m) => (m.meter.last_at ? new Date(m.meter.last_at * 1000).toLocaleString("zh-CN") : "—") },
          { title: "状态", width: 90, render: (_, m) => (m.available ? <Tag color="green">已加载</Tag> : <Tag>未加载</Tag>) },
        ]}
      />

      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>
          大模型 API 调用
        </Typography.Title>
        <Segmented
          size="small"
          value={days}
          onChange={(v) => setDays(v as number)}
          options={[
            { label: "今天", value: 1 },
            { label: "7 天", value: 7 },
            { label: "30 天", value: 30 },
            { label: "90 天", value: 90 },
            { label: "一年", value: 365 },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          「画面找片段」每问一段就是一次调用，「测试」也算一次。半分钟自动刷新。
          {data && (
            <>
              {" "}
              历史累计：{fmtN(data.all_time.calls)} 次、{fmtN(data.all_time.total_tokens)} token、约 ${data.all_time.est_usd.toFixed(4)}
            </>
          )}
        </Typography.Text>
      </Space>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={4}>
          <Card size="small" loading={isLoading}>
            <Statistic title="调用次数" value={t?.calls ?? 0} suffix={t?.errors ? <span style={{ color: "#ff4d4f", fontSize: 13 }}>失败 {t.errors}</span> : undefined} />
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small" loading={isLoading}>
            <Statistic
              title={<Tooltip title={`输入 ${fmtN(t?.input_tokens ?? 0)} / 输出 ${fmtN(t?.output_tokens ?? 0)}`}>总消耗 token</Tooltip>}
              value={t?.total_tokens ?? 0}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" loading={isLoading}>
            <Statistic title="单次平均 token" value={t?.avg_tokens_per_call ?? 0} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" loading={isLoading}>
            <Statistic title="估算花费" prefix="$" value={t?.est_usd ?? 0} precision={4} />
          </Card>
        </Col>
        <Col span={7}>
          <Card size="small" loading={isLoading}>
            <Statistic
              title={<Tooltip title="一次调用从发出到收到回答；括号里是一半 / 九成的调用在这以内、最慢一次">单次耗时（平均）</Tooltip>}
              value={t ? fmtMs(t.avg_latency_ms) : "—"}
              suffix={t?.calls ? <span style={{ fontSize: 12, color: "#999" }}>p50 {fmtMs(t.p50_latency_ms)} · p90 {fmtMs(t.p90_latency_ms)} · 最慢 {fmtMs(t.max_latency_ms)}</span> : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Typography.Text strong>按提供方 / 模型</Typography.Text>
      <Table
        size="small"
        rowKey={(r) => `${r.provider}:${r.model}`}
        loading={isLoading}
        dataSource={data?.by_model ?? []}
        pagination={false}
        style={{ marginBottom: 16 }}
        columns={[
          { title: "提供方", dataIndex: "provider", width: 100 },
          { title: "模型", dataIndex: "model", width: 260 },
          ...summaryCols,
        ]}
      />

      <Typography.Text strong>按天</Typography.Text>
      <Table
        size="small"
        rowKey="day"
        loading={isLoading}
        dataSource={[...(data?.by_day ?? [])].reverse()}
        pagination={{ pageSize: 10, size: "small", hideOnSinglePage: true }}
        style={{ marginBottom: 16 }}
        columns={[{ title: "日期", dataIndex: "day", width: 120 }, ...summaryCols]}
      />

      <Typography.Text strong>最近 {data?.recent.length ?? 0} 次调用</Typography.Text>
      <Table
        size="small"
        rowKey="id"
        loading={isLoading}
        dataSource={data?.recent ?? []}
        pagination={{ pageSize: 10, size: "small", hideOnSinglePage: true }}
        columns={[
          { title: "时间", dataIndex: "created_at", width: 170, render: (v: string | null) => (v ? v.replace("T", " ").slice(0, 19) : "—") },
          { title: "提供方", dataIndex: "provider", width: 90 },
          { title: "模型", dataIndex: "model", width: 240 },
          {
            title: "用途",
            dataIndex: "purpose",
            width: 90,
            render: (v: string) => (v === "test" ? <Tag>测试</Tag> : <Tag color="blue">找片段</Tag>),
          },
          {
            title: "任务",
            width: 100,
            render: (_: unknown, r: LlmCallRow) => (r.task_id != null ? `#${r.task_id}` : "—"),
          },
          { title: "输入 token", dataIndex: "input_tokens", width: 100, render: fmtN },
          { title: "输出 token", dataIndex: "output_tokens", width: 100, render: fmtN },
          { title: "花费", dataIndex: "est_usd", width: 90, render: (v: number) => `$${v.toFixed(4)}` },
          { title: "耗时", dataIndex: "latency_ms", width: 90, render: fmtMs },
          {
            title: "结果",
            render: (_: unknown, r: LlmCallRow) =>
              r.ok ? <Tag color="green">成功</Tag> : (
                <Tooltip title={r.error ?? ""}>
                  <Tag color="red">失败</Tag>
                  <span style={{ color: "#999", fontSize: 12 }}>{(r.error ?? "").slice(0, 60)}</span>
                </Tooltip>
              ),
          },
        ]}
      />
    </div>
  );
}
