import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Segmented, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import { rerunTrainReview, trainReview, type DatasetStats, type ReviewRow, type TrainReview } from "@/api/training";

/**
 * 训练记录的「数据 · 回放」：
 *   训练集   这次到底喂了什么——每类多少段 / 多少秒 / 多少窗、来自几个任务几天（多样性）、提示
 *   回放     训练完用这一版把训练集再预测一遍，按段比，列出对不上的：漏识别 / 误识别 / 混淆 /
 *            未标注区报事件。每行能直接开到工作台那一刻，看是标错了还是模型真不行
 *
 * 看错例的用法：先翻「漏识别」——人标了抓挠模型没认出来的。点开，画面里真是抓挠 → 模型的问题
 * （这类数据少或太单一）；画面里不是 → 标错了，当场改。改完点「重跑回放」看还剩多少。
 */

const pct = (x: number | null | undefined) => (x == null ? "-" : `${(x * 100).toFixed(0)}%`);
const sec = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(2)} 小时` : s >= 120 ? `${(s / 60).toFixed(1)} 分` : `${Math.round(s)} 秒`);
const KIND_COLOR: Record<string, string> = { 漏识别: "red", 误识别: "volcano", 混淆: "gold", 未标注区报事件: "blue" };
const KIND_TIP: Record<string, string> = {
  漏识别: "人标了事件类（抓挠/甩身体），模型没认出来。最值钱的一类：点开看画面，真是抓挠就是模型弱，不是就是标错",
  误识别: "模型说是事件类，人标的不是。多半是标注边界没对齐，或者人标漏了",
  混淆: "活动 ↔ 睡觉这类非事件类之间互认。常见于边界、过渡段",
  未标注区报事件: "没人标的时间里模型连着报事件类。要么是误报，要么这一段漏标了",
};

export default function TrainReviewModal({
  versionId, title, stats, review, modelDone, onClose, onRefresh,
}: {
  versionId: number | null;
  title: string;
  stats: DatasetStats | null;
  /** metrics.review（前几百条）；打开时会再拉全量 */
  review: TrainReview | null;
  modelDone: boolean;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const [full, setFull] = useState<TrainReview | null>(review);
  const [kind, setKind] = useState<string>("全部");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFull(review);
    setKind("全部");
    if (versionId != null && review) {
      setLoading(true);
      trainReview(versionId).then(setFull).catch(() => undefined).finally(() => setLoading(false));
    }
  }, [versionId, review]);

  const rows = useMemo(() => (full?.rows ?? []).filter((r) => kind === "全部" || r.kind === kind), [full, kind]);
  const kinds = Object.keys(KIND_COLOR);

  const statsTab = stats ? (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        归并之后真正进训练的类别。{stats.n_tasks} 个任务 · {stats.n_days} 个采集日 · 共 {sec(stats.total_seconds)} ≈ {stats.total_windows.toLocaleString()} 个窗口（{stats.window_s}s 窗 / {stats.stride_s}s 步）。
        「来自」是多样性：段再多，全来自一两天一只狗，模型学的就是那只狗那天。
      </Typography.Text>
      {stats.hints.map((h, i) => <Alert key={i} type="warning" showIcon message={h} style={{ padding: "4px 10px" }} />)}
      <Table
        size="small" rowKey="label" pagination={false} dataSource={stats.rows}
        columns={[
          { title: "类别", dataIndex: "label", render: (l: string) => <b>{l}</b> },
          { title: "段", dataIndex: "segments", width: 70 },
          { title: "时长", dataIndex: "seconds", width: 100, render: (s: number) => sec(s) },
          { title: "≈窗口", dataIndex: "windows", width: 90, render: (n: number) => n.toLocaleString() },
          {
            title: "占比", dataIndex: "share", width: 160,
            render: (x: number) => (
              <Space size={4}>
                <div style={{ width: 80, height: 8, background: "rgba(128,128,128,0.2)", borderRadius: 4 }}>
                  <div style={{ width: `${Math.round(x * 80)}px`, height: 8, background: x < 0.05 ? "#f5222d" : "#52c41a", borderRadius: 4 }} />
                </div>
                <span style={{ color: x < 0.05 ? "#f5222d" : undefined }}>{pct(x)}</span>
              </Space>
            ),
          },
          { title: <Tooltip title="这一类来自几个任务（样本）/ 几个采集日">来自</Tooltip>, width: 130, render: (_, r) => `${r.n_tasks} 任务 / ${r.n_days} 天` },
          { title: <Tooltip title="比一个窗口还短的段，切不出窗口，等于没进训练">短段</Tooltip>, dataIndex: "short_segments", width: 70, render: (n: number, r) => n ? <span style={{ color: n / r.segments > 0.3 ? "#f5222d" : undefined }}>{n}</span> : "0" },
        ]}
      />
      {stats.dropped.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          没进训练（归并表里没有）：{stats.dropped.map((d) => `${d.label} ${d.segments} 段 ${sec(d.seconds)}`).join("、")}
        </Typography.Text>
      )}
      {stats.per_day.length > 1 && (
        <Table
          size="small" rowKey="day" pagination={false} dataSource={stats.per_day} scroll={{ y: 220 }}
          columns={[
            { title: "采集日", dataIndex: "day", width: 110 },
            ...stats.rows.map((r) => ({ title: r.label, dataIndex: r.label, width: 90, render: (v?: number) => (v ? sec(v) : <span style={{ color: "#999" }}>—</span>) })),
          ]}
        />
      )}
    </Space>
  ) : (
    <Typography.Text type="secondary">这一版没有训练集统计（训练开始时算；老版本没有）。</Typography.Text>
  );

  const reviewTab = full ? (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      <Space wrap>
        <span>
          {full.n_tasks_ok}/{full.n_tasks} 个任务 · {full.n_segments} 段里 <b style={{ color: full.n_wrong ? "#f5222d" : "#52c41a" }}>{full.n_wrong}</b> 段对不上
          {full.n_rows_total > full.rows.length && <span style={{ color: "#999" }}>（只列前 {full.rows.length} 条）</span>}
        </span>
        {kinds.map((k) => (
          <Tooltip key={k} title={KIND_TIP[k]}>
            <Tag color={KIND_COLOR[k]} style={{ cursor: "help" }}>{k} {full.by_kind[k] ?? 0}</Tag>
          </Tooltip>
        ))}
        {modelDone && (
          <Button
            size="small"
            onClick={async () => {
              if (versionId == null) return;
              try {
                await rerunTrainReview(versionId);
                message.success("回放在后台重跑，几分钟后刷新列表再看");
                onRefresh?.();
              } catch (e) {
                message.error(String((e as Error)?.message ?? e));
              }
            }}
          >
            重跑回放
          </Button>
        )}
      </Space>
      {full.errors.length > 0 && <Alert type="warning" showIcon message={`${full.n_tasks_failed} 个任务没跑成：${full.errors.slice(0, 3).join("；")}`} />}
      <Table
        size="small" rowKey={(_, i) => String(i)} pagination={false}
        title={() => <Typography.Text type="secondary" style={{ fontSize: 12 }}>混淆矩阵（按段）：行 = 人标的，列 = 模型说的。对角线是认对的</Typography.Text>}
        dataSource={full.confusion.classes.map((c, i) => ({ cls: c, row: full.confusion.matrix[i], i }))}
        columns={[
          { title: "人标 \\ 模型", dataIndex: "cls", width: 110, render: (c: string) => <b>{c}</b> },
          ...full.confusion.classes.map((c, j) => ({
            title: c, width: 80, align: "center" as const,
            render: (_: unknown, r: { row: number[]; i: number }) => {
              const v = r.row[j];
              const total = r.row.reduce((a, b) => a + b, 0) || 1;
              const diag = r.i === j;
              return <span style={{ color: diag ? "#52c41a" : v ? "#f5222d" : "#999", fontWeight: diag ? 600 : 400 }}>{v}{v && !diag ? <small> ({pct(v / total)})</small> : ""}</span>;
            },
          })),
          { title: "召回", width: 70, render: (_, r: { cls: string }) => pct(full.per_class[r.cls]?.recall) },
        ]}
      />
      <Space>
        <Segmented value={kind} onChange={(v) => setKind(String(v))} options={["全部", ...kinds.filter((k) => (full.by_kind[k] ?? 0) > 0)]} />
        {loading && <Typography.Text type="secondary" style={{ fontSize: 12 }}>在拉全量…</Typography.Text>}
      </Space>
      <Table
        size="small" rowKey={(r) => `${r.task_id}-${r.start_ms}-${r.kind}`} dataSource={rows} scroll={{ y: 360 }}
        pagination={{ pageSize: 50, showSizeChanger: false, size: "small" }}
        columns={[
          { title: "类型", dataIndex: "kind", width: 110, render: (k: string) => <Tag color={KIND_COLOR[k]}>{k}</Tag> },
          { title: "任务", width: 150, render: (_, r: ReviewRow) => <span>#{r.task_id} <span style={{ color: "#888", fontSize: 12 }}>{r.sample_code ?? ""}</span></span> },
          { title: "采集日", dataIndex: "day", width: 100 },
          { title: "时间", width: 130, render: (_, r: ReviewRow) => `${(r.start_ms / 1000).toFixed(1)}s – ${(r.end_ms / 1000).toFixed(1)}s（${r.seconds}s）` },
          { title: "人标", dataIndex: "human", width: 80, render: (h: string | null) => h ?? <span style={{ color: "#999" }}>没标</span> },
          {
            title: "模型说", width: 170,
            render: (_, r: ReviewRow) => (
              <Tooltip title={`${r.n_windows} 个窗口投票：${Object.entries(r.votes).map(([k, v]) => `${k} ${v}`).join("，")}${r.p_human != null ? `；人标那一类的平均概率 ${r.p_human.toFixed(2)}` : ""}`}>
                <b>{r.pred}</b> <span style={{ color: "#888", fontSize: 12 }}>概率 {r.conf.toFixed(2)} · {r.n_windows} 窗</span>
              </Tooltip>
            ),
          },
          {
            title: "", width: 80,
            render: (_, r: ReviewRow) => (
              <a href={`/tasks?task=${r.task_id}&seek=${Math.max(0, r.start_ms)}`} target="_blank" rel="noreferrer">去看</a>
            ),
          },
        ]}
      />
      {full.note && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{full.note}</Typography.Text>}
    </Space>
  ) : (
    <Space direction="vertical">
      <Typography.Text type="secondary">
        {modelDone ? "这一版还没有回放结果。训练完会自动跑；老版本点下面重跑一次（几分钟）。" : "训练完才有。"}
      </Typography.Text>
      {modelDone && versionId != null && (
        <Button size="small" onClick={async () => { try { await rerunTrainReview(versionId); message.success("回放在后台跑，几分钟后刷新列表"); onRefresh?.(); } catch (e) { message.error(String((e as Error)?.message ?? e)); } }}>
          跑一次回放
        </Button>
      )}
    </Space>
  );

  return (
    <Modal title={title} open={versionId != null} onCancel={onClose} footer={null} width={980} destroyOnClose>
      <Tabs
        defaultActiveKey={review ? "review" : "stats"}
        items={[
          { key: "stats", label: "训练集", children: statsTab },
          { key: "review", label: `回放错例${full ? ` (${full.n_wrong})` : ""}`, children: reviewTab },
        ]}
      />
    </Modal>
  );
}
