import { useMemo, useState } from "react";
import { Button, Collapse, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { importScan, listSamples } from "@/api/samples";
import type { Sample } from "@/types";

const statusColor: Record<Sample["import_status"], string> = {
  pending: "default",
  verified: "green",
  error: "red",
};

const columns = [
  { title: "ID", dataIndex: "id", width: 60 },
  { title: "样本编号", dataIndex: "sample_code" },
  {
    title: "状态",
    dataIndex: "import_status",
    render: (s: Sample["import_status"]) => <Tag color={statusColor[s]}>{s}</Tag>,
  },
  { title: "时长(秒)", dataIndex: "video_duration_sec" },
  { title: "分辨率", dataIndex: "video_resolution" },
  { title: "错误信息", dataIndex: "import_error" },
];

export default function Samples() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const [scanning, setScanning] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of data ?? []) {
      const key = s.session_date ?? "未知日期";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data]);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await importScan();
      message.success(
        `扫描完成：新增 ${result.created}，跳过已存在 ${result.skipped_existing}，出错 ${result.errors}`
      );
      if (result.detail.length) {
        console.warn("扫描详情：", result.detail);
      }
      qc.invalidateQueries({ queryKey: ["samples"] });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={handleScan} loading={scanning}>
          扫描 NAS data_raw/ 导入新样本
        </Button>
        <Button onClick={() => refetch()}>刷新</Button>
      </Space>

      {isLoading ? (
        <Table loading rowKey="id" columns={columns} dataSource={[]} />
      ) : (
        <Collapse
          items={groups.map(([dateKey, samples]) => ({
            key: dateKey,
            label: `${dateKey}（${samples.length} 个样本）`,
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={samples}
                pagination={samples.length > 20 ? { pageSize: 20 } : false}
                columns={columns}
              />
            ),
          }))}
        />
      )}
    </div>
  );
}
