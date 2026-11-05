import PoolCharts from "@/components/PoolCharts";
import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Col, Collapse, DatePicker, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic,
  Table, Tag, Tooltip, TreeSelect, Typography, message,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";
import { listDogs } from "@/api/dogs";
import {
  poolItems, poolRemove, poolSummary, type PoolBucket, type PoolFilter, type PoolItem, type PoolSort,
} from "@/api/dataPool";
import { exportDataset, type TrainDataset } from "@/api/training";
import { useAuthStore } from "@/stores/authStore";
import { fmtSecs } from "@/utils/fmtDuration";

const fmtMs = (ms: number) => {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * 数据池：你认可的片段库（跟「导出数据集」不是一回事）。
 * 进池：项目页「加入数据池」（看过觉得行，整个任务 / 整个项目的已提交任务）；片段审核通过的也自动在池。
 * 这里一条条列出池里的片段，顶上是统计；训练时按 类别 / 项目 / 狗 / 日期 / 采样率 / 片段时长 挑一批，
 * 「用这批训练」导出后直接打开训练弹窗——类别合并在弹窗的归并表里做。
 */
export default function DataPoolPanel({
  onTrain,
  onOpen,
}: {
  onTrain: (ds: TrainDataset) => void;
  /** 在工作台打开这个任务，跳到这一刻 */
  onOpen: (taskId: number, seekMs: number, item?: { id: number; labelId: number }) => void;
}) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const curator = role === "admin" || role === "super_admin" || role === "reviewer";

  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [dogIds, setDogIds] = useState<number[]>([]);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [hzs, setHzs] = useState<number[]>([]);
  // 只要不短于这么多秒的片段：长片段往往更干净，先拿它们训
  const [minSec, setMinSec] = useState<number | null>(null);
  const [pickLabels, setPickLabels] = useState<string[]>([]);
  const [chartsOpen, setChartsOpen] = useState(() => {
    try { return localStorage.getItem("smart-label:pool-charts-open") !== "0"; } catch { return true; }
  });

  const filters: PoolFilter = useMemo(
    () => ({
      project_ids: projectIds.length ? projectIds : undefined,
      dog_ids: dogIds.length ? dogIds : undefined,
      date_from: range?.[0]?.format("YYYY-MM-DD") ?? null,
      date_to: range?.[1]?.format("YYYY-MM-DD") ?? null,
      sample_hz: hzs.length ? hzs : undefined,
      min_sec: minSec || null,
      label_names: pickLabels.length ? pickLabels : undefined,
    }),
    [projectIds, dogIds, range, hzs, minSec, pickLabels],
  );
  // 类别下拉的选项不能跟着类别筛选变（选了一个别的就没了）：统计另拉一份不带类别的
  const noLabel = useMemo(() => ({ ...filters, label_names: undefined }), [filters]);
  const anyFilter = !!(
    filters.project_ids || filters.dog_ids || filters.date_from || filters.date_to || filters.label_names
  );

  // 每个下拉只列「在别的条件下池里还有」的：按项目下拉就去掉项目这一条再统计一次，
  // 狗 / 日期 / 采样率同理（不去掉自己那条的话，选了一个别的选项就全没了）
  const facet = (drop: Partial<PoolFilter>) => ({ ...filters, ...drop });
  const { data: sumNoProject } = useQuery({ queryKey: ["data-pool", "summary", facet({ project_ids: undefined })], queryFn: () => poolSummary(facet({ project_ids: undefined })) });
  const { data: sumNoDog } = useQuery({ queryKey: ["data-pool", "summary", facet({ dog_ids: undefined })], queryFn: () => poolSummary(facet({ dog_ids: undefined })) });
  const { data: sumNoDate } = useQuery({ queryKey: ["data-pool", "summary", facet({ date_from: null, date_to: null })], queryFn: () => poolSummary(facet({ date_from: null, date_to: null })) });
  const { data: sumNoHz } = useQuery({ queryKey: ["data-pool", "summary", facet({ sample_hz: undefined })], queryFn: () => poolSummary(facet({ sample_hz: undefined })) });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const projectOptions = useMemo(() => {
    const have = new Map((sumNoProject?.by_project ?? []).filter((b) => b.id != null).map((b) => [b.id as number, b]));
    const keep = projectIds.filter((id) => !have.has(id)).map((id) => ({ value: id, label: `${projects?.find((p) => p.id === id)?.name ?? `#${id}`}（0 段）` }));
    return [...[...have.values()].map((b) => ({ value: b.id as number, label: `${b.name}（${b.n} 段）` })), ...keep];
  }, [sumNoProject, projectIds, projects]);
  const dogOptions = useMemo(() => {
    const have = new Map((sumNoDog?.by_dog ?? []).filter((b) => b.id != null).map((b) => [b.id as number, b]));
    const code = (id: number) => dogs?.find((d) => d.id === id)?.dog_code;
    const keep = dogIds.filter((id) => !have.has(id)).map((id) => ({ value: id, label: `${code(id) ?? `#${id}`}（0 段）` }));
    return [...[...have.values()].map((b) => ({ value: b.id as number, label: `${code(b.id as number) ?? ""} ${b.name}（${b.n} 段）`.trim() })), ...keep];
  }, [sumNoDog, dogIds, dogs]);
  const datesWithData = useMemo(() => new Set((sumNoDate?.by_date ?? []).map((b) => b.name)), [sumNoDate]);
  const hzOptions = useMemo(() => {
    const have = (sumNoHz?.by_hz ?? []).map((b) => ({ hz: parseInt(b.name, 10), n: b.n })).filter((x) => Number.isFinite(x.hz));
    const all = [...have, ...hzs.filter((h) => !have.some((x) => x.hz === h)).map((h) => ({ hz: h, n: 0 }))].sort((a, b) => b.hz - a.hz);
    return all.map((x) => ({ value: x.hz, label: `${x.hz}Hz（${x.n}）` }));
  }, [sumNoHz, hzs]);
  const { data: sum, isFetching: loadingSum } = useQuery({
    queryKey: ["data-pool", "summary", filters],
    queryFn: () => poolSummary(filters),
  });
  const { data: sumAll } = useQuery({
    queryKey: ["data-pool", "summary", noLabel],
    queryFn: () => poolSummary(noLabel),
  });

  // 选过的排序记住（比如一直看「刚进池的先」，回来不用再选）
  const [sort, setSortState] = useState<PoolSort>(() => {
    try { return (localStorage.getItem("smart-label:pool-sort") as PoolSort) || "long"; } catch { return "long"; }
  });
  const setSort = (v: PoolSort) => { setSortState(v); try { localStorage.setItem("smart-label:pool-sort", v); } catch { /* ignore */ } };
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => setPage(1), [filters, sort]);
  const { data: list, isFetching: loadingList } = useQuery({
    queryKey: ["data-pool", "items", filters, sort, page, pageSize],
    queryFn: () => poolItems(filters, sort, page, pageSize),
    placeholderData: (prev) => prev,
  });
  const [picked, setPicked] = useState<number[]>([]);
  const refresh = () => {
    setPicked([]);
    qc.invalidateQueries({ queryKey: ["data-pool"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const [busy, setBusy] = useState(false);
  const remove = async (body: Parameters<typeof poolRemove>[0]) => {
    setBusy(true);
    try {
      const r = await poolRemove(body);
      message.success(`移出 ${r.removed} 段`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // 类别下拉按层级摆：抓挠 → 抓挠-头颈耳 / 抓挠-躯干 → …，每层的数含它底下全部细类。
  // 子节点显示短名（「头颈耳」），选中后框里是全名。老后端没有 tree 时退回平铺
  type TNode = { value: string; title: string; full: string; children?: TNode[] };
  const labelTree = useMemo<TNode[]>(() => {
    const t = sumAll?.tree;
    const fmt = (b: PoolBucket) => `（${b.n} 段 · ${fmtSecs(b.hours * 3600)}）`;
    if (!t) {
      return [...(sumAll?.by_root ?? []), ...(sumAll?.by_label ?? [])]
        .filter((b, i, a) => a.findIndex((x) => x.name === b.name) === i)
        .map((b) => ({ value: b.name, title: `${b.name}${fmt(b)}`, full: b.name }));
    }
    const kids = new Map<string | null, typeof t>();
    for (const b of t) kids.set(b.parent, [...(kids.get(b.parent) ?? []), b]);
    const build = (p: string | null): TNode[] =>
      (kids.get(p) ?? []).map((b) => {
        const short = p && b.name.startsWith(p + "-") ? b.name.slice(p.length + 1) : b.name;
        const ch = build(b.name);
        return { value: b.name, title: `${short}${fmt(b)}`, full: b.name, ...(ch.length ? { children: ch } : {}) };
      });
    return build(null);
  }, [sumAll]);

  // 「用这批训练」
  const [trainOpen, setTrainOpen] = useState(false);
  const [dsName, setDsName] = useState("");
  const [capH, setCapH] = useState<number | null>(null);
  const [preview, setPreview] = useState<TrainDataset | null>(null);
  const exportBody = (dry: boolean) => {
    const roots = sum?.by_root ?? [];
    const reduce_targets =
      capH != null && capH > 0
        ? Object.fromEntries(roots.filter((b) => b.hours > capH).map((b) => [b.name, Math.round(capH * 3600)]))
        : undefined;
    return {
      name: dsName.trim(),
      scope: "pool" as const,
      project_ids: filters.project_ids,
      dog_ids: filters.dog_ids,
      date_from: filters.date_from,
      date_to: filters.date_to,
      sample_hz: filters.sample_hz,
      label_names: filters.label_names,
      min_seg_sec: minSec || undefined,
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


  return (
    <div>
      {/* 筛选：同时作用于统计、列表、训练。说明收进最前面的问号 */}
      <Space wrap style={{ marginBottom: 12 }}>
        <Tooltip overlayStyle={{ maxWidth: 460 }} title={<div><b>数据池 = 你认可、可以拿去训练的片段</b><div style={{ marginTop: 4 }}>进池：在项目页看过觉得行，点任务的「加入数据池」（或项目行的「加入数据池」= 已提交的任务整份）。片段之后被改过会自动出池。训练时在这里按条件挑一批，「用这批训练」导出并打开训练弹窗（类别合并在弹窗的归并表里做）。</div></div>}>
          <QuestionCircleOutlined style={{ color: "#888", cursor: "help", fontSize: 15 }} />
        </Tooltip>
        <TreeSelect
          multiple
          allowClear
          showSearch
          treeLine
          placeholder="类别（选上级含全部细类）"
          style={{ minWidth: 280 }}
          popupMatchSelectWidth={false}
          value={pickLabels}
          onChange={(v) => setPickLabels(v as string[])}
          treeData={labelTree}
          treeNodeFilterProp="full"
          treeNodeLabelProp="full"
          treeDefaultExpandedKeys={labelTree.map((n) => n.value)}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="项目"
          style={{ minWidth: 200 }}
          value={projectIds}
          onChange={setProjectIds}
          optionFilterProp="label"
          options={projectOptions}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="狗"
          style={{ minWidth: 160 }}
          value={dogIds}
          onChange={setDogIds}
          optionFilterProp="label"
          options={dogOptions}
        />
        <DatePicker.RangePicker
          value={range as [Dayjs, Dayjs] | null}
          onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
          // 池里没有片段的日子灰掉（还没统计出来时不灰）
          disabledDate={(d) => datesWithData.size > 0 && !datesWithData.has(d.format("YYYY-MM-DD"))}
          presets={[
            { label: "最近 30 天", value: [dayjs().subtract(30, "day"), dayjs()] },
            { label: "最近 90 天", value: [dayjs().subtract(90, "day"), dayjs()] },
          ]}
        />
        <Checkbox.Group
          value={hzs}
          onChange={(v) => setHzs(v as number[])}
          options={hzOptions}
        />
        <Tooltip title="只要不短于这么多秒的片段。长片段往往更干净">
          <InputNumber min={0} step={5} value={minSec} onChange={(v) => setMinSec(v ?? null)} placeholder="片段" addonAfter="秒以上" style={{ width: 140 }} />
        </Tooltip>
      </Space>

      {/* 统计 */}
      <Row gutter={24} align="middle" style={{ marginBottom: 8 }}>
        <Col><Statistic title="片段" value={sum?.n ?? 0} loading={loadingSum} /></Col>
        <Col><Statistic title="时长" value={fmtSecs((sum?.hours ?? 0) * 3600)} loading={loadingSum} /></Col>
        <Col flex="auto" />
        <Col>
          <Button type="primary" disabled={!sum?.n} onClick={() => setTrainOpen(true)}>
            用这批训练
          </Button>
        </Col>
      </Row>
      {/* 统计图：每个维度一张条形图 + 按天柱图，点条就按它筛。整块能收起（记住） */}
      <Collapse
        size="small"
        style={{ marginBottom: 12 }}
        activeKey={chartsOpen ? ["charts"] : []}
        onChange={(k) => {
          const open = (Array.isArray(k) ? k : [k]).includes("charts");
          setChartsOpen(open);
          try { localStorage.setItem("smart-label:pool-charts-open", open ? "1" : "0"); } catch { /* ignore */ }
        }}
        items={[{
          key: "charts",
          label: "统计图（类别 / 按天 / 细类 / 项目 / 狗 / 采样率）",
          children: (
            <PoolCharts
              sum={sum}
              picked={{ labels: pickLabels, projects: projectIds, dogs: dogIds, hzs }}
              onPickRoot={(n) => setPickLabels([n])}
              onPickLabel={(n) => setPickLabels([n])}
              onPickProject={(id) => setProjectIds([id])}
              onPickDog={(id) => setDogIds([id])}
              onPickHz={(hz) => setHzs([hz])}
              onPickDate={(d) => setRange([dayjs(d), dayjs(d)])}
            />
          ),
        }]}
      />

      {/* 一条条的片段 */}
      <Space style={{ marginBottom: 8 }} wrap>
        <Select<PoolSort>
          value={sort}
          onChange={setSort}
          style={{ width: 150 }}
          options={[
            // 刚审核通过 / 刚加进来的排最前：刚标完想回头核对一眼用
            { value: "recent", label: "刚进池的先" },
            { value: "long", label: "最长的先" },
            { value: "short", label: "最短的先" },
            { value: "new", label: "日期最近的先" },
            { value: "time", label: "按任务、时间" },
          ]}
        />
        {curator && (
          <>
            <Popconfirm title={`选中的 ${picked.length} 段移出数据池？`} disabled={!picked.length} onConfirm={() => remove({ item_ids: picked })}>
              <Button danger disabled={!picked.length} loading={busy}>移出选中{picked.length ? ` ${picked.length}` : ""}</Button>
            </Popconfirm>
            <Popconfirm
              title={`按当前筛选把 ${sum?.n ?? 0} 段全部移出数据池？`}
              disabled={!anyFilter}
              onConfirm={() => remove(filters)}
            >
              <Tooltip title={anyFilter ? "" : "先选类别 / 项目 / 狗 / 日期"}>
                <Button danger type="dashed" disabled={!anyFilter} loading={busy}>按筛选全部移出</Button>
              </Tooltip>
            </Popconfirm>
          </>
        )}
      </Space>
      <Table<PoolItem>
        size="small"
        rowKey="id"
        loading={loadingList}
        dataSource={list?.items ?? []}
        rowSelection={curator ? { selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) } : undefined}
        pagination={{
          current: page,
          pageSize,
          total: list?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200],
          showTotal: (t) => `共 ${t} 段`,
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
        }}
        columns={[
          { title: "类别", dataIndex: "label_name", width: 150, render: (v: string) => <Tag>{v}</Tag> },
          {
            title: "时长",
            width: 90,
            render: (_, r) => <strong>{fmtSecs((r.end_time_ms - r.start_time_ms) / 1000)}</strong>,
          },
          {
            title: "位置",
            width: 140,
            render: (_, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {fmtMs(r.start_time_ms)} ~ {fmtMs(r.end_time_ms)}
              </Typography.Text>
            ),
          },
          {
            title: "样本",
            render: (_, r) => (
              <Typography.Text style={{ fontSize: 12 }}>
                {r.sample_code} <Typography.Text type="secondary">#{r.task_id}</Typography.Text>
              </Typography.Text>
            ),
          },
          { title: "项目", dataIndex: "project_name", width: 160, ellipsis: true },
          { title: "狗", dataIndex: "dog_name", width: 100, render: (v: string | null) => v ?? "-" },
          { title: "日期", dataIndex: "session_date", width: 100, render: (v: string | null) => v ?? "-" },
          { title: "采样率", dataIndex: "hz", width: 70, render: (v: number) => `${v}Hz` },
          {
            title: "来源",
            dataIndex: "via",
            width: 80,
            render: (v: string) => (v === "manual" ? <Tag color="blue">手动</Tag> : <Tag color="green">审核</Tag>),
          },
          {
            title: "进池时间",
            dataIndex: "entered_at",
            width: 130,
            render: (v: string | null | undefined) => v ? v.slice(5) : "-",
          },
          {
            title: "操作",
            width: 120,
            render: (_, r) => (
              <Space size={0}>
                <Button size="small" type="link" onClick={() => onOpen(r.task_id, r.start_time_ms, { id: r.id, labelId: r.label_id })}>
                  看
                </Button>
                {curator && (
                  <Popconfirm title="这一段移出数据池？" onConfirm={() => remove({ item_ids: [r.id] })}>
                    <Button size="small" type="link" danger>
                      移出
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="用这批训练"
        open={trainOpen}
        onCancel={() => {
          setTrainOpen(false);
          setPreview(null);
        }}
        footer={[
          <Button key="p" loading={busy} onClick={doPreview}>
            预览
          </Button>,
          <Button key="ok" type="primary" loading={busy} onClick={doExport}>
            导出并打开训练
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            当前筛选：{sum?.n ?? 0} 段 / {fmtSecs((sum?.hours ?? 0) * 3600)}；类别：{pickLabels.length ? pickLabels.join("、") : "全部"}
            {minSec ? `；片段 ≥ ${minSec} 秒` : ""}
          </Typography.Text>
          <Input placeholder="数据集名字，如 pool_1102" value={dsName} onChange={(e) => setDsName(e.target.value)} />
          <span>
            每个大类最多 <InputNumber min={0} step={0.5} value={capH} onChange={(v) => setCapH(v)} placeholder="不限" /> 小时
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
                    <Tag key={k}>
                      {k} {String(v)}
                    </Tag>
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
