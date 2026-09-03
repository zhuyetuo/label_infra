import { useEffect, useState } from "react";
import { Table, Spin, Typography } from "antd";
import request from "@/utils/request";

interface ImuRows {
  total: number;
  t: number[];
  acc_x: (number | null)[];
  acc_y: (number | null)[];
  acc_z: (number | null)[];
  gyro_x: (number | null)[];
  gyro_y: (number | null)[];
  gyro_z: (number | null)[];
}

interface ImuMeta {
  start_timestamp: string | null;
}

interface Row {
  key: number;
  timestamp: string;
  acc_x: number | null;
  acc_y: number | null;
  acc_z: number | null;
  gyro_x: number | null;
  gyro_y: number | null;
  gyro_z: number | null;
}

const getMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
const getRows = (sampleId: number, offset: number, limit: number) =>
  request.get<never, ImuRows>(`/imu/${sampleId}/rows`, { params: { offset, limit } });

function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const columns = [
  { title: "#", dataIndex: "key", width: 80 },
  { title: "时间戳", dataIndex: "timestamp", width: 200 },
  { title: "acc_x", dataIndex: "acc_x" },
  { title: "acc_y", dataIndex: "acc_y" },
  { title: "acc_z", dataIndex: "acc_z" },
  { title: "gyro_x", dataIndex: "gyro_x" },
  { title: "gyro_y", dataIndex: "gyro_y" },
  { title: "gyro_z", dataIndex: "gyro_z" },
];

interface Props {
  sampleId: number;
}

// 逐行原始记录，翻页向后端要那一页的数据——跟曲线图用的降采样接口是两回事，
// 这里看到的就是 CSV 里原样的每一行，不是挑出来的"代表性的点"。
export default function ImuTable({ sampleId }: Props) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    // 换样本时翻页状态重置，不然上次翻到第 30 页这次直接空掉
    setPage(1);
  }, [sampleId]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    (async () => {
      const [m, r] = await Promise.all([getMeta(sampleId), getRows(sampleId, (page - 1) * pageSize, pageSize)]);
      if (disposed) return;
      const startEpochMs = m.start_timestamp ? new Date(m.start_timestamp).getTime() : 0;
      const offset = (page - 1) * pageSize;
      setTotal(r.total);
      setRows(
        r.t.map((ms, i) => ({
          key: offset + i + 1,
          timestamp: formatTimestamp(startEpochMs + ms),
          acc_x: r.acc_x[i],
          acc_y: r.acc_y[i],
          acc_z: r.acc_z[i],
          gyro_x: r.gyro_x[i],
          gyro_y: r.gyro_y[i],
          gyro_z: r.gyro_z[i],
        }))
      );
      setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [sampleId, page, pageSize]);

  return (
    <Spin spinning={loading}>
      <Typography.Text type="secondary">共 {total} 行原始数据，跟曲线图不是同一份（曲线图为了流畅做了降采样）</Typography.Text>
      <Table
        size="small"
        rowKey="key"
        dataSource={rows}
        columns={columns}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200],
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        scroll={{ y: 400 }}
        style={{ marginTop: 8 }}
      />
    </Spin>
  );
}
