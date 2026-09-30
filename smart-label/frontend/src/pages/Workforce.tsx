import { useMemo, useState } from "react";
import { Alert, Card, DatePicker, Progress, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import { getWorkforce, type EffUser, type EstimateRow, type LedgerRow } from "@/api/dashboard";

/**
 * 人力管理：三张表回答三个问题。
 *   台账  某个项目什么时候分给了谁、做到哪了、几天做完
 *   效率  这个人确认一段抓挠要多久、判一条疑似要多久、每天多少动作，几个人并排比
 *   预估  按他实测的速度，剩下的活还要几小时——定的任务量是不是过大
 *
 * 每条耗时的算法见后端 workforce_service：相邻两次动作的间隔归到后一个动作的类别上，
 * 隔太久（离开了）不算。片段的"动手时间"是新加的字段，部署前的片段没有，
 * 所以刚上线时抓挠那一列会是空的，做几天就有了；疑似抓挠一直有记录，立刻能看。
 */

const fmtSec = (s: number | null | undefined) => {
  if (s == null) return "-";
  if (s < 60) return `${Math.round(s)} 秒`;
  return `${(s / 60).toFixed(1)} 分`;
};
const fmtHours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} 小时` : `${Math.round(s / 60)} 分`);
const fmtTime = (v: string | null, f = "MM-DD HH:mm") => (v ? dayjs(v).format(f) : "-");
const FILTER_KEY = "workforce-range";

export default function Workforce() {
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
    return [dayjs().subtract(13, "day"), dayjs()];
  });
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const { data, isLoading } = useQuery({ queryKey: ["workforce", from, to], queryFn: () => getWorkforce(from, to) });

  // 效率表：所有人出现过的类别做列，抓挠 / 疑似抓挠 / 提交任务排前面
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const u of data?.efficiency ?? []) for (const c of u.categories) set.add(c.category);
    const front = ["抓挠", "疑似抓挠", "提交任务"].filter((c) => set.has(c));
    const rest = [...set].filter((c) => !front.includes(c)).sort();
    return [...front, ...rest];
  }, [data]);
  const catOf = (u: EffUser, c: string) => u.categories.find((x) => x.category === c);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每条耗时 = 相邻两次动作的间隔归到后一个动作的类别上，隔 10 分钟以上当离开不计，取中位数"
        description="片段的「动手时间」是新加的字段，部署之前确认过的片段没有，抓挠那一列要做几天才有数；疑似抓挠的判定时间一直有记录，立刻能看。"
      />

      <Card size="small" title="分配台账（启用中的项目）" style={{ marginBottom: 12 }}>
        <Table
          rowKey={(r) => `${r.project_id}-${r.user_id}`}
          size="small"
          loading={isLoading}
          dataSource={data?.ledger ?? []}
          pagination={{ pageSize: 15, showSizeChanger: false }}
          columns={[
            { title: "项目", dataIndex: "project_name", width: 130 },
            { title: "标注员", dataIndex: "user_name", width: 110 },
            {
              title: <Tooltip title="指派 / 批量导入时记的分配时间；灰色的是没记录、退回任务创建时间">分配时间</Tooltip>,
              dataIndex: "assigned_at",
              width: 120,
              render: (v: string | null, r: LedgerRow) => (
                <span style={{ color: r.assigned_logged ? undefined : "#888" }}>{fmtTime(v)}</span>
              ),
            },
            {
              title: "任务",
              width: 190,
              render: (_, r: LedgerRow) => (
                <Tooltip title={`已提交 ${r.tasks_submitted} / ${r.tasks_total}，审核通过 ${r.tasks_approved}`}>
                  <Progress
                    percent={r.tasks_total ? Math.round((r.tasks_submitted / r.tasks_total) * 100) : 0}
                    size="small"
                    format={() => `${r.tasks_submitted}/${r.tasks_total}`}
                  />
                </Tooltip>
              ),
            },
            {
              title: "抓挠待确认",
              width: 110,
              render: (_, r: LedgerRow) =>
                r.scratch_total ? (
                  <Tag color={r.scratch_pending ? "red" : "green"}>{r.scratch_pending} / {r.scratch_total}</Tag>
                ) : "-",
            },
            {
              title: "疑似待判",
              width: 110,
              render: (_, r: LedgerRow) =>
                r.cand_total ? (
                  <Tag color={r.cand_pending ? "magenta" : "green"}>{r.cand_pending} / {r.cand_total}</Tag>
                ) : "-",
            },
            { title: "第一次动手", dataIndex: "first_touch", width: 120, render: (v: string | null) => fmtTime(v) },
            { title: "最近动手", dataIndex: "last_touch", width: 120, render: (v: string | null) => fmtTime(v) },
            {
              title: <Tooltip title="任务全交、抓挠全确认、疑似全判完才算完成；还没完成的显示到现在用了几天">用了几天</Tooltip>,
              width: 110,
              sorter: (a: LedgerRow, b: LedgerRow) => (a.days_used ?? 0) - (b.days_used ?? 0),
              render: (_, r: LedgerRow) =>
                r.days_used == null ? "-" : r.done ? (
                  <Tag color="green">{r.days_used} 天完成</Tag>
                ) : (
                  <span>{r.days_used} 天（进行中）</span>
                ),
            },
          ]}
        />
      </Card>

      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text>效率统计日期</Typography.Text>
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
      </Space>

      <Card size="small" title="效率：每条中位耗时（括号里是动作数）" style={{ marginBottom: 12 }}>
        <Table
          rowKey="user_id"
          size="small"
          loading={isLoading}
          dataSource={data?.efficiency ?? []}
          pagination={false}
          scroll={{ x: true }}
          columns={[
            { title: "标注员", dataIndex: "user_name", width: 110, fixed: "left" as const },
            {
              title: <Tooltip title="这段日期里的动作总数（确认/改/新加片段、判候选、提交）">动作数</Tooltip>,
              dataIndex: "total_actions", width: 80,
            },
            {
              title: <Tooltip title="动作之间的间隔累加（超过 10 分钟的不算），约等于真正在标注的时间">有效工时</Tooltip>,
              dataIndex: "total_work_seconds", width: 100, render: (s: number) => fmtHours(s),
            },
            {
              title: "每小时动作",
              width: 100,
              render: (_, u: EffUser) => (u.total_work_seconds ? (u.total_actions / (u.total_work_seconds / 3600)).toFixed(0) : "-"),
            },
            ...categories.map((c) => ({
              title: c,
              width: 110,
              render: (_: unknown, u: EffUser) => {
                const x = catOf(u, c);
                if (!x) return <span style={{ color: "#555" }}>·</span>;
                return (
                  <Tooltip title={`${x.n} 个动作，其中 ${x.n_timed} 个有前一个动作可以算间隔；平均 ${fmtSec(x.mean_seconds)}`}>
                    <span>
                      <b>{fmtSec(x.median_seconds)}</b> <span style={{ color: "#888" }}>({x.n})</span>
                    </span>
                  </Tooltip>
                );
              },
            })),
          ]}
          expandable={{
            expandedRowRender: (u: EffUser) => (
              <Table
                size="small"
                rowKey="day"
                pagination={false}
                dataSource={u.days}
                columns={[
                  { title: "日期", dataIndex: "day", width: 120 },
                  { title: "动作数", dataIndex: "actions", width: 100 },
                  { title: "有效工时", dataIndex: "work_seconds", width: 120, render: (s: number) => fmtHours(s) },
                  {
                    title: "每小时动作",
                    render: (_, d: { actions: number; work_seconds: number }) =>
                      d.work_seconds ? (d.actions / (d.work_seconds / 3600)).toFixed(0) : "-",
                  },
                ]}
              />
            ),
          }}
        />
      </Card>

      <Card size="small" title="预估：按各自实测速度，剩下的还要多久（每天按 6 小时有效标注折算）">
        <Table
          rowKey={(r) => `${r.project_id}-${r.user_id}`}
          size="small"
          loading={isLoading}
          dataSource={data?.estimate ?? []}
          pagination={false}
          columns={[
            { title: "项目", dataIndex: "project_name", width: 130 },
            { title: "标注员", dataIndex: "user_name", width: 110 },
            {
              title: "还剩",
              render: (_, r: EstimateRow) => (
                <Space size={4} wrap>
                  <Tag color="orange">未交任务 {r.tasks_left}</Tag>
                  <Tag color="red">抓挠待确认 {r.scratch_pending}</Tag>
                  <Tag color="magenta">疑似待判 {r.cand_pending}</Tag>
                </Space>
              ),
            },
            {
              title: <Tooltip title="用的这个人自己的实测速度；带 * 的是他这一类还没测够（不足 5 条），用的全员中位数">按什么速度算</Tooltip>,
              render: (_, r: EstimateRow) => (
                <span style={{ color: "#aaa", fontSize: 12 }}>
                  抓挠 {fmtSec(r.sec_per_scratch)}{r.using_pool.scratch ? "*" : ""} / 条 · 疑似 {fmtSec(r.sec_per_cand)}{r.using_pool.cand ? "*" : ""} / 条 · 任务 {fmtSec(r.sec_per_task)}{r.using_pool.tasks ? "*" : ""} / 个
                </span>
              ),
            },
            {
              title: "预计还要",
              width: 170,
              sorter: (a: EstimateRow, b: EstimateRow) => (a.hours_left ?? -1) - (b.hours_left ?? -1),
              render: (_, r: EstimateRow) =>
                r.hours_left == null ? (
                  <Tooltip title={`还没有 ${r.missing.map((m) => ({ scratch: "抓挠", cand: "疑似", tasks: "任务" })[m]).join("/")} 的实测速度，算不出来`}>
                    <span style={{ color: "#888" }}>数据不够</span>
                  </Tooltip>
                ) : (
                  <b>{r.hours_left} 小时 ≈ {r.days_left} 天</b>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
