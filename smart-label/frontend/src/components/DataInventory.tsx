import { useState } from "react";
import { Alert, Button, Modal, Select, Space, Statistic, Table, Tag, Tooltip, Typography, Row, Col } from "antd";
import { useQuery } from "@tanstack/react-query";
import { labelInventory, type InventoryBucket } from "@/api/dataPool";
import { fmtSecs } from "@/utils/fmtDuration";

/**
 * 数据盘点：某一类（默认抓挠，含全部细类）的片段现在都在哪一步——
 * 已经在训练里用上的、进池了还没训练的、人看过但还没进池的（审核通过就能用）、AI 给了没人看的、疑似片段还没判的。
 * 回答「高质量数据到底有多少、还有多少能挖」。
 */
export default function DataInventory({ labelOptions }: { labelOptions: string[] }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("抓挠");
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["label-inventory", label],
    queryFn: () => labelInventory(label),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const t = data?.totals;
  const stat = (title: string, v?: { n: number; seconds: number }, color?: string, tip?: string) => (
    <Col>
      <Tooltip title={tip}>
        <Statistic title={<span style={{ cursor: tip ? "help" : undefined }}>{title}</span>}
          value={v ? fmtSecs(v.seconds) : "-"} valueStyle={{ color, fontSize: 20 }}
          suffix={v ? <span style={{ fontSize: 12, opacity: 0.7 }}> · {v.n} 段</span> : null} loading={isFetching} />
      </Tooltip>
    </Col>
  );
  return (
    <>
      <Button onClick={() => setOpen(true)}>数据盘点</Button>
      <Modal title="数据盘点：这一类的片段都在哪一步" open={open} onCancel={() => setOpen(false)} footer={null} width="min(1100px, 96vw)" style={{ top: 24 }}>
        <Space style={{ marginBottom: 12 }} wrap>
          <span>类别</span>
          <Select showSearch style={{ width: 200 }} value={label} onChange={setLabel}
            options={[...new Set(["抓挠", ...labelOptions])].map((x) => ({ value: x, label: x }))} />
          <Button size="small" loading={isFetching} onClick={() => refetch()}>刷新</Button>
          {data && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              含细类：{data.labels.join("、") || "—"}。只算每个任务当前这一轮；所有项目合在一起
            </Typography.Text>
          )}
        </Space>
        {data && (
          <>
            <Row gutter={32} style={{ marginBottom: 12 }}>
              {stat("训练记录里已经用过（高质量）", t?.used, "#52c41a", "训练记录的主数据集 + 一起训练的数据集里的，模型实际训过；几份数据集重复的只算一次")}
              {stat("人看过、还没用上", t?.reviewed_unused, "#faad14", "在数据池但没被训练用过的 + AI 已确认 / 人改过 / 人工画的 / 从疑似确认的 / 审核退回的（都没进过任何训练）")}
              {stat("其中已在数据池", t?.pool_unused, undefined, "审核通过 / 手动加入了，下次从数据池导出训练就能用上")}
              {stat("AI 给的、没人看过", t?.ai_untouched, "#8c8c8c", "模型自己标的，不算高质量；人确认一遍就能变成可用的")}
              {stat("疑似片段还没判", data.candidates_pending, "#8c8c8c", "「疑似片段」里还没人点确认 / 排除的")}
            </Row>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message="「已经用过」直接读训练记录用过的那几份数据集（模型实际吃进去的标签）；下面其它几行是数据库里这一类、跟用过的不重叠的片段"
              description={data.datasets.length ? (
                <div style={{ fontSize: 12 }}>
                  {data.datasets.map((d) => (
                    <div key={d.name}>
                      {d.name}：{d.n} 段 · {fmtSecs(d.seconds)}（训练记录 #{d.versions.join("、#")}）{d.missing ? " ⚠ 导出文件找不到了" : ""}
                    </div>
                  ))}
                </div>
              ) : "还没有训练记录用过数据集"} />
            <Table<InventoryBucket>
              size="small" rowKey="key" pagination={false} dataSource={data.buckets}
              expandable={{
                rowExpandable: (r) => r.by_project.length > 0,
                expandedRowRender: (r) => (
                  <Table size="small" rowKey="name" pagination={false} dataSource={r.by_project}
                    columns={[{ title: "项目", dataIndex: "name" }, { title: "片段", dataIndex: "n", width: 100 },
                      { title: "时长", dataIndex: "seconds", width: 140, render: (s: number) => fmtSecs(s) }]} />
                ),
              }}
              columns={[
                { title: "在哪一步", dataIndex: "name", render: (n: string, r) => (
                  <Space size={6}>{r.usable ? <Tag color="green">能训练</Tag> : <Tag>还不能</Tag>}<span>{n}</span></Space>) },
                { title: "片段", dataIndex: "n", width: 100, align: "right" as const },
                { title: "时长", dataIndex: "seconds", width: 140, align: "right" as const, render: (s: number) => fmtSecs(s) },
                { title: "说明", dataIndex: "note", render: (x: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x}</Typography.Text> },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
