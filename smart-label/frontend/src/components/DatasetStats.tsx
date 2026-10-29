import { useMemo, useState } from "react";
import { Progress, Radio, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getDatasetStats, listProjectProgress } from "@/api/dashboard";
import { fmtSecs } from "@/utils/fmtDuration";

/**
 * 可用数据的类别统计：审核通过的任务里各大类多少段、多长、占多少——看这批数据集类别均不均衡，
 * 哪类太少要让标注员补。
 *
 * 两种口径（对应导出训练集的 scope）：
 *   审核通过的全部片段   scope=approved 会导出的东西，含审核通过但没人看过的纯 AI 片段
 *   只算人确认过的       scope=reviewed 只取这些；两者差得多说明大量 AI 片段没人看就通过了
 */

const fmtH = fmtSecs;

export default function DatasetStats() {
  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [basis, setBasis] = useState<"all" | "confirmed">("all");
  const { data: progress } = useQuery({ queryKey: ["project-progress"], queryFn: listProjectProgress });
  const { data, isLoading } = useQuery({
    queryKey: ["dataset-stats", projectIds],
    queryFn: () => getDatasetStats(projectIds),
  });

  const rows = useMemo(() => {
    const cats = (data?.categories ?? []).map((c) => ({
      ...c,
      sec: basis === "all" ? c.seconds : c.confirmed_seconds,
      cnt: basis === "all" ? c.n : c.confirmed,
    }));
    return cats.sort((a, b) => b.sec - a.sec);
  }, [data, basis]);
  const total = rows.reduce((s, c) => s + c.sec, 0);
  const nonzero = rows.filter((c) => c.sec > 0);
  const zero = rows.filter((c) => c.sec <= 0);
  const ratio = nonzero.length > 1 ? nonzero[0].sec / nonzero[nonzero.length - 1].sec : null;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      <Space wrap>
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 320 }}
          placeholder="全部启用中的项目（跟导出训练集同一口径）"
          value={projectIds}
          onChange={setProjectIds}
          options={(progress ?? []).map((p) => ({ value: p.project_id, label: p.project_name }))}
          maxTagCount={4}
        />
        <Radio.Group size="small" value={basis} onChange={(e) => setBasis(e.target.value)}>
          <Tooltip title="审核通过任务里的全部片段，含没人看过的纯 AI 片段（导出训练集选「整份取：审核通过」会带上这些）">
            <Radio.Button value="all">审核通过的全部片段</Radio.Button>
          </Tooltip>
          <Tooltip title="只算人确认过 / 改过 / 自己加的片段，不含待定（导出训练集选「只取人看过的」就是这些）">
            <Radio.Button value="confirmed">只算人确认过的</Radio.Button>
          </Tooltip>
        </Radio.Group>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        审核通过 <b>{data?.n_tasks ?? 0}</b> 个任务，共 <b>{fmtH(total)}</b> 标注
        {ratio != null && (
          <>
            ；最多的类别是最少的 <b style={{ color: ratio > 20 ? "#ff4d4f" : undefined }}>{ratio.toFixed(0)}</b> 倍
            {ratio > 20 ? "（很不均衡：训练时考虑勾「类别均衡」，或让标注员补少的那几类）" : ""}
          </>
        )}
        {zero.length > 0 && <>；一段都没有：{zero.map((c) => c.name).join("、")}</>}
      </Typography.Text>
      <Table
        size="small"
        rowKey="name"
        loading={isLoading}
        pagination={false}
        dataSource={nonzero}
        columns={[
          {
            title: "类别",
            dataIndex: "name",
            width: 140,
            render: (n: string, c) => <Tag color={c.color ?? undefined}>{n}</Tag>,
          },
          { title: "段数", dataIndex: "cnt", width: 80, align: "right" as const },
          { title: "时长", dataIndex: "sec", width: 110, align: "right" as const, render: (s: number) => fmtH(s) },
          {
            title: "占比（按时长）",
            width: 260,
            render: (_, c) => (
              <Progress
                percent={total ? Math.round((c.sec / total) * 1000) / 10 : 0}
                size="small"
                strokeColor={c.color ?? undefined}
                // 很少的类别四舍五入成 0%，看着像没有——写成 <0.1%
                format={(p) => (p === 0 && c.sec > 0 ? "<0.1%" : `${p}%`)}
              />
            ),
          },
          { title: "任务数", dataIndex: "tasks", width: 80, align: "right" as const },
          {
            title: (
              <Tooltip title="人确认 / 改过 / 自己加的时长 ÷ 全部时长。低说明很多 AI 片段没人看就通过了">人看过的比例</Tooltip>
            ),
            width: 120,
            align: "right" as const,
            render: (_, c) => (c.seconds ? `${Math.round((c.confirmed_seconds / c.seconds) * 100)}%` : "-"),
          },
          {
            title: "子类",
            render: (_, c) =>
              Object.keys(c.sub).length > 1 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {Object.entries(c.sub)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, v]) => `${k} ${v}`)
                    .join("，")}
                </Typography.Text>
              ) : null,
          },
        ]}
      />
    </Space>
  );
}
