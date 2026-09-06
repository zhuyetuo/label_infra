import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Collapse, Input, Modal, Popconfirm, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getImportScanStatus,
  startImportScan,
  listSamples,
  setSamplesSensitive,
  updateSample,
  type ScanProgress,
} from "@/api/samples";
import { listDogs } from "@/api/dogs";
import SamplePreviewModal from "@/components/SamplePreviewModal";
import type { Sample } from "@/types";

const statusColor: Record<Sample["import_status"], string> = {
  pending: "default",
  verified: "green",
  error: "red",
};

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${s}秒`;
}

export default function Samples() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
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

  const handleAssignDog = async (sample: Sample, dogId: number | null) => {
    await updateSample(sample.id, { dog_id: dogId });
    message.success(dogId == null ? "已取消关联" : "已关联");
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  // 敏感隐私：标了之后标注员/审核员在任何地方都看不到这些样本和上面的任务，
  // 只有管理员/超级管理员能看能标；确认不敏感了可以解除。支持勾选一批一起标。
  const [sensitiveFilter, setSensitiveFilter] = useState<"全部" | "仅敏感" | "仅非敏感">("全部");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [markOpen, setMarkOpen] = useState(false);
  const [markNote, setMarkNote] = useState("");
  const [marking, setMarking] = useState(false);

  const handleToggleSensitive = async (sample: Sample, on: boolean) => {
    await updateSample(sample.id, { is_sensitive: on });
    message.success(on ? "已标记为敏感，仅管理员可见" : "已解除敏感标记");
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  const applyBulk = async (on: boolean) => {
    if (selected.size === 0) return;
    setMarking(true);
    try {
      const r = await setSamplesSensitive([...selected], on, on ? markNote.trim() || null : null);
      message.success(on ? `已把 ${r.updated} 个样本标记为敏感` : `已解除 ${r.updated} 个样本的敏感标记`);
      setSelected(new Set());
      setMarkOpen(false);
      setMarkNote("");
      qc.invalidateQueries({ queryKey: ["samples"] });
    } finally {
      setMarking(false);
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", width: 80, sorter: (a: Sample, b: Sample) => a.id - b.id },
    {
      title: "样本编号",
      dataIndex: "sample_code",
      // 编号里带采集时间（multicam_日期_时分秒_imuN），按字符串排就是按采集时间排
      sorter: (a: Sample, b: Sample) => a.sample_code.localeCompare(b.sample_code),
      defaultSortOrder: "ascend" as const,
      render: (code: string, r: Sample) => (
        <Space size={4}>
          <span>{code}</span>
          {r.is_sensitive && (
            <Tooltip title={`含敏感隐私信息，仅管理员可见${r.sensitive_note ? `：${r.sensitive_note}` : ""}`}>
              <Tag color="red" icon={<LockOutlined />} style={{ marginRight: 0 }}>
                敏感
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "隐私",
      dataIndex: "is_sensitive",
      width: 90,
      sorter: (a: Sample, b: Sample) => Number(a.is_sensitive) - Number(b.is_sensitive),
      render: (on: boolean, r: Sample) => (
        <Tooltip title={on ? "点击解除：其他人重新可见" : "点击标记：只有管理员/超级管理员能看能标"}>
          <Switch size="small" checked={on} onChange={(v) => handleToggleSensitive(r, v)} checkedChildren="敏感" unCheckedChildren="公开" />
        </Tooltip>
      ),
    },
    {
      title: "状态",
      dataIndex: "import_status",
      sorter: (a: Sample, b: Sample) => a.import_status.localeCompare(b.import_status),
      render: (s: Sample["import_status"]) => <Tag color={statusColor[s]}>{s}</Tag>,
    },
    {
      title: "所属狗",
      dataIndex: "dog_id",
      width: 160,
      // 没关联的排最后，关联了的按狗编号
      sorter: (a: Sample, b: Sample) => {
        const na = dogs?.find((d) => d.id === a.dog_id)?.dog_code ?? "￿";
        const nb = dogs?.find((d) => d.id === b.dog_id)?.dog_code ?? "￿";
        return na.localeCompare(nb, undefined, { numeric: true });
      },
      // 采集端文件名还没带 dog 编号之前，只能靠这里手动关联；等以后文件名
      // 自动带出来了，这里照样能用来改关联
      render: (dogId: number | null, record: Sample) => (
        <Select
          size="small"
          allowClear
          placeholder="未关联"
          style={{ width: 140 }}
          value={dogId ?? undefined}
          options={dogs?.map((d) => ({ value: d.id, label: d.name ? `${d.dog_code}（${d.name}）` : d.dog_code }))}
          onChange={(v) => handleAssignDog(record, v ?? null)}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    { title: "时长(秒)", dataIndex: "video_duration_sec", sorter: (a: Sample, b: Sample) => (a.video_duration_sec ?? 0) - (b.video_duration_sec ?? 0) },
    { title: "CSV行数", dataIndex: "imu_row_count", sorter: (a: Sample, b: Sample) => (a.imu_row_count ?? 0) - (b.imu_row_count ?? 0), render: (n: number | null) => n ?? "-" },
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

  const sensitiveCount = useMemo(() => (data ?? []).filter((s) => s.is_sensitive).length, [data]);

  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of data ?? []) {
      if (sensitiveFilter === "仅敏感" && !s.is_sensitive) continue;
      if (sensitiveFilter === "仅非敏感" && s.is_sensitive) continue;
      const key = s.session_date ?? "未知日期";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data, sensitiveFilter]);

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

      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          options={["全部", "仅敏感", "仅非敏感"]}
          value={sensitiveFilter}
          onChange={(v) => setSensitiveFilter(v as typeof sensitiveFilter)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          敏感样本 {sensitiveCount} 个：仅管理员/超级管理员可见可标，其他人在项目、任务、审核里都看不到
        </Typography.Text>
        {selected.size > 0 && (
          <>
            <Tag>已勾选 {selected.size}</Tag>
            <Button size="small" danger icon={<LockOutlined />} onClick={() => setMarkOpen(true)}>
              标记为敏感
            </Button>
            <Popconfirm title={`解除这 ${selected.size} 个样本的敏感标记？其他人将重新可见`} onConfirm={() => applyBulk(false)}>
              <Button size="small" loading={marking}>
                解除敏感
              </Button>
            </Popconfirm>
            <Button size="small" type="link" onClick={() => setSelected(new Set())}>
              取消勾选
            </Button>
          </>
        )}
      </Space>

      {progress && (progress.status === "running" || progress.status === "error") && (
        <div style={{ marginBottom: 16 }}>
          {progress.status === "running" && (
            <>
              <Progress
                percent={
                  progress.total_groups ? Math.round((progress.processed / progress.total_groups) * 100) : 0
                }
                status="active"
                format={() => `${progress.processed}/${progress.total_groups || "?"}`}
              />
              <Typography.Text type="secondary">
                已耗时 {formatDuration(progress.elapsed_sec)}
                {progress.estimated_remaining_sec != null &&
                  ` · 预计还需 ${formatDuration(progress.estimated_remaining_sec)}`}
              </Typography.Text>
            </>
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
                // 勾选跨日期分组共用一个集合，可以在几天里各挑几个一起标
                rowSelection={{
                  selectedRowKeys: samples.filter((s) => selected.has(s.id)).map((s) => s.id),
                  onChange: (_, rows) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      samples.forEach((s) => next.delete(s.id));
                      rows.forEach((s) => next.add(s.id));
                      return next;
                    });
                  },
                }}
              />
            ),
          }))}
        />
      )}

      <Modal
        title={`标记 ${selected.size} 个样本为敏感`}
        open={markOpen}
        onCancel={() => setMarkOpen(false)}
        onOk={() => applyBulk(true)}
        okText="标记"
        okButtonProps={{ danger: true }}
        confirmLoading={marking}
        destroyOnClose
      >
        <Typography.Paragraph>
          标记后标注员/审核员在项目、任务、审核、视频、IMU 任何入口都看不到这些样本；已经认领的任务也会从他们列表里消失。
          只有管理员/超级管理员能看能标。之后确认不敏感可以随时解除。
        </Typography.Paragraph>
        <Input
          placeholder="备注（可选）：为什么敏感，比如「画面里有人脸」"
          maxLength={200}
          value={markNote}
          onChange={(e) => setMarkNote(e.target.value)}
        />
      </Modal>

      <SamplePreviewModal
        sampleId={preview?.id ?? null}
        sampleCode={preview?.sample_code}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
