import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Input, Modal, Popconfirm, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cleanupMissingFileSamples,
  deleteSamplesBatch,
  getImportScanStatus,
  listMissingFileSamples,
  startImportScan,
  listSamples,
  setSamplesDog,
  setSamplesSensitive,
  updateSample,
  type ScanProgress,
} from "@/api/samples";
import { listDogs } from "@/api/dogs";
import SamplePreviewModal from "@/components/SamplePreviewModal";
import type { Sample } from "@/types";
import { imuOf, sortImuKeys } from "@/utils/imuOf";
import { usePersistedSort } from "@/utils/persistedSort";
import { useResizableColumns } from "@/utils/resizableColumns";

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
  // 排序记住：样本按 CSV 行数/时长找异常时排一次序，切走再回来不用重排
  const sort = usePersistedSort("samples-sort");
  const width = useResizableColumns("samples-widths");
  const [sensitiveFilter, setSensitiveFilter] = useState<"全部" | "仅敏感" | "仅非敏感">("全部");
  // 空 CSV：文件建出来了但一行数据都没写，打开就报「CSV 没有数据行」，也算不出
  // 任何指标。行数为 null 是导入时没探到，不算空
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [markOpen, setMarkOpen] = useState(false);
  const [markNote, setMarkNote] = useState("");
  const [marking, setMarking] = useState(false);

  const handleToggleSensitive = async (sample: Sample, on: boolean) => {
    await updateSample(sample.id, { is_sensitive: on });
    message.success(on ? "已标记为敏感，仅管理员可见" : "已解除敏感标记");
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  // NAS 上文件已经没了的样本（当天重录过、或者人工删过原始数据）。
  // 由扫描标出来，这里只负责展示和一键清理
  const { data: missing } = useQuery({
    queryKey: ["samples", "missing-files"],
    queryFn: listMissingFileSamples,
  });

  const cleanupMissing = async () => {
    const r = await cleanupMissingFileSamples();
    message.success(`已清理 ${r.deleted} 个样本${r.tasks_deleted ? `、${r.tasks_deleted} 个任务` : ""}`);
    qc.invalidateQueries({ queryKey: ["samples"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const removeSamples = async (ids: number[]) => {
    const r = await deleteSamplesBatch(ids);
    message.success(`已删除 ${r.deleted} 个样本${r.tasks_deleted ? `、${r.tasks_deleted} 个任务` : ""}`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["samples"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  // 跟「所属狗」列的下拉显示同一套写法，两处不一致的话人会以为选错了
  const dogLabel = (dogId: number) => {
    const d = dogs?.find((x) => x.id === dogId);
    if (!d) return `#${dogId}`;
    return d.name ? `${d.dog_code}（${d.name}）` : d.dog_code;
  };

  // 一天一个机位就有 30 份样本（每小时一段），而同一天同一个机位戴在哪只狗身上
  // 是固定的——挨个下拉选 30 次纯属白费功夫
  const assignDog = async (ids: number[], dogId: number | null) => {
    if (ids.length === 0) return;
    const r = await setSamplesDog(ids, dogId);
    const who = dogId == null ? "解除关联" : `关联到 ${dogLabel(dogId)}`;
    message.success(`已把 ${r.updated} 个样本${who}`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["samples"] });
  };
  const assignDogBulk = (dogId: number | null) => assignDog([...selected], dogId);

  const dogOptions = dogs?.map((d) => ({
    value: d.id,
    label: d.name ? `${d.dog_code}（${d.name}）` : d.dog_code,
  }));

  /** 这一组现在都关联到谁了：全一样就报那只狗，有多有少就是"混合" */
  const groupDog = (rows: Sample[]) => {
    const ids = new Set(rows.map((r) => r.dog_id ?? 0));
    if (ids.size !== 1) return { text: "多只/部分未关联", mixed: true };
    const only = [...ids][0];
    return only ? { text: dogLabel(only), mixed: false } : null;
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
    {
      // 不是所有样本一个频率：8-11 之前采集端就降到 16Hz 存了，8-11 起才是 50Hz
      // 原始流。按错的频率跑推理，重采样和特征窗口全错，所以这一列要看得见
      title: "采样率",
      dataIndex: "sample_hz",
      width: 100,
      sorter: (a: Sample, b: Sample) => (a.sample_hz ?? 0) - (b.sample_hz ?? 0),
      render: (v: number | null | undefined) =>
        v == null ? (
          <Tooltip title="导入时没量出来（老样本或时间戳解析不了）。重新扫描一次会补上">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          <Tag color={v >= 40 ? "blue" : "orange"}>{v} Hz</Tag>
        ),
    },
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
  const emptySamples = useMemo(() => (data ?? []).filter((s) => s.imu_row_count === 0), [data]);

  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of data ?? []) {
      if (sensitiveFilter === "仅敏感" && !s.is_sensitive) continue;
      if (sensitiveFilter === "仅非敏感" && s.is_sensitive) continue;
      if (onlyEmpty && s.imu_row_count !== 0) continue;
      const key = s.session_date ?? "未知日期";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data, sensitiveFilter, onlyEmpty]);

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
        {width.hasCustom && (
          <Tooltip title="列宽是拖出来的，记在这台电脑上。拖乱了点这里回到默认">
            <Button size="small" type="link" onClick={width.reset}>
              恢复列宽
            </Button>
          </Tooltip>
        )}
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
        {emptySamples.length > 0 && (
          <>
            <Checkbox checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)}>
              <span style={{ color: "#ff4d4f" }}>空 CSV {emptySamples.length}</span>
            </Checkbox>
            <Popconfirm
              title={`删除这 ${emptySamples.length} 个空 CSV 样本？`}
              description="文件建出来了但一行数据都没写，打开就报错、也算不出指标。会连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动，只删数据库登记"
              okButtonProps={{ danger: true }}
              onConfirm={() => removeSamples(emptySamples.map((s) => s.id))}
            >
              <Button size="small" danger>
                删除空 CSV 样本
              </Button>
            </Popconfirm>
          </>
        )}
        {(missing?.total ?? 0) > 0 && (
          <>
            <Tooltip
              title={
                <div>
                  <div>这些样本在库里，但 NAS 上对应的文件已经没了——当天重录过、或者原始数据被删了。</div>
                  <div style={{ marginTop: 6 }}>点预览就是 No such file or directory。清理只删数据库登记，NAS 上本来也没东西可删。</div>
                  {(missing?.with_tasks ?? 0) > 0 && (
                    <div style={{ marginTop: 6, color: "#ffa39e" }}>
                      其中 {missing?.with_tasks} 个上面还挂着任务，删掉会连标注一起没。
                    </div>
                  )}
                </div>
              }
            >
              <Tag color="red" style={{ cursor: "help" }}>
                NAS 上已删除 {missing?.total}
              </Tag>
            </Tooltip>
            <Popconfirm
              title={`清理这 ${missing?.total} 个样本？`}
              description={
                <div style={{ maxWidth: 420 }}>
                  NAS 上文件已经没了，只删数据库登记。
                  {(missing?.with_tasks ?? 0) > 0
                    ? `其中 ${missing?.with_tasks} 个上面还挂着任务，会连同标注、草稿、审核记录一起删，不可恢复。`
                    : "这些样本上没有任何任务。"}
                </div>
              }
              okButtonProps={{ danger: true }}
              onConfirm={cleanupMissing}
            >
              <Button size="small" danger>
                清理已删除的样本
              </Button>
            </Popconfirm>
          </>
        )}
        {selected.size > 0 && (
          <>
            <Tag>已勾选 {selected.size}</Tag>
            <Select
              size="small"
              allowClear
              placeholder={`批量关联狗（${selected.size} 个）`}
              style={{ width: 190 }}
              // 不受控：选完就发请求、清空选中，下拉自己不该留着上次选的值
              value={null}
              options={dogOptions}
              onChange={(v) => assignDogBulk(v ?? null)}
              showSearch
              optionFilterProp="label"
            />
            <Popconfirm
              title={`解除这 ${selected.size} 个样本的狗关联？`}
              onConfirm={() => assignDogBulk(null)}
            >
              <Button size="small">解除关联</Button>
            </Popconfirm>
            <Button size="small" danger icon={<LockOutlined />} onClick={() => setMarkOpen(true)}>
              标记为敏感
            </Button>
            <Popconfirm title={`解除这 ${selected.size} 个样本的敏感标记？其他人将重新可见`} onConfirm={() => applyBulk(false)}>
              <Button size="small" loading={marking}>
                解除敏感
              </Button>
            </Popconfirm>
            <Popconfirm
              title={`删除勾选的 ${selected.size} 个样本？`}
              description="会连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动，只删数据库登记。不可恢复"
              okButtonProps={{ danger: true }}
              onConfirm={() => removeSamples([...selected])}
            >
              <Button size="small" danger>
                删除样本
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
          items={groups.map(([dateKey, samples]) => {
            // 日期目录下再按 imu 分成子目录：imu1/imu2/imu3/imu4 各对应一只狗，
            // 看某只狗的数据直接点开它的目录。NAS 上的文件不动，只是页面里这么归纳
            const byImu = new Map<string, Sample[]>();
            for (const smp of samples) {
              const k = imuOf(smp.sample_code);
              if (!byImu.has(k)) byImu.set(k, []);
              byImu.get(k)!.push(smp);
            }
            const renderTable = (rows: Sample[]) => (
              <Table
                rowKey="id"
                size="small"
                dataSource={rows}
                pagination={rows.length > 20 ? { pageSize: 20 } : false}
                columns={width.applyResize<Sample>(sort.applySort<Sample>(columns))}
                onChange={sort.onTableChange}
                components={width.components}
                tableLayout={width.tableLayout}
                // 拖出来的列宽要生效，表格得是固定布局——antd 靠 scroll.x 切过去
                scroll={{ x: "max-content" }}
                // antd 默认点三下是 升序 -> 降序 -> 取消排序（回到原始顺序），第三种
                // 看着像乱序；这里只在升/降之间切
                sortDirections={["ascend", "descend", "ascend"]}
                // 勾选跨日期/跨 imu 分组共用一个集合，可以在几天里各挑几个一起标
                rowSelection={{
                  selectedRowKeys: rows.filter((s) => selected.has(s.id)).map((s) => s.id),
                  onChange: (_, picked) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      rows.forEach((s) => next.delete(s.id));
                      picked.forEach((s) => next.add(s.id));
                      return next;
                    });
                  },
                }}
              />
            );
            return {
              key: dateKey,
              label: `${dateKey}（${samples.length} 个样本）`,
              children: (
                <Collapse
                  size="small"
                  items={sortImuKeys(byImu.keys()).map((imu) => {
                    const rows = byImu.get(imu)!;
                    const cur = groupDog(rows);
                    return {
                      key: imu,
                      // 关联狗这件事天然是"整组一样"：一天里同一个机位戴在哪只狗身上
                      // 是固定的，一组就是 30 份（每小时一段）。所以入口放在组标题上，
                      // 比"先勾 30 个再去工具栏"少一整步——而后者恰恰是想省事的人
                      // 第一眼找不到的地方（工具栏没勾选时整个是隐藏的）。
                      label: (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span>
                            {imu}（{rows.length} 个样本）
                          </span>
                          {cur && (
                            <>
                              <Tag color={cur.mixed ? "orange" : "blue"} style={{ marginRight: 0 }}>
                                {cur.text}
                              </Tag>
                              {/* 解除单独放一个按钮，不塞进上面那个下拉当一个选项：
                                  它是清空不是改值，混在狗名列表里太容易点错 */}
                              <span onClick={(e) => e.stopPropagation()}>
                                <Popconfirm
                                  title={`解除 ${imu} 这 ${rows.length} 个样本的狗关联？`}
                                  onConfirm={() => assignDog(rows.map((r) => r.id), null)}
                                >
                                  <Button size="small" type="link" style={{ padding: 0 }}>
                                    解除
                                  </Button>
                                </Popconfirm>
                              </span>
                            </>
                          )}
                          {/* 挡掉冒泡：不挡的话点下拉会把这个折叠面板收起来，选项列表跟着消失 */}
                          <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: "auto" }}>
                            <Select
                              size="small"
                              placeholder={`整组关联到…（${rows.length} 个）`}
                              style={{ width: 200 }}
                              // 不受控：选完就发请求，下拉自己不该留着上次选的值
                              value={null}
                              options={dogOptions}
                              onChange={(v) => assignDog(rows.map((r) => r.id), v ?? null)}
                              showSearch
                              optionFilterProp="label"
                            />
                          </span>
                        </div>
                      ),
                      children: renderTable(rows),
                    };
                  })}
                />
              ),
            };
          })}
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
