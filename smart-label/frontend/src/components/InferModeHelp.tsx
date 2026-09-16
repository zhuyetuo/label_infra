import { useState } from "react";
import { Modal, Table, Tag, Tooltip, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";

/**
 * 「版本」下拉旁边的问号：点开是一张表，一眼看出各版本差在哪。
 *
 * 为什么不把说明写进选项标签：写进去之后标签太长会被下拉框截断，
 * 而**截断之后先没的恰好是后半句**（也就是真正区分它们的那部分）。
 * 写进 hover 提示也不行——人是扫列表的，不是逐个悬停的。
 *
 * 所以：标签只留名字，差异放一张表里。
 */

const { Text } = Typography;

type Row = {
  key: string;
  name: string;
  model: string;
  infer: string;
  post: string;
  note?: string;
};

const ROWS: Row[] = [
  {
    key: "stable",
    name: "稳定版",
    model: "线上模型",
    infer: "服务端",
    post: "服务端 · 滞回 + 间隔合并",
    note: "抓挠用双阈值滞回不被切碎",
  },
  {
    key: "viterbi",
    name: "稳定版 v2",
    model: "线上模型",
    infer: "服务端",
    post: "服务端 · 离线 viterbi",
    note: "整条时间轴一起解码，目前效果最好",
  },
  {
    key: "raw",
    name: "调试版",
    model: "线上模型",
    infer: "服务端",
    post: "无",
    note: "模型逐窗口原始输出，用来看模型到底说了什么",
  },
  {
    key: "edge",
    name: "端侧 · 稳定版 v2",
    model: "板上 C",
    infer: "板上 C",
    post: "服务端 · 离线 viterbi",
    note: "跟上面的「稳定版 v2」比，差的只有模型本身",
  },
  {
    key: "edge-board",
    name: "端侧 · 板上整条链",
    model: "板上 C",
    infer: "板上 C",
    post: "板上 C · 流式 + 有界回溯",
    note: "三段全是板子会跑的那份。没有板子时，这一列才回答「板子会报什么」",
  },
  {
    key: "edge-raw",
    name: "端侧 · 板上原始",
    model: "板上 C",
    infer: "板上 C",
    post: "无",
    note: "板上不做后处理时的样子，最碎",
  },
];

const cell = (v: string) =>
  v === "无" ? <Text type="secondary">无</Text>
    : v.startsWith("板上") ? <Tag color="purple">{v}</Tag>
      : <Text>{v}</Text>;

export default function InferModeHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="各版本差在哪">
        <QuestionCircleOutlined
          style={{ cursor: "pointer", color: "#888" }}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={860}
        title="版本之间差在哪"
      >
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={ROWS}
          columns={[
            { title: "版本", dataIndex: "name", width: 150 },
            { title: "模型", dataIndex: "model", width: 100, render: cell },
            { title: "推理", dataIndex: "infer", width: 90, render: cell },
            { title: "后处理", dataIndex: "post", width: 190, render: cell },
            {
              title: "说明",
              dataIndex: "note",
              render: (v: string) => <Text type="secondary">{v}</Text>,
            },
          ]}
        />
        <Text type="secondary" style={{ display: "block", marginTop: 12 }}>
          「板上 C」= 烧进项圈的那份 C 代码，服务这边编成 .so 跑，**跟板子是同一个源文件**。
          端侧那三行只有后处理不同，可以并排跑来看板上那套跟服务端那套差多少。
        </Text>
      </Modal>
    </>
  );
}
