import { useEffect, useState } from "react";
import { Table, Spin, Typography } from "antd";
import request from "@/utils/request";

interface ImuMeta {
  duration_ms: number;
  row_count: number;
  sample_rate_hz: number | null;
  start_timestamp: string | null;
}

interface ImuSeries {
  t: number[];
  acc_x: number[];
  acc_y: number[];
  acc_z: number[];
  gyro_x: number[];
  gyro_y: number[];
  gyro_z: number[];
}

interface Row {
  key: number;
  timestamp: string;
  acc_x: number;
  acc_y: number;
  acc_z: number;
  gyro_x: number;
  gyro_y: number;
  gyro_z: number;
}

const getMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
const getSeries = (sampleId: number, startMs: number, endMs: number, maxPoints: number) =>
  request.get<never, ImuSeries>(`/imu/${sampleId}/series`, {
    params: { start_ms: startMs, end_ms: endMs, max_points: maxPoints },
  });

function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const columns = [
  { title: "#", dataIndex: "key", width: 60 },
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

// 表格展示的是跟曲线图同一份降采样数据（避免几十万行原始数据把浏览器卡死），
// 数据量大的样本里这已经是LTTB挑出来的"有代表性的点"，不是完整原始行；
// 后续如果需要看某一小段的逐行原始数据，可以在此基础上加"框选后按此区间放大取样"。
export default function ImuTable({ sampleId }: Props) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState<ImuMeta | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    (async () => {
      const m = await getMeta(sampleId);
      if (disposed) return;
      setMeta(m);
      const startEpochMs = m.start_timestamp ? new Date(m.start_timestamp).getTime() : 0;
      const s = await getSeries(sampleId, 0, m.duration_ms, 5000);
      if (disposed) return;
      setRows(
        s.t.map((ms, i) => ({
          key: i,
          timestamp: formatTimestamp(startEpochMs + ms),
          acc_x: s.acc_x[i],
          acc_y: s.acc_y[i],
          acc_z: s.acc_z[i],
          gyro_x: s.gyro_x[i],
          gyro_y: s.gyro_y[i],
          gyro_z: s.gyro_z[i],
        }))
      );
      setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [sampleId]);

  return (
    <Spin spinning={loading}>
      {meta && (
        <Typography.Text type="secondary">
          原始共 {meta.row_count} 行，采样率约 {meta.sample_rate_hz ?? "?"}Hz，下表展示降采样后的 {rows.length}{" "}
          个代表性数据点（跟曲线图同一份数据，不是逐行原始记录）
        </Typography.Text>
      )}
      <Table
        size="small"
        rowKey="key"
        dataSource={rows}
        columns={columns}
        pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 200] }}
        scroll={{ y: 400 }}
        style={{ marginTop: 8 }}
      />
    </Spin>
  );
}
