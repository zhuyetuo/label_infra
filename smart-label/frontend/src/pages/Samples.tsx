import { Button, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { importScan, listSamples } from "@/api/samples";
import type { Sample } from "@/types";

const statusColor: Record<Sample["import_status"], string> = {
  pending: "default",
  verified: "green",
  error: "red",
};

export default function Samples() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["samples"], queryFn: listSamples });

  const handleScan = async () => {
    const result = await importScan();
    message.success(`扫描完成：新增 ${result.created}，跳过已存在 ${result.skipped_existing}，出错 ${result.errors}`);
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={handleScan}>
          扫描 NAS data_raw/ 导入新样本
        </Button>
        <Button onClick={() => refetch()}>刷新</Button>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
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
        ]}
      />
    </div>
  );
}
