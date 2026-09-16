import { useState } from "react";
import { Modal, Table, Tag, Tooltip, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";

/**
 * 「合计」那一列旁边的问号：一天 24 小时，合计对不上的时候看这张表。
 *
 * 为什么需要这个：合计**不该**总是 24 小时，而且偏多和偏少是两类完全不同的
 * 毛病——偏少通常是数据没采满（正常），偏多通常是样本时间段重叠（是 bug，
 * 得去查）。不解释的话人只会看到一个"不对"的数字，却不知道该不该管。
 *
 * 用表不用一段话：人是扫的，不是读的。跟 InferModeHelp 一个路子。
 */

const { Text } = Typography;

type Row = { key: string; sign: string; cause: string; what: string };

const ROWS: Row[] = [
  {
    key: "short-partial",
    sign: "偏少",
    cause: "那天没采满 24 小时",
    what: "最常见。项圈中途摘下来充电、或者当天下午才开始采——合计就等于实际采集的那段时长。看「样本 / 窗口」那列能印证：窗口数 ÷ 2 ≈ 合计秒数。",
  },
  {
    key: "short-missing",
    sign: "偏少",
    cause: "蓝牙断联，中间有缺口",
    what: "看「缺数据」那列。缺掉的那些秒不属于任何一类，所以合计里没有它们。缺得多的时候，各类时长天然偏低，别当成「今天没动」。",
  },
  {
    key: "short-rot",
    sign: "偏少",
    cause: "这只狗当天换了另一个 IMU",
    what: "表是按 (日期, 设备) 一行的，两个设备各占一行、各自不满一天。筛选里用「按狗」选，两行会一起出来，加起来才是这只狗的一天。",
  },
  {
    key: "long-overlap",
    sign: "偏多",
    cause: "同一天几个样本的时间段重叠",
    what: "同一段时间被算了两遍。多半是同一批数据导入了两次、或者同一个样本重跑过。这个要查：合计比 24 小时多，说明数据本身有重复。",
  },
  {
    key: "long-midnight",
    sign: "偏多",
    cause: "样本跨了午夜",
    what: "日期取的是样本的采集日期，一个从晚上 10 点采到第二天早上 8 点的样本，10 个小时全记在第一天。所以那天可能超过 24 小时，而第二天偏少。",
  },
];

export default function DayTotalHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="合计跟 24 小时对不上？">
        <QuestionCircleOutlined
          style={{ cursor: "pointer", color: "#888" }}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={820}
        title="合计跟 24 小时对不上，怎么看"
      >
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={ROWS}
          columns={[
            {
              title: "方向",
              dataIndex: "sign",
              width: 70,
              render: (v: string) => (
                <Tag color={v === "偏多" ? "red" : "orange"}>{v}</Tag>
              ),
            },
            { title: "原因", dataIndex: "cause", width: 190 },
            {
              title: "怎么判断",
              dataIndex: "what",
              render: (v: string) => <Text type="secondary">{v}</Text>,
            },
          ]}
        />
        <Text type="secondary" style={{ display: "block", marginTop: 12 }}>
          合计 = 前面各类时长相加，**不含「缺数据」**。所以
          「合计 + 缺数据」才是那天被数据覆盖到的总时长。
          差在 15 分钟以内标成「≈24 小时」——一天十几万个窗口，
          四舍五入本身就能差出几分钟。
        </Text>
      </Modal>
    </>
  );
}
