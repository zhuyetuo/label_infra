import { useState } from "react";
import { Button, Collapse, Modal, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
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
        {data && (() => {
          const bk = (k: string) => data.buckets.find((x) => x.key === k) ?? { n: 0, seconds: 0 };
          const sum = (...ks: string[]) => ks.reduce((acc, k) => ({ n: acc.n + bk(k).n, seconds: acc.seconds + bk(k).seconds }), { n: 0, seconds: 0 });
          // 一条流水线，从左到右越来越「能用」：每一格写清楚现在有多少、下一步要做什么
          const stages: { title: string; v: { n: number; seconds: number }; color: string; next: string; tip: string }[] = [
            { title: "疑似片段，还没判", v: data.candidates_pending, color: "#8c8c8c", next: "在工作台里确认 / 排除",
              tip: "AI 觉得可能是这一类、还没成为正式片段的候选（「疑似片段」）。确认了才变成片段" },
            { title: "AI 标的，还没人看", v: bk("ai_untouched"), color: "#8c8c8c", next: "人确认一遍",
              tip: "AI 预标注给的片段，没人确认过、没改过。不算高质量" },
            { title: "人看过，等审核", v: sum("human", "ai_modified", "ai_confirmed"), color: "#faad14", next: "片段审核「通过」",
              tip: "人确认过的 / 改过起止或类别的 / 人自己画的 / 从疑似片段确认来的，还没审核通过" },
            { title: "审核通过，在数据池", v: bk("pool_unused"), color: "#1677ff", next: "导出成数据集去训练",
              tip: "审核通过（或手动加入）的高质量片段，还没被任何一次训练用过。导出过数据集但那份数据集还没训练过的，也算这里" },
            { title: "已经训练过", v: bk("used"), color: "#52c41a", next: "",
              tip: "训练记录用过的数据集里的这一类片段（模型实际训过）；几份数据集重复的只算一次" },
          ];
          return (
          <>
            <div style={{ display: "flex", alignItems: "stretch", gap: 4, marginBottom: 8, overflowX: "auto" }}>
              {stages.map((st, i) => (
                <div key={st.title} style={{ display: "flex", alignItems: "center", flex: "1 1 0", minWidth: 170 }}>
                  <Tooltip title={st.tip}>
                    <div style={{ flex: 1, border: `1px solid ${st.color}`, borderTop: `4px solid ${st.color}`, borderRadius: 8, padding: "10px 12px", cursor: "help", height: "100%" }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}><span style={{ color: st.color, marginRight: 4 }}>{"①②③④⑤"[i]}</span>{st.title}</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: st.color, marginTop: 4 }}>{fmtSecs(st.v.seconds)}</div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{st.v.n} 段</div>
                      {st.next && <div style={{ fontSize: 12, marginTop: 6 }}>下一步：<b>{st.next}</b></div>}
                    </div>
                  </Tooltip>
                  {i < stages.length - 1 && <span style={{ fontSize: 18, opacity: 0.5, padding: "0 4px" }}>→</span>}
                </div>
              ))}
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
              另外：标了「待定」的 {bk("uncertain").n} 段、审核退回等标注员改的 {bk("returned").n} 段，不进训练。
              {" "}<b>数据池</b> = 所有审核通过的高质量片段的总库；<b>数据集</b> = 某次从池里挑一部分导出的一份快照；<b>训练记录</b>用的是数据集。
              只算每个任务当前这一轮、所有项目合在一起。
            </Typography.Paragraph>
            <Collapse size="small" style={{ marginBottom: 12 }} items={[{
              key: "ds", label: `训练用过的数据集（${data.datasets.length} 份）`,
              children: data.datasets.length ? (
                <div style={{ fontSize: 12 }}>
                  {data.datasets.map((d) => (
                    <div key={d.name}>
                      {d.name}：{d.n} 段 · {fmtSecs(d.seconds)}（训练记录 #{d.versions.join("、#")}）{d.missing ? " ⚠ 导出文件找不到了" : ""}
                    </div>
                  ))}
                </div>
              ) : "还没有训练记录用过数据集",
            }, {
              key: "detail", label: "明细：每一步分别在哪些项目里（点 + 展开）",
              children: (
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
              ),
            }]} />
          </>
          );
        })()}
      </Modal>
    </>
  );
}
