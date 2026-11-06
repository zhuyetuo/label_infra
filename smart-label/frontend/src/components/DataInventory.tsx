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
              {stat("已经用来训练过", t?.trained, "#52c41a", "在数据池里、而且进池早于最近一次从数据池导出的训练数据集")}
              {stat("数据池里（能直接训练）", t?.pool, undefined, "审核通过的 + 手动加入的；含上面已经训练过的")}
              {stat("人看过、还没进池（没用上）", t?.reviewed_not_in_pool, "#faad14", "AI 已确认 / 人改过 / 人工画的 / 从疑似确认的 / 审核退回的：片段审核里通过（或手动加入数据池）就能用上")}
              {stat("AI 给的、没人看过", t?.ai_untouched, "#8c8c8c", "模型自己标的，不算高质量；人确认一遍就能变成可用的")}
              {stat("疑似片段还没判", data.candidates_pending, "#8c8c8c", "「疑似片段」里还没人点确认 / 排除的")}
            </Row>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={data.last_pool_export
                ? `最近一次从数据池导出训练数据集：${data.last_pool_export.replace("T", " ").slice(0, 16)}。「已经训练过」按进池时间早于它算——那次导出如果按类别 / 狗 / 日期筛过，实际用上的会少一些`
                : "还没从数据池导出过训练数据集，所以「已经训练过」是 0；池里的都还没用上"} />
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
