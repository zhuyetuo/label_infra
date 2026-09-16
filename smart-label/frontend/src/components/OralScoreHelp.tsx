import { useState } from "react";
import { Modal, Table, Typography, Alert } from "antd";

import type { VisionScoreScheme } from "../api/vision";

/**
 * 口腔评估怎么打分的说明。问号点开，不占标注面板的地方。
 *
 * 表格**从 score_scheme 渲染**，不在这儿抄一遍那些数字——抄一遍的话调了权重
 * 之后说明里还是老的，而标注员照着说明填，填出来的分和后端算的对不上。
 */
export default function OralScoreHelp({ scheme }: { scheme: VisionScoreScheme }) {
  const [open, setOpen] = useState(false);

  // 档位数最多的那一项决定列数（牙龈发红只有 3 档，另两项 4 档）
  const nCols = Math.max(...scheme.items.map((i) => i.points.length));

  return (
    <>
      <span
        style={{ marginLeft: 6, cursor: "help", borderBottom: "1px dotted #aaa", fontSize: 12 }}
        onClick={() => setOpen(true)}
      >
        ?
      </span>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={620}
        title={`${scheme.name}：怎么打分`}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          三项各选一档，档位前面的数字就是分值，相加就是总分（满分 {scheme.max}）。
        </Typography.Paragraph>

        <Table
          size="small"
          pagination={false}
          bordered
          rowKey="key"
          dataSource={scheme.items}
          columns={[
            { title: "项", dataIndex: "name", width: 100 },
            ...Array.from({ length: nCols }, (_, i) => ({
              title: `档 ${i + 1}`,
              key: `p${i}`,
              render: (_: unknown, r: { points: number[] }) =>
                r.points[i] === undefined ? "—" : `${r.points[i]} 分`,
            })),
          ]}
        />

        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 14 }}
          message="三项没填全就没有总分"
          description="漏填一项而总分照给的话，一条「20 分」会盖住一张其实没看牙结石的照片——漏填和「确实是 0」在总分上长得一模一样。所以没填全的时候列表里显示「未评」，不是 0 分。"
        />

        {scheme.note && (
          <Alert type="info" showIcon style={{ marginTop: 10 }}
            message="为什么没有分期（牙周炎 I–IV 期）" description={scheme.note} />
        )}

        {scheme.todo && (
          <Alert type="info" showIcon style={{ marginTop: 10 }}
            message="还没做的另一套：CI/GI 指数" description={scheme.todo} />
        )}
      </Modal>
    </>
  );
}
