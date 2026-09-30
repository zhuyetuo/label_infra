import { useMemo, useState } from "react";
import { Card, DatePicker, Progress, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  listAnnotatorWork,
  listProjectProgress,
  type AnnotatorWorkRow,
  type ProjectProgress,
} from "@/api/dashboard";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { useAuthStore } from "@/stores/authStore";

/**
 * 标注统计：每个标注员每天交了多少、判了多少候选、花了多久；每个项目（一天一个）
 * 的抓挠片段和疑似候选还剩多少没看完。
 *
 * 用来定每日任务量。两种工作量分开数：
 *   提交任务   一个任务的一轮提交算一条（驳回重标再交算第二条）
 *   判定候选   每判一条「疑似抓挠」算一次
 *
 * 「用时」是人第一次动手（加/改片段、判候选）到提交的时间差。中途去吃饭、下班
 * 第二天再交的会虚高，汇总时单条封顶 CAP_SEC，明细里照原样显示。
 */

const CAP_SEC = 3 * 3600;

const fmtMin = (sec: number) => {
  if (!sec) return "0";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
};
const fmtTime = (v: string | null | undefined, f = "MM-DD HH:mm") => (v ? dayjs(v).format(f) : "-");

const FILTER_KEY = "annotator-stats-range";

type HourRow = { user: string; hours: number[]; dec: number[]; total: number; totalDec: number };

export default function AnnotatorStats() {
  const role = useAuthStore((s) => s.userInfo?.role);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      if (raw) {
        const [a, b] = JSON.parse(raw) as [string, string];
        return [dayjs(a), dayjs(b)];
      }
    } catch {
      // 没存过
    }
    return [dayjs().subtract(6, "day"), dayjs()];
  });
  const [userId, setUserId] = useState<number | undefined>();
  const [day, setDay] = useState<string | null>(null);

  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const { data, isLoading } = useQuery({
    queryKey: ["annotator-work", from, to],
    queryFn: () => listAnnotatorWork(from, to),
  });
  const { data: progress = [] } = useQuery({
    queryKey: ["project-progress"],
    queryFn: listProjectProgress,
    refetchInterval: 60_000,
  });
  const subs = data?.submissions ?? [];
  const decisions = data?.candidate_decisions ?? [];

  const users = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of subs) if (r.user_id != null) m.set(r.user_id, r.user_name ?? String(r.user_id));
    for (const r of decisions) if (r.user_id != null) m.set(r.user_id, r.user_name ?? String(r.user_id));
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [subs, decisions]);

  const shown = useMemo(() => subs.filter((r) => !userId || r.user_id === userId), [subs, userId]);
  const shownDec = useMemo(() => decisions.filter((r) => !userId || r.user_id === userId), [decisions, userId]);

  // 标注员 × 天 的汇总（提交按提交时间归天，候选按判定时间归天）
  const daily = useMemo(() => {
    type Row = {
      key: string; day: string; user: string; tasks: number; items: number; scratch: number;
      decisions: number; video: number; work: number; first: string | null; last: string | null;
    };
    const m = new Map<string, Row>();
    const get = (d: string, user: string): Row => {
      const key = `${d}|${user}`;
      let cur = m.get(key);
      if (!cur) {
        cur = { key, day: d, user, tasks: 0, items: 0, scratch: 0, decisions: 0, video: 0, work: 0, first: null, last: null };
        m.set(key, cur);
      }
      return cur;
    };
    for (const r of shown) {
      if (!r.submitted_at) continue;
      const cur = get(r.submitted_at.slice(0, 10), r.user_name ?? "（未指派）");
      cur.tasks += 1;
      cur.items += r.item_count;
      cur.scratch += r.scratch_items;
      cur.video += r.video_duration_sec ?? 0;
      cur.work += Math.min(r.work_seconds ?? 0, CAP_SEC);
      if (!cur.first || r.submitted_at < cur.first) cur.first = r.submitted_at;
      if (!cur.last || r.submitted_at > cur.last) cur.last = r.submitted_at;
    }
    for (const r of shownDec) {
      if (!r.decided_at) continue;
      const cur = get(r.decided_at.slice(0, 10), r.user_name ?? "（未知）");
      cur.decisions += 1;
      if (!cur.first || r.decided_at < cur.first) cur.first = r.decided_at;
      if (!cur.last || r.decided_at > cur.last) cur.last = r.decided_at;
    }
    return [...m.values()].sort((a, b) => b.day.localeCompare(a.day) || a.user.localeCompare(b.user));
  }, [shown, shownDec]);

  // 选中的那一天，每小时交了几个任务 / 判了几条候选（按标注员分行）
  const hourly = useMemo(() => {
    const d = day ?? daily[0]?.day;
    if (!d) return { day: null as string | null, rows: [] as HourRow[] };
    const m = new Map<string, { hours: number[]; dec: number[] }>();
    const get = (user: string) => {
      let cur = m.get(user);
      if (!cur) {
        cur = { hours: new Array<number>(24).fill(0), dec: new Array<number>(24).fill(0) };
        m.set(user, cur);
      }
      return cur;
    };
    for (const r of shown) {
      if (!r.submitted_at?.startsWith(d)) continue;
      get(r.user_name ?? "（未指派）").hours[Number(r.submitted_at.slice(11, 13))] += 1;
    }
    for (const r of shownDec) {
      if (!r.decided_at?.startsWith(d)) continue;
      get(r.user_name ?? "（未知）").dec[Number(r.decided_at.slice(11, 13))] += 1;
    }
    return {
      day: d,
      rows: [...m.entries()].map(([user, v]) => ({
        user, hours: v.hours, dec: v.dec,
        total: v.hours.reduce((a, b) => a + b, 0), totalDec: v.dec.reduce((a, b) => a + b, 0),
      })),
    };
  }, [shown, shownDec, day, daily]);

  const days = useMemo(() => [...new Set(daily.map((d) => d.day))], [daily]);
  const hourMax = Math.max(1, ...hourly.rows.flatMap((r) => r.hours), ...hourly.rows.flatMap((r) => r.dec));

  const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 100);

  return (
    <div>
      <Card
        size="small"
        title="各项目完成情况"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>只看启用中的项目；每分钟刷新。要求是每天把抓挠片段确认完、疑似抓挠判完</Typography.Text>}
        style={{ marginBottom: 12 }}
      >
        <Table
          rowKey="project_id"
          size="small"
          dataSource={progress}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            { title: "项目", dataIndex: "project_name", width: 180 },
            {
              title: "任务提交",
              width: 220,
              sorter: (a: ProjectProgress, b: ProjectProgress) => pct(a.tasks_submitted, a.tasks_total) - pct(b.tasks_submitted, b.tasks_total),
              render: (_: unknown, p: ProjectProgress) => (
                <Tooltip title={`已提交 ${p.tasks_submitted} / ${p.tasks_total}（其中审核通过 ${p.tasks_approved}）`}>
                  <Progress percent={pct(p.tasks_submitted, p.tasks_total)} size="small" format={() => `${p.tasks_submitted}/${p.tasks_total}`} />
                </Tooltip>
              ),
            },
            {
              title: <Tooltip title="抓挠类片段里，AI 给的且人还没确认/改过的还剩几段">抓挠片段确认</Tooltip>,
              width: 220,
              sorter: (a: ProjectProgress, b: ProjectProgress) => a.scratch_pending - b.scratch_pending,
              render: (_: unknown, p: ProjectProgress) => (
                <Tooltip title={`还剩 ${p.scratch_pending} 段没确认，共 ${p.scratch_total} 段`}>
                  <Progress
                    percent={pct(p.scratch_total - p.scratch_pending, p.scratch_total)}
                    size="small"
                    status={p.scratch_pending ? "active" : "success"}
                    format={() => (p.scratch_pending ? `剩 ${p.scratch_pending}` : `${p.scratch_total} 段 ✓`)}
                  />
                </Tooltip>
              ),
            },
            {
              title: <Tooltip title="「疑似抓挠」候选还剩几条没判">疑似抓挠判定</Tooltip>,
              width: 220,
              sorter: (a: ProjectProgress, b: ProjectProgress) => a.cand_pending - b.cand_pending,
              render: (_: unknown, p: ProjectProgress) =>
                p.cand_total ? (
                  <Tooltip title={`还剩 ${p.cand_pending} 条没判，共 ${p.cand_total} 条`}>
                    <Progress
                      percent={pct(p.cand_total - p.cand_pending, p.cand_total)}
                      size="small"
                      status={p.cand_pending ? "active" : "success"}
                      format={() => (p.cand_pending ? `剩 ${p.cand_pending}` : `${p.cand_total} 条 ✓`)}
                    />
                  </Tooltip>
                ) : (
                  <Typography.Text type="secondary">无候选</Typography.Text>
                ),
            },
          ]}
        />
      </Card>

      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>日期</Typography.Text>
        <DatePicker.RangePicker
          value={range}
          allowClear={false}
          onChange={(v) => {
            if (!v || !v[0] || !v[1]) return;
            setRange([v[0], v[1]]);
            try {
              localStorage.setItem(FILTER_KEY, JSON.stringify([v[0].format("YYYY-MM-DD"), v[1].format("YYYY-MM-DD")]));
            } catch {
              // 存不下不影响
            }
          }}
        />
        <Typography.Text>标注员</Typography.Text>
        <Select allowClear placeholder="全部" style={{ minWidth: 140 }} options={users} value={userId} onChange={setUserId} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提交任务：一个任务的一轮提交算一条；判定候选：每判一条「疑似抓挠」算一次。
        </Typography.Text>
      </Space>

      <Card size="small" title="每人每天" style={{ marginBottom: 12 }}>
        <Table
          rowKey="key"
          size="small"
          loading={isLoading}
          dataSource={daily}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => setDay(r.day), style: { cursor: "pointer" } })}
          rowClassName={(r) => (r.day === (day ?? daily[0]?.day) ? "ant-table-row-selected" : "")}
          columns={[
            { title: "日期", dataIndex: "day", width: 110 },
            { title: "标注员", dataIndex: "user", width: 120 },
            { title: "提交任务", dataIndex: "tasks", width: 90, sorter: (a, b) => a.tasks - b.tasks },
            { title: "片段", dataIndex: "items", width: 70 },
            { title: <Tooltip title="交掉的任务里抓挠类片段合计">抓挠片段</Tooltip>, dataIndex: "scratch", width: 90 },
            { title: <Tooltip title="判掉的「疑似抓挠」条数">判定候选</Tooltip>, dataIndex: "decisions", width: 90, sorter: (a, b) => a.decisions - b.decisions },
            {
              title: <Tooltip title="交掉的这些任务对应的视频总时长">视频时长</Tooltip>,
              dataIndex: "video", width: 110, render: (s: number) => formatDuration(s),
            },
            {
              title: <Tooltip title={`每条从人第一次动手到提交的时间之和，单条封顶 ${CAP_SEC / 3600} 小时`}>工作用时</Tooltip>,
              dataIndex: "work", width: 120, render: (s: number) => fmtMin(s),
            },
            {
              title: "平均每任务",
              width: 100,
              render: (_, r) => (r.tasks ? `${(r.work / r.tasks / 60).toFixed(1)} 分` : "-"),
            },
            { title: "首次", dataIndex: "first", width: 70, render: (v: string | null) => fmtTime(v, "HH:mm") },
            { title: "末次", dataIndex: "last", width: 70, render: (v: string | null) => fmtTime(v, "HH:mm") },
          ]}
        />
      </Card>

      <Card
        size="small"
        title={
          <Space>
            按小时
            <Select size="small" style={{ minWidth: 130 }} value={hourly.day ?? undefined} options={days.map((d) => ({ value: d, label: d }))} onChange={setDay} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              每格：这一小时交了几个任务 / 判了几条候选（点上面表格的行也能切换日期）
            </Typography.Text>
          </Space>
        }
        style={{ marginBottom: 12 }}
      >
        <Table
          rowKey="user"
          size="small"
          dataSource={hourly.rows}
          pagination={false}
          scroll={{ x: true }}
          columns={[
            { title: "标注员", dataIndex: "user", width: 110, fixed: "left" as const },
            ...Array.from({ length: 24 }, (_, h) => ({
              title: String(h).padStart(2, "0"),
              width: 54,
              align: "center" as const,
              render: (_: unknown, r: HourRow) => {
                const n = r.hours[h];
                const d = r.dec[h];
                if (!n && !d) return <span style={{ color: "#555" }}>·</span>;
                const alpha = 0.25 + 0.75 * (Math.max(n, d) / hourMax);
                return (
                  <div style={{ background: `rgba(114, 46, 209, ${alpha})`, borderRadius: 3, padding: "0 2px", whiteSpace: "nowrap" }}>
                    {n || ""}{n && d ? "/" : ""}{d ? <span style={{ color: "#ffd666" }}>{d}</span> : ""}
                  </div>
                );
              },
            })),
            {
              title: "合计",
              width: 90,
              align: "center" as const,
              render: (_: unknown, r: HourRow) => (
                <span>{r.total}{r.totalDec ? <span style={{ color: "#ffd666" }}> / {r.totalDec}</span> : null}</span>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="提交明细">
        <Table
          rowKey={(r) => `${r.task_id}-${r.round_no}`}
          size="small"
          loading={isLoading}
          dataSource={[...shown].reverse()}
          pagination={{ pageSize: 50, showSizeChanger: true }}
          columns={[
            { title: "提交时间", dataIndex: "submitted_at", width: 130, render: (v: string | null) => fmtTime(v, "MM-DD HH:mm:ss") },
            { title: "标注员", dataIndex: "user_name", width: 110, render: (v: string | null) => v ?? "-" },
            { title: "项目", dataIndex: "project_name", width: 140 },
            { title: "任务", dataIndex: "task_id", width: 80 },
            {
              title: "样本",
              render: (_, r: AnnotatorWorkRow) =>
                r.sample_code ? sampleDisplayName(r.sample_code, r.video_duration_sec, role) : "-",
            },
            { title: "轮次", dataIndex: "round_no", width: 60 },
            { title: "片段", dataIndex: "item_count", width: 60 },
            {
              title: "抓挠",
              width: 100,
              render: (_, r: AnnotatorWorkRow) =>
                r.scratch_items ? (
                  <span>
                    <Tag color="red" style={{ marginInlineEnd: 4 }}>{r.scratch_items}</Tag>
                    {r.scratch_pending ? <span style={{ color: "#faad14" }}>待确认 {r.scratch_pending}</span> : null}
                  </span>
                ) : "-",
            },
            {
              title: "疑似",
              width: 80,
              render: (_, r: AnnotatorWorkRow) => (r.cand_total ? `${r.cand_pending} / ${r.cand_total}` : "-"),
            },
            { title: "开始", dataIndex: "started_at", width: 110, render: (v: string | null) => fmtTime(v) },
            {
              title: "用时",
              dataIndex: "work_seconds",
              width: 90,
              render: (s: number | null) => (s == null ? "-" : s < 60 ? `${s} 秒` : fmtMin(s)),
            },
            { title: "状态", dataIndex: "status", width: 120 },
          ]}
        />
      </Card>
    </div>
  );
}
