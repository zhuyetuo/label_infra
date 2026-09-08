import { useEffect, useState } from "react";
import {
  Alert, Button, Checkbox, DatePicker, Descriptions, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs,
  Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";
import ModelCompare from "@/components/ModelCompare";
import {
  type DatasetCheck,
  checkDataset,
  type DatasetSegment,
  getDatasetSegments,
  deleteDataset,
  activateModel, exportDataset, listDatasets, listModelVersions, refreshModelVersion, submitTrain,
  type ModelVersion, type TrainDataset,
} from "@/api/training";

/**
 * 模型训练：把「审核通过的标注」导成数据集 → 提交给 imu_train 的 label_service 训练
 * → 训练完启用新模型。整个 AI 辅助标注闭环的最后一环：AI 预标注 → 人工确认/纠正 +
 * 疑似片段确认 → 导出 → 重训 → 启用 → 下一轮预标注更准。
 */

const STATUS_META: Record<ModelVersion["status"], { color: string; label: string }> = {
  queued: { color: "default", label: "排队中" },
  running: { color: "processing", label: "训练中" },
  done: { color: "success", label: "已完成" },
  failed: { color: "error", label: "失败" },
};

const MODEL_TYPES = ["rf", "xgb", "lgbm", "catboost", "extratrees", "histgb"];

export default function Training() {
  const qc = useQueryClient();
  const { data: datasets, isLoading: loadingDs } = useQuery({ queryKey: ["train-datasets"], queryFn: listDatasets });
  const { data: versions, isLoading: loadingV } = useQuery({
    queryKey: ["model-versions"],
    queryFn: listModelVersions,
    // 有任务在跑就 10 秒刷一次
    refetchInterval: (q) =>
      (q.state.data ?? []).some((v: ModelVersion) => v.status === "queued" || v.status === "running") ? 10_000 : false,
  });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const [exportOpen, setExportOpen] = useState(false);
  const [name, setName] = useState("");
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(30, "day"), dayjs()]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [includeSubmitted, setIncludeSubmitted] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [trainFor, setTrainFor] = useState<TrainDataset | null>(null);
  const [modelType, setModelType] = useState("rf");
  const [sourceHz, setSourceHz] = useState<number>(50);
  const [hz, setHz] = useState<number>(16);
  const [skipSyn, setSkipSyn] = useState(false);
  const [tag, setTag] = useState("");
  const [scope, setScope] = useState<"approved" | "reviewed">("approved");
  const [submitting, setSubmitting] = useState(false);
  // 导出完最想知道的是"到底进去了什么、什么被跳过了"。这些数都在 meta.json 里，
  // 之前只是没地方看——尤其是 warnings，哪个任务因为什么被跳过全写在里面
  const [dsDetail, setDsDetail] = useState<TrainDataset | null>(null);
  // 换一份数据集看，上一份的体检结果不能留着——数字对不上人会当成这一份的

  // 片段明细按需拉：一份数据集几千段，跟列表一起拉没必要
  const { data: dsSegs, isFetching: loadingSegs } = useQuery({
    queryKey: ["dataset-segments", dsDetail?.name],
    queryFn: () => getDatasetSegments(dsDetail!.name),
    enabled: dsDetail != null,
  });
  const [segLabel, setSegLabel] = useState<string | null>(null);
  // 体检要扫全量片段做两两比对，比列明细贵，所以点了才跑
  const [checking, setChecking] = useState(false);
  const [checkRes, setCheckRes] = useState<DatasetCheck | null>(null);
  const runCheck = async (n: string) => {
    setChecking(true);
    try {
      setCheckRes(await checkDataset(n));
    } finally {
      setChecking(false);
    }
  };
  const [detail, setDetail] = useState<ModelVersion | null>(null);

  useEffect(() => {
    if (exportOpen && !name) setName(`ds_${dayjs().format("YYYYMMDD_HHmm")}`);
  }, [exportOpen, name]);

  const doExport = async () => {
    setExporting(true);
    try {
      const meta = await exportDataset({
        name: name.trim(),
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        project_id: projectId,
        include_submitted: includeSubmitted,
        scope,
      });
      message.success(
        `已导出：${meta.n_tasks} 个任务 / ${meta.n_segments} 段 / ${meta.total_hours} 小时` +
          (meta.n_untouched_skipped ? `（跳过 ${meta.n_untouched_skipped} 条没人看过的 AI 片段）` : "")
      );
      setExportOpen(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["train-datasets"] });
    } finally {
      setExporting(false);
    }
  };

  const doTrain = async () => {
    if (!trainFor) return;
    setSubmitting(true);
    try {
      await submitTrain({
        dataset: {
          date: trainFor.name,
          export_json: trainFor.export_json,
          source_hz: sourceHz,
          hz,
          skip_syn: skipSyn,
          clean: true,
        },
        model_type: modelType,
        tag: tag.trim() || null,
      });
      message.success("已提交训练，进度在下面的「训练记录」里看（训练要跑一段时间）");
      setTrainFor(null);
      setTag("");
      qc.invalidateQueries({ queryKey: ["model-versions"] });
    } finally {
      setSubmitting(false);
    }
  };

  const metricsOf = (v: ModelVersion) => {
    if (!v.metrics) return null;
    try {
      return JSON.parse(v.metrics) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const f1Of = (v: ModelVersion) => {
    const m = metricsOf(v);
    if (!m) return null;
    const f1 = (m.f1_macro ?? m.macro_f1 ?? m.f1) as number | undefined;
    return typeof f1 === "number" ? f1 : null;
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="AI 辅助标注闭环"
        description="AI 预标注（稳定版）→ 人工在工作台确认/纠正片段、逐条处理「疑似抓挠」→ 这里把审核通过的标注导成数据集 → 提交训练 → 训练完「启用」，下一轮预标注就用新模型。"
      />
      <Tabs
        items={[
          {
            key: "cmp",
            label: "模型对比",
            children: <ModelCompare />,
          },
          {
            key: "ds",
            label: "训练数据集",
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" onClick={() => setExportOpen(true)}>
                    导出新数据集
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    导出到 NAS 的 data_train/&lt;名字&gt;/。可以只用审核通过的任务，也可以按片段取——
                    只要人碰过的（审了一半的任务也能用）。
                  </Typography.Text>
                </Space>
                <Table
                  rowKey="name"
                  size="small"
                  loading={loadingDs}
                  dataSource={datasets ?? []}
                  pagination={false}
                  scroll={{ x: "max-content" }}
                  columns={[
                    { title: "数据集", dataIndex: "name", render: (n: string) => <strong>{n}</strong> },
                    {
                      title: "范围",
                      render: (_, d: TrainDataset) => (
                        <span>
                          {d.date_from} ~ {d.date_to}
                          {d.include_submitted && <Tag color="orange" style={{ marginLeft: 4 }}>含待审核</Tag>}
                          {d.scope === "reviewed" && (
                            <Tooltip title="按片段取的：只包含人确认过/改过/人工加的片段，没人看过的 AI 片段没有导出">
                              <Tag color="blue" style={{ marginLeft: 4 }}>按片段</Tag>
                            </Tooltip>
                          )}
                        </span>
                      ),
                    },
                    { title: "任务", dataIndex: "n_tasks", width: 80 },
                    { title: "片段", dataIndex: "n_segments", width: 90 },
                    { title: "时长(小时)", dataIndex: "total_hours", width: 100 },
                    {
                      title: "各类别段数",
                      render: (_, d: TrainDataset) => (
                        <Space size={4} wrap>
                          {Object.entries(d.labels).map(([k, v]) => (
                            <Tag key={k}>{k} {v}</Tag>
                          ))}
                        </Space>
                      ),
                    },
                    { title: "导出时间", dataIndex: "exported_at", width: 160 },
                    {
                      title: "操作",
                      width: 200,
                      render: (_, d: TrainDataset) => (
                        <Space size={0}>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => {
                              setCheckRes(null);
                              setSegLabel(null);
                              setDsDetail(d);
                            }}
                          >
                            详情
                          </Button>
                          <Button size="small" type="link" onClick={() => setTrainFor(d)}>
                            用它训练
                          </Button>
                          <Popconfirm
                            title={`删除数据集「${d.name}」？`}
                            description="删的是 NAS 上这份导出；已经用它训过的模型和训练记录都不受影响"
                            okButtonProps={{ danger: true }}
                            onConfirm={async () => {
                              await deleteDataset(d.name);
                              message.success("已删除");
                              qc.invalidateQueries({ queryKey: ["train-datasets"] });
                            }}
                          >
                            <Button size="small" type="link" danger>
                              删除
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "runs",
            label: "训练记录",
            children: (
              <Table
                rowKey="id"
                size="small"
                loading={loadingV}
                dataSource={versions ?? []}
                pagination={{ pageSize: 20 }}
                scroll={{ x: "max-content" }}
                columns={[
                  { title: "ID", dataIndex: "id", width: 60 },
                  {
                    title: "状态",
                    width: 100,
                    render: (_, v: ModelVersion) => (
                      <Tag color={STATUS_META[v.status].color}>{STATUS_META[v.status].label}</Tag>
                    ),
                  },
                  { title: "模型", dataIndex: "model_type", width: 90 },
                  { title: "版本/标签", dataIndex: "model_version", width: 160, render: (v: string | null) => v || "-" },
                  {
                    title: "数据集",
                    render: (_, v: ModelVersion) => {
                      try {
                        return (JSON.parse(v.dataset_spec) as { date?: string }).date ?? "-";
                      } catch {
                        return "-";
                      }
                    },
                  },
                  {
                    title: "F1",
                    width: 80,
                    render: (_, v: ModelVersion) => {
                      const f1 = f1Of(v);
                      return f1 != null ? f1.toFixed(3) : "-";
                    },
                  },
                  {
                    title: "提交时间",
                    dataIndex: "created_at",
                    width: 160,
                    render: (v: string) => v?.replace("T", " ").slice(0, 19),
                  },
                  {
                    title: "操作",
                    render: (_, v: ModelVersion) => (
                      <Space size={0}>
                        <Button size="small" type="link" onClick={() => setDetail(v)}>
                          详情
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          onClick={async () => {
                            await refreshModelVersion(v.id);
                            qc.invalidateQueries({ queryKey: ["model-versions"] });
                          }}
                        >
                          刷新
                        </Button>
                        {v.status === "done" && v.model_path && (
                          <Popconfirm
                            title="让 AI 服务改用这个模型？"
                            description="会重建推理进程池，正在跑的推理会中断；AI 服务重启后会回到配置里的默认模型"
                            onConfirm={async () => {
                              const r = await activateModel(v.id);
                              message.success(`已启用：${r.classes.join("/")}`);
                            }}
                          >
                            <Button size="small" type="link">
                              启用此模型
                            </Button>
                          </Popconfirm>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />

      <Modal
        title="导出训练数据集"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        onOk={doExport}
        okText="导出"
        confirmLoading={exporting}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            把这段日期里的标注导成训练数据。人工纠正过的 AI 片段、人工新增的、从「疑似抓挠」里确认或
            改成别的类别的，都算数；标了「待定」的和采集掉数据的时段会挖掉。下面选按什么范围取。
          </Typography.Paragraph>
          <Space>
            <Typography.Text>数据集名</Typography.Text>
            <Input
              style={{ width: 240 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="字母/数字/下划线"
            />
          </Space>
          <Space>
            <Typography.Text>日期范围</Typography.Text>
            <DatePicker.RangePicker
              value={range}
              onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
              allowClear={false}
            />
          </Space>
          <Space>
            <Typography.Text>项目</Typography.Text>
            <Select
              allowClear
              placeholder="全部项目"
              style={{ width: 220 }}
              value={projectId ?? undefined}
              onChange={(v) => setProjectId(v ?? null)}
              options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </Space>
          {/* 人工复看很费时间，实际总是"这个任务只审了抓挠""那个审了一半"。
              等整份审完再用，数据集永远攒不起来——所以给一个按片段取的口子 */}
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: "100%" }}>
            <Space direction="vertical" size={4}>
              <Radio value="approved">
                只用审核通过的任务（整份都算数）
              </Radio>
              <Radio value="reviewed">
                <Tooltip title="不看任务状态，只挑出人确认过 / 改过 / 人工加的片段（包括从「疑似抓挠」确认上来的）。没人看过的纯 AI 片段不导出——它只是模型自己的输出，拿去训练就是自我强化。那段时间也不会被当成负样本：导出格式只提取被标注的区间，没标注的时间根本不进数据集">
                  <span style={{ borderBottom: "1px dashed #bbb" }}>
                    按片段取：只要人碰过的（审了一半也能用）
                  </span>
                </Tooltip>
              </Radio>
            </Space>
          </Radio.Group>
          {scope === "approved" && (
            <Checkbox checked={includeSubmitted} onChange={(e) => setIncludeSubmitted(e.target.checked)}>
              把「待审核」的任务也算进去（还没人复核，质量没保证）
            </Checkbox>
          )}
        </Space>
      </Modal>

      <Modal
        title={`数据集详情 - ${dsDetail?.name ?? ""}`}
        open={dsDetail != null}
        onCancel={() => setDsDetail(null)}
        footer={null}
        width={980}
      >
        {dsDetail && (
          <>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="日期范围">
                {dsDetail.date_from} ~ {dsDetail.date_to}
              </Descriptions.Item>
              <Descriptions.Item label="取法">
                {dsDetail.scope === "reviewed" ? "按片段取（只要人碰过的）" : "只用审核通过的任务"}
              </Descriptions.Item>
              <Descriptions.Item label="任务 / 片段">
                {dsDetail.n_tasks} / {dsDetail.n_segments}
              </Descriptions.Item>
              <Descriptions.Item label="总时长">{dsDetail.total_hours} 小时</Descriptions.Item>
              {dsDetail.scope === "reviewed" && (
                <Descriptions.Item label="跳过没人看过的 AI 片段">
                  {dsDetail.n_untouched_skipped ?? 0} 条
                </Descriptions.Item>
              )}
              <Descriptions.Item label="待定挖掉">{dsDetail.n_uncertain_excluded ?? 0} 段</Descriptions.Item>
              <Descriptions.Item label="同类别重叠并掉">
                <Tooltip title="「疑似抓挠」补上来的段常跟已有 AI 段覆盖同一次动作，只是起止差几百毫秒。不并的话重叠那部分会被导两遍，等于偷偷加权">
                  <span style={{ cursor: "help" }}>{dsDetail.n_merged_overlaps ?? 0} 段</span>
                </Tooltip>
              </Descriptions.Item>
              <Descriptions.Item label="类别冲突">
                <Tooltip title="同一段时间标了两个类别（比如既是活动又是抓挠）。不能替人决定谁对，重叠那一小段已经从两边都挖掉了，各自剩下的部分照常用；下面「跳过的任务 / 提示」里逐条列了出来，回工作台改起止">
                  <span style={{ cursor: "help", color: dsDetail.n_label_conflicts ? "#cf1322" : undefined }}>
                    {dsDetail.n_label_conflicts ?? 0} 处
                    {!!dsDetail.label_conflict_excluded_sec && `（挖掉 ${dsDetail.label_conflict_excluded_sec} 秒）`}
                  </span>
                </Tooltip>
              </Descriptions.Item>
              <Descriptions.Item label="掉数据挖掉">{dsDetail.missing_excluded_min ?? 0} 分钟</Descriptions.Item>
              <Descriptions.Item label="各类别段数" span={2}>
                <Space size={4} wrap>
                  {Object.entries(dsDetail.labels).map(([k, v]) => (
                    <Tag key={k}>
                      {k} {v}
                    </Tag>
                  ))}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="导出文件" span={2}>
                <Typography.Text code copyable style={{ fontSize: 12 }}>
                  {dsDetail.export_json}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            {/* 重复和重叠都是"看汇总数字看不出来、进了训练才吃亏"的毛病，
                单独给个体检 */}
            <div style={{ marginTop: 12 }}>
              <Button size="small" loading={checking} onClick={() => runCheck(dsDetail.name)}>
                检查重复 / 重叠
              </Button>
              {checkRes && (
                <div style={{ marginTop: 8 }}>
                  <Space size={6} wrap>
                    <Tag color={checkRes.n_exact_dups ? "red" : "green"}>
                      完全重复 {checkRes.n_exact_dups}
                    </Tag>
                    <Tooltip title="同一个任务里两段时间压在一起。同类别的说明该合成一段；不同类别的是矛盾标注——同一段时间既是活动又是抓挠，模型学到的是噪声">
                      <Tag color={checkRes.n_overlaps ? "orange" : "green"}>
                        时间重叠 {checkRes.n_overlaps}
                      </Tag>
                    </Tooltip>
                    <Tooltip title="同一个样本出现在两个任务里（同一份数据建了两次任务），两边都审过的话同一段时间会以两条记录进训练集">
                      <Tag color={checkRes.n_shared_samples ? "orange" : "green"}>
                        样本进了多个任务 {checkRes.n_shared_samples}
                      </Tag>
                    </Tooltip>
                    <Tag color={checkRes.n_bad_range ? "red" : "green"}>起止异常 {checkRes.n_bad_range}</Tag>
                  </Space>
                  {checkRes.n_exact_dups === 0 &&
                    checkRes.n_overlaps === 0 &&
                    checkRes.n_shared_samples === 0 &&
                    checkRes.n_bad_range === 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                        没查出问题，{checkRes.n_segments} 段都是干净的
                      </Typography.Text>
                    )}
                  {checkRes.overlaps.length > 0 && (
                    <Table
                      style={{ marginTop: 8 }}
                      size="small"
                      rowKey={(r) => `${r.task_id}-${r.start_a}-${r.start_b}`}
                      dataSource={checkRes.overlaps}
                      pagination={{ pageSize: 10, size: "small" }}
                      scroll={{ x: "max-content", y: 240 }}
                      columns={[
                        { title: "任务", dataIndex: "task_id", width: 80 },
                        {
                          title: "两段",
                          render: (_, r) => (
                            <span>
                              <Tag>{r.label_a}</Tag>
                              {r.start_a.slice(11)} ~ {r.end_a.slice(11)}
                              {" ／ "}
                              <Tag>{r.label_b}</Tag>
                              {r.start_b.slice(11)} ~ {r.end_b.slice(11)}
                            </span>
                          ),
                        },
                        { title: "重叠(秒)", dataIndex: "overlap_sec", width: 100 },
                        {
                          title: "类型",
                          width: 110,
                          render: (_, r) =>
                            r.same_label ? <Tag>同类别</Tag> : <Tag color="red">不同类别</Tag>,
                        },
                      ]}
                    />
                  )}
                  {checkRes.shared_samples.length > 0 && (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                      同一样本进了多个任务：
                      {checkRes.shared_samples
                        .slice(0, 10)
                        .map((x) => `${x.sample_code}（任务 ${x.task_ids.join("/")}）`)
                        .join("；")}
                      {checkRes.shared_samples.length > 10 ? "…" : ""}
                    </Typography.Paragraph>
                  )}
                </div>
              )}
            </div>

            {/* 到底装了什么：直接读最终喂给训练的那个 json，不是重算一遍 */}
            <Typography.Text strong style={{ display: "block", marginTop: 12 }}>
              片段明细（{dsSegs?.total ?? 0}）
              {dsSegs?.truncated && (
                <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                  {" "}
                  · 太多了，只列前 {dsSegs.rows.length} 条
                </Typography.Text>
              )}
            </Typography.Text>
            <Space size={4} wrap style={{ margin: "4px 0" }}>
              <Tag.CheckableTag checked={segLabel == null} onChange={() => setSegLabel(null)}>
                全部
              </Tag.CheckableTag>
              {Object.keys(dsDetail.labels).map((k) => (
                <Tag.CheckableTag key={k} checked={segLabel === k} onChange={() => setSegLabel(k)}>
                  {k} {dsDetail.labels[k]}
                </Tag.CheckableTag>
              ))}
            </Space>
            <Table<DatasetSegment>
              size="small"
              rowKey={(r) => `${r.task_id}-${r.start}-${r.label}`}
              loading={loadingSegs}
              dataSource={(dsSegs?.rows ?? []).filter((r) => !segLabel || r.label === segLabel)}
              pagination={{ pageSize: 20, size: "small" }}
              scroll={{ x: "max-content", y: 300 }}
              columns={[
                { title: "任务", dataIndex: "task_id", width: 80 },
                { title: "样本", dataIndex: "sample_code", ellipsis: true },
                { title: "类别", dataIndex: "label", width: 90, render: (v: string) => <Tag>{v}</Tag> },
                { title: "开始", dataIndex: "start", width: 190 },
                { title: "结束", dataIndex: "end", width: 190 },
                {
                  title: "时长(秒)",
                  dataIndex: "seconds",
                  width: 100,
                  sorter: (a, b) => (a.seconds ?? 0) - (b.seconds ?? 0),
                },
              ]}
            />

            {/* 哪个任务因为什么没进来，全在这儿。导完对不对，主要看这一段 */}
            <Typography.Text strong style={{ display: "block", marginTop: 12 }}>
              跳过的任务 / 提示（{dsDetail.warnings.length}）
            </Typography.Text>
            {dsDetail.warnings.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                没有跳过任何任务
              </Typography.Text>
            ) : (
              <div style={{ maxHeight: 260, overflow: "auto", fontSize: 12, marginTop: 4 }}>
                {dsDetail.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal
        title={`提交训练 - ${trainFor?.name ?? ""}`}
        open={trainFor != null}
        onCancel={() => setTrainFor(null)}
        onOk={doTrain}
        okText="开始训练"
        confirmLoading={submitting}
      >
        {trainFor && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              {trainFor.n_tasks} 个任务 / {trainFor.n_segments} 段 / {trainFor.total_hours} 小时
            </Typography.Text>
            <Space>
              <Typography.Text>模型类型</Typography.Text>
              <Select
                style={{ width: 140 }}
                value={modelType}
                onChange={setModelType}
                options={MODEL_TYPES.map((m) => ({ value: m, label: m }))}
              />
              <Typography.Text>标签</Typography.Text>
              <Input style={{ width: 160 }} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="可选" />
            </Space>
            <Space>
              <Typography.Text>原始采样率</Typography.Text>
              <Select
                style={{ width: 100 }}
                value={sourceHz}
                onChange={setSourceHz}
                options={[16, 25, 50, 100].map((v) => ({ value: v, label: `${v}Hz` }))}
              />
              <Typography.Text>训练采样率</Typography.Text>
              <Select
                style={{ width: 100 }}
                value={hz}
                onChange={setHz}
                options={[16, 25, 50].map((v) => ({ value: v, label: `${v}Hz` }))}
              />
            </Space>
            <Checkbox checked={skipSyn} onChange={(e) => setSkipSyn(e.target.checked)}>
              跳过合成数据（只训练纯标注那一版，快一些）
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              训练在 AI 服务那台机器上跑，几十分钟到几小时不等，可以关掉页面。回来在「训练记录」里看结果。
            </Typography.Text>
          </Space>
        )}
      </Modal>

      <Modal title={`训练详情 #${detail?.id ?? ""}`} open={detail != null} onCancel={() => setDetail(null)} footer={null} width={720}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].label}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="模型路径">{detail.model_path || "-"}</Descriptions.Item>
            <Descriptions.Item label="数据集参数">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.dataset_spec}</pre>
            </Descriptions.Item>
            <Descriptions.Item label="指标">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.metrics || "-"}</pre>
            </Descriptions.Item>
            {detail.error && (
              <Descriptions.Item label="错误">
                <Typography.Text type="danger">{detail.error}</Typography.Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}
