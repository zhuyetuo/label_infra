import { useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Col, DatePicker, Input, InputNumber, Modal, Popconfirm, Radio, Row, Select, Space, Statistic,
  Table, Tag, Tooltip, Typography, message,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";
import { listDogs } from "@/api/dogs";
import { poolAdd, poolRemove, poolSummary, type PoolBucket } from "@/api/dataPool";
import { exportDataset, type TrainDataset } from "@/api/training";
import { useAuthStore } from "@/stores/authStore";

/**
 * 数据池：人认可的高质量片段库（跟「导出数据集」不是一回事）。
 * 片段审核里点了通过的自动在池里；另外可以整批手动加入 / 移出。
 * 每次训练从池里按 项目 / 狗 / 日期 / 采样率 / 类别 挑一部分，每类可设上限，
 * 导出后直接打开训练弹窗——类别合并在弹窗的归并表里做。
 */
export default function DataPoolPanel({ onTrain }: { onTrain: (ds: TrainDataset) => void }) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const curator = role === "admin" || role === "super_admin" || role === "reviewer";

  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [dogIds, setDogIds] = useState<number[]>([]);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [hzs, setHzs] = useState<number[]>([]);

  const filters = useMemo(
    () => ({
      project_ids: projectIds.length ? projectIds : undefined,
      dog_ids: dogIds.length ? dogIds : undefined,
      date_from: range?.[0]?.format("YYYY-MM-DD") ?? null,
      date_to: range?.[1]?.format("YYYY-MM-DD") ?? null,
    }),
    [projectIds, dogIds, range],
  );
  const anyFilter = !!(filters.project_ids || filters.dog_ids || filters.date_from || filters.date_to);

  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const { data: sum, isFetching } = useQuery({
    queryKey: ["data-pool", filters, hzs],
    queryFn: () => poolSummary({ ...filters, sample_hz: hzs.length ? hzs : undefined }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["data-pool"] });

  // 整批加入
  const [addSrc, setAddSrc] = useState<"reviewed" | "approved_tasks">("reviewed");
  const [busy, setBusy] = useState(false);
  const doAdd = async () => {
    setBusy(true);
    try {
      const r = await poolAdd({ ...filters, source: addSrc });
      message.success(`加入 ${r.added} 段`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // 挑类别：移出 / 训练共用
  const [pickLabels, setPickLabels] = useState<string[]>([]);
  const labelOpts = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const b of [...(sum?.by_root ?? []), ...(sum?.by_label ?? [])]) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      out.push({ value: b.name, label: `${b.name}（${b.n} 段 / ${b.hours} h）` });
    }
    return out;
  }, [sum]);

  // 「用这批训练」
  const [trainOpen, setTrainOpen] = useState(false);
  const [dsName, setDsName] = useState("");
  const [capH, setCapH] = useState<number | null>(null);
  const [preview, setPreview] = useState<TrainDataset | null>(null);

  const exportBody = (dry: boolean) => {
    const roots = (sum?.by_root ?? []).filter((b) => !pickLabels.length || pickLabels.includes(b.name));
    const reduce_targets =
      capH != null && capH > 0
        ? Object.fromEntries(roots.filter((b) => b.hours > capH).map((b) => [b.name, Math.round(capH * 3600)]))
        : undefined;
    return {
      name: dsName.trim(),
      scope: "pool" as const,
      ...filters,
      sample_hz: hzs.length ? hzs : undefined,
      label_names: pickLabels.length ? pickLabels : undefined,
      reduce_targets: reduce_targets && Object.keys(reduce_targets).length ? reduce_targets : undefined,
      dry_run: dry,
    };
  };
  const doPreview = async () => {
    if (!dsName.trim()) return message.warning("先起个数据集名字");
    setBusy(true);
    try {
      setPreview(await exportDataset(exportBody(true)));
    } finally {
      setBusy(false);
    }
  };
  const doExport = async () => {
    if (!dsName.trim()) return message.warning("先起个数据集名字");
    setBusy(true);
    try {
      const ds = await exportDataset(exportBody(false));
      await qc.invalidateQueries({ queryKey: ["train-datasets"] });
      message.success(`已导出 ${ds.name}：${ds.n_segments} 段 / ${ds.total_hours} h`);
      setTrainOpen(false);
      setPreview(null);
      onTrain(ds);
    } finally {
      setBusy(false);
    }
  };

  const bucketTable = (title: string, rows: PoolBucket[] | undefined) => (
    <Table
      size="small"
      rowKey="name"
      title={() => <strong>{title}</strong>}
      dataSource={rows ?? []}
      pagination={false}
      scroll={{ y: 260 }}
      columns={[
        { title: "名称", dataIndex: "name" },
        { title: "段数", dataIndex: "n", width: 80, sorter: (a: PoolBucket, b: PoolBucket) => a.n - b.n },
        { title: "小时", dataIndex: "hours", width: 80, sorter: (a: PoolBucket, b: PoolBucket) => a.hours - b.hours },
      ]}
    />
  );

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="数据池 = 你认可的高质量片段库"
        description="片段审核里「通过」的自动在池里；也可以按当前筛选整批加入 / 移出。片段被改过后，手动加入的会自动出池等重新审。训练时从池里按下面的条件挑一部分，「用这批训练」导出后直接打开训练弹窗（类别合并在弹窗的归并表里做）。"
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          allowClear
          placeholder="项目（默认全部进行中的）"
          style={{ minWidth: 240 }}
          value={projectIds}
          onChange={setProjectIds}
          optionFilterProp="label"
          options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="狗"
          style={{ minWidth: 200 }}
          value={dogIds}
          onChange={setDogIds}
          optionFilterProp="label"
          options={(dogs ?? []).map((d) => ({ value: d.id, label: d.name ? `${d.dog_code} ${d.name}` : d.dog_code }))}
        />
        <DatePicker.RangePicker
          value={range as [Dayjs, Dayjs] | null}
          onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
          presets={[
            { label: "最近 30 天", value: [dayjs().subtract(30, "day"), dayjs()] },
            { label: "最近 90 天", value: [dayjs().subtract(90, "day"), dayjs()] },
          ]}
        />
        <span>
          原始采样率：
          <Checkbox.Group
            value={hzs}
            onChange={(v) => setHzs(v as number[])}
            options={[
              { value: 50, label: "50Hz" },
              { value: 16, label: "16Hz" },
            ]}
          />
        </span>
      </Space>

      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Statistic title="池里片段" value={sum?.n ?? 0} loading={isFetching} /></Col>
        <Col><Statistic title="时长(小时)" value={sum?.hours ?? 0} loading={isFetching} /></Col>
        <Col><Statistic title="审核通过进来的" value={sum?.n_approved ?? 0} loading={isFetching} /></Col>
        <Col><Statistic title="手动加入的" value={sum?.n_manual ?? 0} loading={isFetching} /></Col>
      </Row>

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          allowClear
          placeholder="类别（训练 / 移出用；不选 = 全部）"
          style={{ minWidth: 360 }}
          value={pickLabels}
          onChange={setPickLabels}
          options={labelOpts}
        />
        <Button type="primary" disabled={!sum?.n} onClick={() => setTrainOpen(true)}>
          用这批训练
        </Button>
        {curator && (
          <>
            <Radio.Group size="small" value={addSrc} onChange={(e) => setAddSrc(e.target.value)}>
              <Tooltip title="人确认过 / 改过 / 人工画的片段（没人看过的 AI 片段不算）">
                <Radio.Button value="reviewed">人确认过的片段</Radio.Button>
              </Tooltip>
              <Tooltip title="整份审核通过的任务里的全部片段">
                <Radio.Button value="approved_tasks">审核通过的任务</Radio.Button>
              </Tooltip>
            </Radio.Group>
            <Tooltip title={anyFilter ? "" : "先选项目 / 狗 / 日期，避免一下把全部加进来"}>
              <Popconfirm title="按当前筛选整批加入数据池？" onConfirm={doAdd} disabled={!anyFilter}>
                <Button loading={busy} disabled={!anyFilter}>整批加入</Button>
              </Popconfirm>
            </Tooltip>
            <Popconfirm
              title={`按当前筛选${pickLabels.length ? `、只移出 ${pickLabels.join("/")}` : "整批"}移出数据池？`}
              description="移出后再在片段审核里通过一次会重新进池"
              disabled={!anyFilter && !pickLabels.length}
              onConfirm={async () => {
                setBusy(true);
                try {
                  const r = await poolRemove({ ...filters, label_names: pickLabels.length ? pickLabels : undefined });
                  message.success(`移出 ${r.removed} 段`);
                  refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Button danger loading={busy} disabled={!anyFilter && !pickLabels.length}>整批移出</Button>
            </Popconfirm>
          </>
        )}
      </Space>

      <Row gutter={16}>
        <Col span={12}>{bucketTable("按大类", sum?.by_root)}</Col>
        <Col span={12}>{bucketTable("按细类", sum?.by_label)}</Col>
        <Col span={8} style={{ marginTop: 12 }}>{bucketTable("按项目", sum?.by_project)}</Col>
        <Col span={8} style={{ marginTop: 12 }}>{bucketTable("按狗", sum?.by_dog)}</Col>
        <Col span={8} style={{ marginTop: 12 }}>{bucketTable("按采样率", sum?.by_hz)}</Col>
      </Row>

      <Modal
        title="用这批训练"
        open={trainOpen}
        onCancel={() => { setTrainOpen(false); setPreview(null); }}
        footer={[
          <Button key="p" loading={busy} onClick={doPreview}>预览</Button>,
          <Button key="ok" type="primary" loading={busy} onClick={doExport}>导出并打开训练</Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            范围：{projectIds.length ? `${projectIds.length} 个项目` : "全部进行中的项目"}
            {dogIds.length ? `、${dogIds.length} 只狗` : ""}
            {filters.date_from ? `、${filters.date_from}~${filters.date_to}` : ""}
            {hzs.length ? `、${hzs.join("/")}Hz` : ""}
            ；类别：{pickLabels.length ? pickLabels.join("、") : "全部"}
          </Typography.Text>
          <Input placeholder="数据集名字，如 pool_1102" value={dsName} onChange={(e) => setDsName(e.target.value)} />
          <span>
            每个大类最多{" "}
            <InputNumber min={0} step={0.5} value={capH} onChange={(v) => setCapH(v)} placeholder="不限" /> 小时
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              超出的按段随机抽到这个量
            </Typography.Text>
          </span>
          {preview && (
            <Alert
              type="success"
              message={`预览：${preview.n_segments} 段 / ${preview.total_hours} h`}
              description={
                <Space size={4} wrap>
                  {Object.entries(preview.labels ?? {}).map(([k, v]) => (
                    <Tag key={k}>{k} {String(v)}</Tag>
                  ))}
                </Space>
              }
            />
          )}
        </Space>
      </Modal>
    </div>
  );
}
