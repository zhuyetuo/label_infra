import { useMemo, useState } from "react";
import { Alert, Card, DatePicker, Empty, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  listDailyStats,
  listDailyStatsVersions,
  type DailyStatsRow,
} from "@/api/dailyStats";
import DailyStatsCharts from "@/components/DailyStatsCharts";

/**
 * 日常统计：每只狗每天各类行为多久、多少次。
 *
 * 跟皮肤评估是**两个问题**，所以是两个页面：
 *   皮肤评估   抓挠 → C值 → 问答 → S总分，回答"皮肤有没有风险"
 *   日常统计   五类行为，回答"这只狗今天过得怎么样"
 *
 * 数据是**平台自己跑的推理结果**，不是线上项圈那条线（algo_service 的
 * pet_dog_daily_summary）。两边数据源、模型、后处理都不一样，而且线上那个
 * 现在只有 3 类、没有未佩戴和甩身体。所以这里把模型版本明确标在顶上，
 * 不跟线上那张表混着说。
 */

const { Text } = Typography;

// 哪些类别看时长、哪些看次数。
//
// 依据是这个数**有没有意义**，不是好不好看：
//   活动/睡觉/未佩戴  是状态，"今天睡了 8 小时"有意义，"睡觉 12 段"没有
//   抓挠              是事件，次数才是临床上看的那个数
//   甩身体            两个都不太要紧，跟着事件走
const DURATION_FIRST = new Set(["活动", "睡觉", "未佩戴"]);

const fmtDur = (sec: number) => {
  if (!sec) return "0";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
};

export default function DailyStats() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(13, "day"),
    dayjs(),
  ]);
  const [version, setVersion] = useState<string>("");

  const { data: versions } = useQuery({
    queryKey: ["daily-stats-versions"],
    queryFn: listDailyStatsVersions,
    staleTime: 60_000,
  });

  // 默认选样本最多的那个版本。**不默认选第一个**——版本列表是按覆盖量排的，
  // 选一个只跑过两天的版本会让人以为没数据
  const picked = version || (versions?.length ? `${versions[0].model_tag}|${versions[0].mode}` : "");
  const [tag, mode] = picked.split("|");

  const { data, isFetching } = useQuery({
    queryKey: ["daily-stats", range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD"), tag, mode],
    queryFn: () =>
      listDailyStats({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        model_tag: tag,
        mode,
      }),
    enabled: Boolean(tag && mode),
  });

  // 表格的列由**数据里实际出现的类别**决定，不写死五个。
  // 写死的话换一个 3 类模型会多出两列空的，看着像"这两类一直是 0"
  const labels = useMemo(() => {
    const seen: string[] = [];
    for (const r of data ?? []) {
      for (const l of r.labels) if (!seen.includes(l)) seen.push(l);
    }
    return seen;
  }, [data]);

  const noSeconds = (data ?? []).some((r) => !r.has_seconds);

  const columns = [
    {
      title: "日期",
      dataIndex: "stat_date",
      width: 110,
      sorter: (a: DailyStatsRow, b: DailyStatsRow) => a.stat_date.localeCompare(b.stat_date),
    },
    {
      title: "狗",
      width: 130,
      render: (_: unknown, r: DailyStatsRow) => (
        <Space size={4}>
          <b>{r.dog_name || "未登记"}</b>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.imu}</Text>
        </Space>
      ),
    },
    ...labels.map((l) => ({
      title: (
        <Tooltip title={DURATION_FIRST.has(l) ? "这一天累计多久" : "这一天累计多久，后面是发生次数"}>
          {l}
        </Tooltip>
      ),
      width: 130,
      render: (_: unknown, r: DailyStatsRow) => {
        const sec = r.seconds[l] ?? 0;
        const n = r.counts[l] ?? 0;
        // 没有时长数据时**不显示 0 秒**——那是"不知道"，不是"是 0"。
        // 显示 0 的话，历史那些行看起来像这只狗一整天没动过
        if (!r.has_seconds) {
          // **不显示 0**——那是"不知道"，不是"是 0"。
          // 显示 0 的话，没补过时长的那些天看起来像这只狗一整天没动过
          return (
            <Tooltip title="这一行是「每类总时长」这个字段加进来之前跑的。补一下：docker compose exec api python -m app.scripts.backfill_label_seconds">
              <Text type="secondary">时长未记</Text>
            </Tooltip>
          );
        }
        return (
          <Space size={4}>
            <b>{fmtDur(sec)}</b>
            {DURATION_FIRST.has(l) ? null : <Text type="secondary">{n} 次</Text>}
          </Space>
        );
      },
    })),
    {
      title: (
        <Tooltip title="这一天有多少秒的数据是缺的（蓝牙断联等）。缺得多的话下面那些数天然偏低，别当成「今天没动」">
          缺数据
        </Tooltip>
      ),
      width: 110,
      render: (_: unknown, r: DailyStatsRow) =>
        r.missing_seconds > 60 ? (
          <Tag color="orange">{fmtDur(r.missing_seconds)}</Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: "样本 / 窗口",
      width: 120,
      render: (_: unknown, r: DailyStatsRow) => (
        <Text type="secondary">
          {r.n_samples} / {r.n_windows}
        </Text>
      ),
    },
  ];

  return (
    <Card
      title="日常统计"
      extra={
        <Space wrap>
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
            allowClear={false}
          />
          <Select
            style={{ minWidth: 300 }}
            value={picked || undefined}
            placeholder="选模型和版本"
            onChange={setVersion}
            options={(versions ?? []).map((v) => ({
              value: `${v.model_tag}|${v.mode}`,
              label: `${v.model_tag} · ${v.mode}（${v.n_samples} 个样本）`,
            }))}
          />
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这是平台自己跑的推理结果，按模型版本分开统计"
        description={
          <>
            <div>
              一天里的样本可能是不同版本跑的，所以**必须选一个版本**看——混着加起来会得到一个悄悄把两版平均掉的数字，
              而它看起来完全正常。
            </div>
            <div>
              跟线上项圈那条线（algo_service 的日汇总）不是同一份数据：数据源、模型、后处理都不一样，
              线上现在的模型还只有 3 类、没有未佩戴和甩身体。两个数字别互相对着看。
            </div>
          </>
        }
      />
      {noSeconds ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="有些行没有时长数据"
          description={
            <>
              <div>「每类总时长」是后加的字段，这些行是它之前跑的，所以只有段数没有时长。</div>
              <div style={{ marginTop: 6 }}>
                补一下（读 NAS 上已有的结果 JSON，几分钟，可重复跑）：
                <code style={{ marginLeft: 6 }}>
                  docker compose exec api python -m app.scripts.backfill_label_seconds
                </code>
              </div>
            </>
          }
        />
      ) : null}
      {!versions?.length ? (
        <Empty description="还没有任何推理结果。先在项目里跑一次 AI 预标注。" />
      ) : (
        <Tabs
          items={[
            {
              key: "table",
              label: "统计表",
              children: (
                <Table
                  rowKey={(r) => `${r.stat_date}-${r.imu}`}
                  loading={isFetching}
                  dataSource={data ?? []}
                  columns={columns}
                  size="small"
                  pagination={{ pageSize: 50, showSizeChanger: true }}
                />
              ),
            },
            {
              key: "charts",
              label: "趋势图",
              children: <DailyStatsCharts rows={data ?? []} labels={labels} />,
            },
          ]}
        />
      )}
    </Card>
  );
}
