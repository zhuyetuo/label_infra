import { useMemo, useState } from "react";
import { Button, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { BarChartOutlined, CheckOutlined, RetweetOutlined, WarningOutlined } from "@ant-design/icons";
import type { LabelDefinition, LabelItem } from "@/types";

// 已标注片段列表：筛选、统计、AI 片段的人工确认/纠正都在这里。
// 标注和审核共用（审核 readOnly，只能看不能改）。

type SourceFilter = "all" | "ai" | "ai_pending" | "ai_confirmed" | "ai_modified" | "human";

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "全部来源" },
  { value: "ai", label: "AI 全部" },
  { value: "ai_pending", label: "AI 待确认" },
  { value: "ai_confirmed", label: "AI 已确认" },
  { value: "ai_modified", label: "AI 已纠正" },
  { value: "human", label: "人工" },
];

// 比这个短的空白不算"漏预测"（模型按窗口出结果，窗口边界处零点几秒的缝很正常）
const GAP_MIN_MS = 500;

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

const fmtDur = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1000).toFixed(2)}s`);

const isAi = (i: LabelItem) => i.source_type === "ai_generated";
const aiState = (i: LabelItem): "pending" | "confirmed" | "modified" | null =>
  !isAi(i) ? null : i.is_modified ? "modified" : i.ai_confirmed ? "confirmed" : "pending";

function confColor(c: number): string {
  if (c >= 0.8) return "green";
  if (c >= 0.6) return "orange";
  return "red";
}

/** 合并区间算覆盖率和空白段，用来回答"整段都预测到了吗，漏了哪里" */
function coverage(items: LabelItem[], durationMs: number | null) {
  const sorted = items
    .map((i) => [Math.max(0, i.start_time_ms), i.end_time_ms] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const covered = merged.reduce((acc, [s, e]) => acc + (e - s), 0);
  const gaps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s - cursor >= GAP_MIN_MS) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (durationMs != null && durationMs - cursor >= GAP_MIN_MS) gaps.push({ start: cursor, end: durationMs });
  return { covered, gaps };
}

interface Props {
  items: LabelItem[];
  labels: LabelDefinition[];
  readOnly?: boolean;
  /** IMU 总时长，算覆盖率用；没有 CSV 时为 null */
  durationMs: number | null;
  colorOf: (labelId: number) => string;
  nameOf: (labelId: number) => string;
  onSeek: (ms: number) => void;
  /** 区间循环播放某段（反复看起止对不对）；传 null 停止。当前循环的区间用 loopRange 传回来高亮 */
  onLoop?: (range: { startMs: number; endMs: number } | null) => void;
  loopRange?: { startMs: number; endMs: number } | null;
  /** 改类别/起止/确认状态。改类别或起止时调用方负责把 AI 片段标成"已纠正"并清掉确认 */
  onUpdate: (ids: number[], patch: Partial<Pick<LabelItem, "label_id" | "start_time_ms" | "end_time_ms" | "ai_confirmed">>) => void;
  onDelete: (id: number) => void;
  /** 在"未预测片段"视图里给一段空白补上标签，直接生成一条人工片段 */
  onCreate?: (startMs: number, endMs: number, labelId: number) => void;
}

export default function SegmentPanel({
  items,
  labels,
  readOnly,
  durationMs,
  colorOf,
  nameOf,
  onSeek,
  onLoop,
  loopRange,
  onUpdate,
  onDelete,
  onCreate,
}: Props) {
  const isLooping = (startMs: number, endMs: number) =>
    loopRange != null && loopRange.startMs === startMs && loopRange.endMs === endMs;
  // 每行的"循环"按钮：正在循环这一段时变成"停止"
  const loopButton = (startMs: number, endMs: number) =>
    onLoop ? (
      isLooping(startMs, endMs) ? (
        <Button size="small" type="link" danger icon={<RetweetOutlined />} onClick={() => onLoop(null)}>
          停止
        </Button>
      ) : (
        <Tooltip title="只循环播放这一段，反复看起止对不对">
          <Button size="small" type="link" icon={<RetweetOutlined />} onClick={() => onLoop({ startMs, endMs })}>
            循环
          </Button>
        </Tooltip>
      )
    ) : null;
  const [filterLabels, setFilterLabels] = useState<number[]>([]);
  // "未预测片段"不是模型的类别，单独一个视图：打开后表格列的是空白段而不是标注
  const [viewGaps, setViewGaps] = useState(false);
  const [filterSource, setFilterSource] = useState<SourceFilter>("all");
  const [minConf, setMinConf] = useState<number | null>(null);
  const [maxConf, setMaxConf] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [editing, setEditing] = useState<LabelItem | null>(null);
  const [editStart, setEditStart] = useState(0);
  const [editEnd, setEditEnd] = useState(0);

  const sorted = useMemo(() => [...items].sort((a, b) => a.start_time_ms - b.start_time_ms), [items]);

  const filtered = useMemo(
    () =>
      sorted.filter((i) => {
        if (filterLabels.length && !filterLabels.includes(i.label_id)) return false;
        const st = aiState(i);
        if (filterSource === "ai" && !st) return false;
        if (filterSource === "human" && st) return false;
        if (filterSource === "ai_pending" && st !== "pending") return false;
        if (filterSource === "ai_confirmed" && st !== "confirmed") return false;
        if (filterSource === "ai_modified" && st !== "modified") return false;
        if (minConf != null && (i.ai_confidence == null || i.ai_confidence * 100 < minConf)) return false;
        if (maxConf != null && (i.ai_confidence == null || i.ai_confidence * 100 > maxConf)) return false;
        return true;
      }),
    [sorted, filterLabels, filterSource, minConf, maxConf]
  );

  // 按类别统计：数量、总时长、置信度范围、待确认/已确认/已纠正/人工各多少
  const stats = useMemo(() => {
    const by = new Map<
      number,
      { label_id: number; count: number; totalMs: number; confs: number[]; pending: number; confirmed: number; modified: number; human: number }
    >();
    for (const i of items) {
      let s = by.get(i.label_id);
      if (!s) {
        s = { label_id: i.label_id, count: 0, totalMs: 0, confs: [], pending: 0, confirmed: 0, modified: 0, human: 0 };
        by.set(i.label_id, s);
      }
      s.count += 1;
      s.totalMs += Math.max(0, i.end_time_ms - i.start_time_ms);
      if (i.ai_confidence != null) s.confs.push(i.ai_confidence);
      const st = aiState(i);
      if (st === "pending") s.pending += 1;
      else if (st === "confirmed") s.confirmed += 1;
      else if (st === "modified") s.modified += 1;
      else s.human += 1;
    }
    return [...by.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const cov = useMemo(() => coverage(items, durationMs), [items, durationMs]);
  const pendingTotal = items.filter((i) => aiState(i) === "pending").length;
  const pendingInView = filtered.filter((i) => aiState(i) === "pending");

  const openEditor = (i: LabelItem) => {
    setEditing(i);
    setEditStart(i.start_time_ms / 1000);
    setEditEnd(i.end_time_ms / 1000);
  };

  const applyEditor = () => {
    if (!editing) return;
    const s = Math.round(editStart * 1000);
    const e = Math.round(editEnd * 1000);
    if (e <= s) return;
    onUpdate([editing.id], { start_time_ms: s, end_time_ms: e });
    setEditing(null);
  };

  // 改类别/补标用：项目下全部标签
  const labelOptions = labels.map((l) => ({
    value: l.id,
    label: <Tag color={l.color || colorOf(l.id)} style={{ marginRight: 0 }}>{l.display_name}</Tag>,
  }));
  // 筛选用：只列当前片段里实际出现过的类别（带数量），项目里配了但一段都没有的不出现
  const usedCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of items) m.set(i.label_id, (m.get(i.label_id) ?? 0) + 1);
    return m;
  }, [items]);
  const filterLabelOptions = labels
    .filter((l) => usedCounts.has(l.id))
    .map((l) => ({
      value: l.id,
      label: (
        <span>
          <Tag color={l.color || colorOf(l.id)} style={{ marginRight: 4 }}>{l.display_name}</Tag>
          <span style={{ fontSize: 12, color: "#999" }}>{usedCounts.get(l.id)}</span>
        </span>
      ),
    }));

  return (
    <div>
      <Space wrap size={8} style={{ marginBottom: 8 }}>
        <Select
          mode="multiple"
          allowClear
          size="small"
          placeholder="全部类别"
          style={{ minWidth: 160 }}
          maxTagCount="responsive"
          value={filterLabels}
          onChange={setFilterLabels}
          options={filterLabelOptions}
          optionFilterProp="value"
        />
        <Select size="small" style={{ width: 120 }} value={filterSource} onChange={setFilterSource} options={SOURCE_OPTIONS} />
        <Space size={4}>
          <span style={{ fontSize: 12, color: "#666" }}>置信度</span>
          <InputNumber size="small" min={0} max={100} placeholder="最低%" style={{ width: 80 }} value={minConf} onChange={setMinConf} />
          <span style={{ color: "#999" }}>~</span>
          <InputNumber size="small" min={0} max={100} placeholder="最高%" style={{ width: 80 }} value={maxConf} onChange={setMaxConf} />
        </Space>
        <Button size="small" icon={<BarChartOutlined />} type={showStats ? "primary" : "default"} onClick={() => setShowStats((v) => !v)}>
          统计
        </Button>
        {cov.gaps.length > 0 && (
          <Tooltip title={`还有 ${cov.gaps.length} 段 ≥${GAP_MIN_MS / 1000}s 的时间既没有 AI 预测也没有人工标注，点开单独查看`}>
            <Button
              size="small"
              icon={<WarningOutlined />}
              type={viewGaps ? "primary" : "default"}
              danger={!viewGaps}
              onClick={() => setViewGaps((v) => !v)}
            >
              未预测片段 {cov.gaps.length}
            </Button>
          </Tooltip>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {viewGaps ? (
            <>未预测空白 {cov.gaps.length} 段，合计 {fmtDur(cov.gaps.reduce((a, g) => a + (g.end - g.start), 0))}</>
          ) : (
            <>
              显示 {filtered.length} / 共 {items.length}
              {pendingTotal > 0 && <>，AI 待确认 {pendingTotal}</>}
            </>
          )}
        </Typography.Text>
        {!readOnly && pendingInView.length > 0 && (
          <Popconfirm
            title={`把当前筛出来的 ${pendingInView.length} 段 AI 预测全部标为"确认正确"？`}
            onConfirm={() => onUpdate(pendingInView.map((i) => i.id), { ai_confirmed: true })}
          >
            <Button size="small" icon={<CheckOutlined />}>
              当前筛选全部通过
            </Button>
          </Popconfirm>
        )}
      </Space>

      {showStats && (
        <div style={{ marginBottom: 8, padding: 8, background: "#fafafa", borderRadius: 4 }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            覆盖：{fmtDur(cov.covered)}
            {durationMs != null && durationMs > 0 && (
              <>
                {" / "}
                {fmtDur(durationMs)}（{((cov.covered / durationMs) * 100).toFixed(1)}%）
              </>
            )}
            {cov.gaps.length > 0 ? (
              <>
                ，未预测空白 {cov.gaps.length} 段（≥{GAP_MIN_MS / 1000}s），
                <a onClick={() => setViewGaps(true)}>查看</a>
              </>
            ) : (
              <>，没有 ≥{GAP_MIN_MS / 1000}s 的未预测空白</>
            )}
          </div>
          <Table
            size="small"
            rowKey="label_id"
            pagination={false}
            dataSource={stats}
            onRow={(s) => ({
              style: { cursor: "pointer" },
              onClick: () => setFilterLabels((prev) => (prev.length === 1 && prev[0] === s.label_id ? [] : [s.label_id])),
            })}
            columns={[
              { title: "类别", render: (_, s) => <Tag color={colorOf(s.label_id)}>{nameOf(s.label_id)}</Tag> },
              { title: "片段数", dataIndex: "count", width: 80 },
              { title: "总时长", render: (_, s) => fmtDur(s.totalMs), width: 100 },
              {
                title: "置信度 均值 / 最低",
                width: 150,
                render: (_, s) =>
                  s.confs.length
                    ? `${((s.confs.reduce((a, b) => a + b, 0) / s.confs.length) * 100).toFixed(0)}% / ${(Math.min(...s.confs) * 100).toFixed(0)}%`
                    : "—",
              },
              { title: "待确认", dataIndex: "pending", width: 80, render: (v: number) => (v ? <span style={{ color: "#fa8c16" }}>{v}</span> : 0) },
              { title: "已确认", dataIndex: "confirmed", width: 80 },
              { title: "已纠正", dataIndex: "modified", width: 80 },
              { title: "人工", dataIndex: "human", width: 70 },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            点某一行只看该类别，再点一次取消
          </Typography.Text>
        </div>
      )}

      {viewGaps ? (
        <Table
          size="small"
          rowKey="start"
          dataSource={cov.gaps}
          pagination={false}
          virtual
          scroll={{ x: 700, y: 220 }}
          locale={{ emptyText: "没有未预测的空白段" }}
          columns={[
            { title: "开始", width: 130, render: (_, g) => formatMs(g.start) },
            { title: "结束", width: 130, render: (_, g) => formatMs(g.end) },
            {
              title: "时长",
              width: 100,
              defaultSortOrder: "descend",
              sorter: (a, b) => a.end - a.start - (b.end - b.start),
              render: (_, g) => fmtDur(g.end - g.start),
            },
            {
              title: "操作",
              render: (_, g) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => onSeek(g.start)}>
                    跳转
                  </Button>
                  {loopButton(g.start, g.end)}
                  {!readOnly && onCreate && (
                    <Select<number | null>
                      size="small"
                      placeholder="补标为…"
                      style={{ width: 130 }}
                      value={null}
                      options={labelOptions}
                      onChange={(v) => v != null && onCreate(g.start, g.end, v)}
                    />
                  )}
                </Space>
              ),
            },
          ]}
        />
      ) : (
      <Table
        size="small"
        rowKey="id"
        dataSource={filtered}
        pagination={false}
        // 上千行时只渲染可视区那十来行（每行还带一个 Select），否则整页都跟着卡
        virtual
        scroll={{ x: 900, y: 220 }}
        locale={{ emptyText: items.length ? "没有符合筛选条件的片段" : "还没有标注片段" }}
        rowClassName={(i) => (aiState(i) === "pending" ? "seg-row--pending" : "")}
        columns={[
          {
            title: "标签",
            width: 150,
            render: (_, i: LabelItem) =>
              readOnly ? (
                <Tag color={colorOf(i.label_id)}>{nameOf(i.label_id)}</Tag>
              ) : (
                <Select
                  size="small"
                  variant="borderless"
                  value={i.label_id}
                  style={{ width: 140 }}
                  options={labelOptions}
                  onChange={(v) => onUpdate([i.id], { label_id: v })}
                  title="改类别"
                />
              ),
          },
          {
            title: "开始",
            width: 120,
            render: (_, i: LabelItem) =>
              readOnly ? formatMs(i.start_time_ms) : (
                <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openEditor(i)} title="改起止时间">
                  {formatMs(i.start_time_ms)}
                </Button>
              ),
          },
          {
            title: "结束",
            width: 120,
            render: (_, i: LabelItem) =>
              readOnly ? formatMs(i.end_time_ms) : (
                <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openEditor(i)} title="改起止时间">
                  {formatMs(i.end_time_ms)}
                </Button>
              ),
          },
          {
            title: "时长",
            width: 80,
            render: (_, i: LabelItem) => `${((i.end_time_ms - i.start_time_ms) / 1000).toFixed(2)}s`,
          },
          {
            title: "置信度",
            width: 90,
            sorter: (a: LabelItem, b: LabelItem) => (a.ai_confidence ?? -1) - (b.ai_confidence ?? -1),
            render: (_, i: LabelItem) =>
              i.ai_confidence == null ? (
                <span style={{ color: "#bbb" }}>—</span>
              ) : (
                <Tag color={confColor(i.ai_confidence)} style={{ marginRight: 0 }}>
                  {(i.ai_confidence * 100).toFixed(0)}%
                </Tag>
              ),
          },
          {
            title: "来源",
            width: 100,
            render: (_, i: LabelItem) => {
              const st = aiState(i);
              if (st === "pending") return <Tag color="orange">AI 待确认</Tag>;
              if (st === "confirmed") return <Tag color="green">AI 已确认</Tag>;
              if (st === "modified") return <Tag color="blue">AI 已纠正</Tag>;
              return <Tag>人工</Tag>;
            },
          },
          {
            title: "操作",
            width: 230,
            render: (_, i: LabelItem) => {
              const st = aiState(i);
              return (
                <Space size={0}>
                  <Button size="small" type="link" onClick={() => onSeek(i.start_time_ms)}>
                    跳转
                  </Button>
                  {loopButton(i.start_time_ms, i.end_time_ms)}
                  {!readOnly && st === "pending" && (
                    <Tooltip title="AI 预测正确，确认通过">
                      <Button size="small" type="link" icon={<CheckOutlined />} onClick={() => onUpdate([i.id], { ai_confirmed: true })}>
                        通过
                      </Button>
                    </Tooltip>
                  )}
                  {!readOnly && st === "confirmed" && (
                    <Button size="small" type="link" style={{ color: "#999" }} onClick={() => onUpdate([i.id], { ai_confirmed: false })}>
                      撤销
                    </Button>
                  )}
                  {!readOnly && (
                    <Button size="small" danger type="link" onClick={() => onDelete(i.id)}>
                      删除
                    </Button>
                  )}
                </Space>
              );
            },
          },
        ]}
      />

      )}

      <Modal
        title="调整起止时间"
        open={editing != null}
        onCancel={() => setEditing(null)}
        onOk={applyEditor}
        okButtonProps={{ disabled: editEnd <= editStart }}
        width={420}
        destroyOnClose
      >
        {editing && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              <Tag color={colorOf(editing.label_id)}>{nameOf(editing.label_id)}</Tag>
              单位：秒（相对 IMU 起点），也可以直接在波形上拖色块的左右边缘。
            </Typography.Text>
            <Space>
              <span style={{ width: 36, display: "inline-block" }}>开始</span>
              <InputNumber
                min={0}
                max={durationMs != null ? durationMs / 1000 : undefined}
                step={0.1}
                precision={3}
                value={editStart}
                onChange={(v) => setEditStart(v ?? 0)}
                style={{ width: 140 }}
              />
              <span style={{ color: "#999" }}>{formatMs(editStart * 1000)}</span>
              <Button size="small" type="link" onClick={() => onSeek(editStart * 1000)}>
                跳到这里
              </Button>
            </Space>
            <Space>
              <span style={{ width: 36, display: "inline-block" }}>结束</span>
              <InputNumber
                min={0}
                max={durationMs != null ? durationMs / 1000 : undefined}
                step={0.1}
                precision={3}
                value={editEnd}
                onChange={(v) => setEditEnd(v ?? 0)}
                style={{ width: 140 }}
              />
              <span style={{ color: "#999" }}>{formatMs(editEnd * 1000)}</span>
              <Button size="small" type="link" onClick={() => onSeek(editEnd * 1000)}>
                跳到这里
              </Button>
            </Space>
            {editEnd <= editStart && <Typography.Text type="danger">结束必须晚于开始</Typography.Text>}
          </Space>
        )}
      </Modal>
    </div>
  );
}
