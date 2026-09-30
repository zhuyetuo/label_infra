import { useMemo, useState } from "react";
import { Card, DatePicker, Select, Space, Table, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { listAnnotatorWork, type AnnotatorWorkRow } from "@/api/dashboard";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { useAuthStore } from "@/stores/authStore";

/**
 * 标注统计：每个标注员每天交了多少、花了多久，按小时看一天里的节奏。
 *
 * 用来定每日任务量。数据是「每一轮提交」——驳回重标的第二轮也算一条工作量。
 *
 * 「用时」是这一轮第一次保存草稿到提交的时间差。中途去吃饭、下班第二天再交的会
 * 虚高，所以汇总时单条封顶 CAP_SEC，明细里照原样显示。
 */

const CAP_SEC = 3 * 3600;

const fmtMin = (sec: number) => {
  if (!sec) return "0";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
};

const FILTER_KEY = "annotator-stats-range";

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
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["annotator-work", from, to],
    queryFn: () => listAnnotatorWork(from, to),
  });

  const users = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) if (r.user_id != null) m.set(r.user_id, r.user_name ?? String(r.user_id));
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [rows]);

  const shown = useMemo(() => rows.filter((r) => !userId || r.user_id === userId), [rows, userId]);

  // 标注员 × 天 的汇总
  const daily = useMemo(() => {
    const m = new Map<string, {
      key: string; day: string; user: string; tasks: number; items: number;
      video: number; work: number; first: string; last: string;
    }>();
    for (const r of shown) {
      if (!r.submitted_at) continue;
      const d = r.submitted_at.slice(0, 10);
      const user = r.user_name ?? "（未指派）";
      const key = `${d}|${user}`;
      const cur = m.get(key) ?? { key, day: d, user, tasks: 0, items: 0, video: 0, work: 0, first: r.submitted_at, last: r.submitted_at };
      cur.tasks += 1;
      cur.items += r.item_count;
      cur.video += r.video_duration_sec ?? 0;
      cur.work += Math.min(r.work_seconds ?? 0, CAP_SEC);
      if (r.submitted_at < cur.first) cur.first = r.submitted_at;
      if (r.submitted_at > cur.last) cur.last = r.submitted_at;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.day.localeCompare(a.day) || a.user.localeCompare(b.user));
  }, [shown]);

  // 选中的那一天，每小时交了几个（按标注员分行）
  const hourly = useMemo(() => {
    const d = day ?? daily[0]?.day;
    if (!d) return { day: null as string | null, rows: [] as { user: string; hours: number[]; total: number }[] };
    const m = new Map<string, number[]>();
    for (const r of shown) {
      if (!r.submitted_at?.startsWith(d)) continue;
      const user = r.user_name ?? "（未指派）";
      const arr = m.get(user) ?? new Array<number>(24).fill(0);
      arr[Number(r.submitted_at.slice(11, 13))] += 1;
      m.set(user, arr);
    }
    return {
      day: d,
      rows: [...m.entries()].map(([user, hours]) => ({ user, hours, total: hours.reduce((a, b) => a + b, 0) })),
    };
  }, [shown, day, daily]);

  const days = useMemo(() => [...new Set(daily.map((d) => d.day))], [daily]);
  const hourMax = Math.max(1, ...hourly.rows.flatMap((r) => r.hours));

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>提交日期</Typography.Text>
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
          一条 = 一个任务的一轮提交；驳回后重标再交算第二条。
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
            { title: "片段", dataIndex: "items", width: 80, sorter: (a, b) => a.items - b.items },
            {
              title: <Tooltip title="交掉的这些任务对应的视频总时长">标注的视频时长</Tooltip>,
              dataIndex: "video", width: 130, render: (s: number) => formatDuration(s),
            },
            {
              title: <Tooltip title={`每条从第一次保存草稿到提交的时间之和，单条封顶 ${CAP_SEC / 3600} 小时`}>工作用时</Tooltip>,
              dataIndex: "work", width: 120, render: (s: number) => fmtMin(s),
            },
            {
              title: "平均每任务",
              width: 100,
              render: (_, r) => (r.tasks ? `${(r.work / r.tasks / 60).toFixed(1)} 分` : "-"),
            },
            {
              title: <Tooltip title="每小时视频要花多少分钟标（工作用时 ÷ 视频时长）">每小时视频用时</Tooltip>,
              width: 130,
              render: (_, r) => (r.video ? `${((r.work / r.video) * 60).toFixed(1)} 分` : "-"),
            },
            { title: "首次提交", dataIndex: "first", width: 90, render: (v: string) => v.slice(11, 16) },
            { title: "末次提交", dataIndex: "last", width: 90, render: (v: string) => v.slice(11, 16) },
          ]}
        />
      </Card>

      <Card
        size="small"
        title={
          <Space>
            按小时
            <Select size="small" style={{ minWidth: 130 }} value={hourly.day ?? undefined} options={days.map((d) => ({ value: d, label: d }))} onChange={setDay} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>每格 = 这一小时内交了几个任务（点上面表格的行也能切换日期）</Typography.Text>
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
              width: 44,
              align: "center" as const,
              render: (_: unknown, r: { hours: number[] }) => {
                const n = r.hours[h];
                if (!n) return <span style={{ color: "#555" }}>·</span>;
                const alpha = 0.25 + 0.75 * (n / hourMax);
                return (
                  <div style={{ background: `rgba(114, 46, 209, ${alpha})`, borderRadius: 3, padding: "0 2px" }}>{n}</div>
                );
              },
            })),
            { title: "合计", dataIndex: "total", width: 60, align: "center" as const },
          ]}
        />
      </Card>

      <Card size="small" title="明细">
        <Table
          rowKey={(r) => `${r.task_id}-${r.round_no}`}
          size="small"
          loading={isLoading}
          dataSource={[...shown].reverse()}
          pagination={{ pageSize: 50, showSizeChanger: true }}
          columns={[
            { title: "提交时间", dataIndex: "submitted_at", width: 150, render: (v: string | null) => v?.replace("T", " ").slice(0, 19) ?? "-" },
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
