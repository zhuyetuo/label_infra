import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Collapse, Progress, Space, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getImportScanStatus, startImportScan, listSamples, type ScanProgress } from "@/api/samples";
import SamplePreviewModal from "@/components/SamplePreviewModal";
import type { Sample } from "@/types";

const statusColor: Record<Sample["import_status"], string> = {
  pending: "default",
  verified: "green",
  error: "red",
};

export default function Samples() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [preview, setPreview] = useState<Sample | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const p = await getImportScanStatus();
      setProgress(p);
      if (p.status === "done" || p.status === "error") {
        stopPolling();
        if (p.status === "done") {
          message.success(`扫描完成：新增 ${p.created}，跳过已存在 ${p.skipped_existing}，出错 ${p.errors}`);
        } else {
          message.error(`扫描出错：${p.error_message}`);
        }
        qc.invalidateQueries({ queryKey: ["samples"] });
      }
    }, 1000);
  };

  useEffect(() => stopPolling, []);

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
    {
      title: "操作",
      render: (_: unknown, record: Sample) => (
        <Button size="small" type="link" onClick={() => setPreview(record)}>
          预览
        </Button>
      ),
    },
  ];

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
    const result = await startImportScan();
    if (result.already_running) {
      message.info("已经有一个扫描在后台跑了，直接看进度");
    }
    startPolling();
  };

  const isRunning = progress?.status === "running";

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={handleScan} disabled={isRunning}>
          立即扫描一次
        </Button>
        <Button onClick={() => refetch()}>刷新列表</Button>
        <Typography.Text type="secondary">系统每 10 分钟自动扫描一次新数据，通常不用手动点</Typography.Text>
      </Space>

      {progress && (progress.status === "running" || progress.status === "error") && (
        <div style={{ marginBottom: 16 }}>
          {progress.status === "running" && (
            <Progress
              percent={
                progress.total_groups ? Math.round((progress.processed / progress.total_groups) * 100) : 0
              }
              status="active"
              format={() => `${progress.processed}/${progress.total_groups || "?"}`}
            />
          )}
          {progress.status === "error" && (
            <Alert type="error" message="扫描出错" description={progress.error_message} showIcon />
          )}
        </div>
      )}

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

      <SamplePreviewModal
        sampleId={preview?.id ?? null}
        sampleCode={preview?.sample_code}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
