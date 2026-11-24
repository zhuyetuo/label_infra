/**
 * 模型测试：管测试集（挑数据、看配额够不够、哪个模型见过）、拿测试集给模型打分、几批测试集交叉对比。
 *
 * 规矩（后端守着）：测试集里的样本不进任何训练导出；冻结后不能增删，补数据复制成新版本。
 * 打分复用「模型对比」那套（/model-eval）：按整个样本、按事件配对算精确率 / 召回率。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert, Button, Checkbox, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Tooltip, TreeSelect, Typography, message,
} from "antd";
import type { Dayjs } from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addTestItems, checkTestItem, composeApply, composePreview, copyTestSet, createTestSet, deleteTestItem, deleteTestSet, freezeTestSet, getLabelTree,
  getTaskSegments, getTestItems, getTestSeen, listTestSets,
  type ComposeBody, type ComposeStats, type Coverage, type TaskSeg, type TestItem, type TestSet,
} from "@/api/modelTests";
import { listDogs } from "@/api/dogs";
import ModelTestPlan from "@/components/ModelTestPlan";
import { listProjects } from "@/api/projects";
import { claimTask, getTask, listTasks } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import type { LabelDefinition } from "@/types";
import { listModelVersions } from "@/api/training";
import { compareModels, getEvalRunProgress, listEvalRuns, startEvalRun, type VersionResult } from "@/api/modelEval";
import { useInferModes } from "@/hooks/useInferModes";
import { modeLabelOf } from "@/utils/inferMode";
import type { Task } from "@/types";

const TOPS = ["抓挠", "活动", "静止/休息", "未佩戴"];
/** 「标了什么」的标签：实心色块、加粗，一眼看得出是哪类 */
const TAG_SOLID = { fontWeight: 600, fontSize: 13, padding: "2px 8px", borderRadius: 6, marginInlineEnd: 0 } as const;
const SIZES = ["小", "中", "大"];
const EVAL_LABELS = ["抓挠", "活动", "静止/休息", "未佩戴"];

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`;
};
const fmtSec = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`);
/** 「1:30」「90」「1:02:03」→ 毫秒；空 → null；认不出 → NaN */
const parseTime = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0) * 1000;
};
/** 测试片段 → 打分用的时间窗口（只要 sampleIds 里的） */
const windowsOf = (items: TestItem[], sampleIds: number[]) => {
  const keep = new Set(sampleIds);
  return items.filter((i) => keep.has(i.sample_id) && i.end_ms > i.start_ms)
    .map((i) => ({ sample_id: i.sample_id, start_ms: i.start_ms, end_ms: i.end_ms }));
};
/** 正确答案只取测试集自己的任务（同一个样本在别的项目里还有预标 / 别人标的） */
const taskIdsOf = (items: TestItem[], sampleIds: number[]) => {
  const keep = new Set(sampleIds);
  return Array.from(new Set(items.filter((i) => keep.has(i.sample_id)).map((i) => i.task_id)));
};
const f1 = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
/** 「srv:train60」之类 → 训练记录的 algo_job_id；默认在线模型之类认不出就 null（见没见过不知道） */
const jobIdOfTag = (tag: string): number | null => {
  const m = /train(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
};

// ───────────────────────── 配额表 ─────────────────────────
function CoverageView({ cov }: { cov: Coverage }) {
  const sizes = Object.keys(cov.matrix);
  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      {cov.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />)}
      <Space wrap>
        <span>共 <b>{cov.n_items}</b> 段，<b>{fmtSec(cov.total_sec)}</b>，<b>{cov.n_dogs}</b> 只狗</span>
        {Object.entries(cov.kinds).map(([k, n]) => <Tag key={k}>{k} {n}</Tag>)}
        {Object.entries(cov.sites).map(([k, n]) => <Tag key={k} color="blue">{k} {n}</Tag>)}
        <span style={{ color: "#888" }}>日期 {Object.keys(cov.dates).length} 天</span>
      </Space>
      <Table
        size="small" pagination={false} rowKey="size" bordered
        dataSource={sizes.map((sz) => ({ size: sz, ...cov.matrix[sz] }))}
        columns={[
          { title: "体型", dataIndex: "size", width: 70 },
          ...TOPS.map((tp) => ({
            title: tp, key: tp,
            render: (_: unknown, r: Record<string, unknown>) => {
              const c = (r[tp] ?? { items: 0, n: 0, sec: 0 }) as { items: number; n: number; sec: number };
              if (!c.items) return <span style={{ color: "#ff4d4f" }}>缺</span>;
              return (
                <Tooltip title={`${c.items} 段测试数据里有「${tp}」，一共 ${c.n} 次（事件），${fmtSec(c.sec)}`}>
                  <span><b>{c.n}</b> 次 · {fmtSec(c.sec)} <span style={{ color: "#888" }}>（{c.items} 段）</span></span>
                </Tooltip>
              );
            },
          })),
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        数事件数，不是段数：抓挠每种体型 30 次左右，召回率的误差约 ±15%；100 次左右才稳到 ±8%。红色「缺」的格子是下一批要补的。
      </Typography.Text>
      {Object.keys(cov.by_dur ?? {}).length > 0 && (
        <Table size="small" bordered pagination={false} rowKey="dur" style={{ maxWidth: 520 }}
          dataSource={Object.entries(cov.by_dur ?? {}).map(([dur, m]) => ({ dur, yes: m["有抓挠"] ?? 0, no: m["无抓挠"] ?? 0 }))}
          columns={[
            { title: "时长", dataIndex: "dur" },
            { title: "有抓挠", dataIndex: "yes", render: (v: number) => <b style={{ color: "#27AE60" }}>{v}</b> },
            { title: "无抓挠", dataIndex: "no", render: (v: number) => <b style={{ color: "#5D6D7E" }}>{v}</b> },
            { title: "合计", render: (_, r) => r.yes + r.no },
          ]} />
      )}
      <Space wrap>
        <span>人工核对过 <b>{cov.n_checked ?? 0}</b> / {cov.n_items} 段</span>
        {Object.keys(cov.leaf ?? {}).length > 0 && <span style={{ color: "#888" }}>细类（部位）：</span>}
        {Object.entries(cov.leaf ?? {}).slice(0, 30).map(([k, n]) => <Tag key={k}>{k} {n}</Tag>)}
      </Space>
      <Table
        size="small" pagination={false} rowKey={(r) => `${r.site}-${r.dog}`}
        dataSource={cov.dogs}
        columns={[
          { title: "场地", dataIndex: "site", render: (v) => v ?? "未知" },
          { title: "狗", dataIndex: "dog", render: (v) => v ?? "未知" },
          { title: "时长", dataIndex: "sec", render: (v: number) => fmtSec(v) },
          { title: "占比", dataIndex: "share", render: (v: number) => <span style={{ color: v > 0.15 ? "#ff4d4f" : undefined }}>{pct(v)}</span> },
        ]}
      />
    </Space>
  );
}

// ───────────────────────── 添加片段 ─────────────────────────
function AddItemsModal({ setId, open, onClose }: { setId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [idsText, setIdsText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [padSec, setPadSec] = useState<number | null>(60);
  const [segTask, setSegTask] = useState<number | null>(null);
  const [segPicked, setSegPicked] = useState<number[]>([]);
  const [segTop, setSegTop] = useState<string>("抓挠");
  const [busy, setBusy] = useState(false);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects, enabled: open });
  const { data: tasks, isFetching } = useQuery({
    queryKey: ["tasks", projectId], queryFn: () => listTasks(projectId!), enabled: open && projectId != null,
  });
  const { data: segs, isFetching: segLoading } = useQuery({
    queryKey: ["task-segs", segTask], queryFn: () => getTaskSegments(segTask!), enabled: open && segTask != null,
  });
  const segShown = (segs ?? []).filter((x) => !segTop || x.top === segTop);
  const typedIds = () => idsText.split(/[\s,，、]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);

  const submit = async () => {
    // 挑了事件：每个事件一段，起止 = 事件起止，再凑够 N 秒
    if (segTask != null && segPicked.length) {
      const chosen = (segs ?? []).filter((x) => segPicked.includes(x.id));
      setBusy(true);
      try {
        const r = await addTestItems(setId, chosen.map((x) => ({
          task_id: segTask, start_ms: x.start_ms, end_ms: x.end_ms, pad_to_sec: padSec, note: note || `${x.label} 事件`,
        })));
        message[r.skipped.length ? "warning" : "success"](
          `加了 ${r.added} 段` + (r.skipped.length ? `，跳过 ${r.skipped.length}：${r.skipped.slice(0, 3).map((x) => x.reason).join("；")}` : ""));
        qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
        qc.invalidateQueries({ queryKey: ["model-test-sets"] });
        setSegPicked([]);
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }
    const ids = Array.from(new Set([...picked, ...typedIds()]));
    if (!ids.length) return message.warning("先选任务、填任务号，或者点「挑事件」选标注片段");
    const s = parseTime(from), e = parseTime(to);
    if (Number.isNaN(s) || Number.isNaN(e) || (s == null) !== (e == null) || (s != null && e != null && e <= s)) {
      return message.warning("起止要么都空（整个任务），要么都填、结束晚于开始；格式 1:30 或 90（秒）");
    }
    setBusy(true);
    try {
      const r = await addTestItems(setId, ids.map((task_id) => ({
        task_id, start_ms: s, end_ms: e, note: note || undefined, pad_to_sec: s != null ? padSec : null,
      })));
      message[r.skipped.length ? "warning" : "success"](
        `加了 ${r.added} 段` + (r.skipped.length ? `，跳过 ${r.skipped.length}：${r.skipped.slice(0, 3).map((x) => `#${x.task_id} ${x.reason}`).join("；")}` : ""));
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      setPicked([]); setIdsText("");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="加到测试集" open={open} onCancel={onClose} onOk={submit} confirmLoading={busy} width={900} okText="加进去">
      <Space direction="vertical" style={{ width: "100%" }}>
        <Alert type="info" showIcon message={
          <span>加进来的窗口<b>前后各 60 秒以后不进任何训练导出</b>（防相邻几秒漏进去；不给窗口 = 整个样本都不要）。
            挑的时候照顾多样性：体型、狗、场地、白天 / 夜里、不同日期都摊开，一只狗别超过总量 15%。
            标注要对着视频复核过，别直接用某个模型的预标（测试会偏向那个模型）。</span>} />
        <Space wrap>
          <Select showSearch optionFilterProp="label" placeholder="从项目里挑任务" style={{ width: 320 }}
            value={projectId ?? undefined} onChange={(v) => { setProjectId(v); setPicked([]); }}
            options={(projects ?? []).map((p) => ({ value: p.id, label: `#${p.id} ${p.name}` }))} />
          <span>或者直接填任务号：</span>
          <Input style={{ width: 200 }} placeholder="67845, 67846 …" value={idsText} onChange={(e) => setIdsText(e.target.value)} />
          {typedIds().length === 1 && <Button size="small" onClick={() => { setSegTask(typedIds()[0]); setSegPicked([]); }}>挑这个任务的事件</Button>}
        </Space>
        {projectId != null && (
          <Table<Task>
            size="small" rowKey="id" loading={isFetching} dataSource={tasks ?? []} pagination={{ pageSize: 8, showSizeChanger: false }}
            rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) }}
            columns={[
              { title: "任务", dataIndex: "id", width: 90 },
              { title: "样本", render: (_, t) => (t as Task & { sample_code?: string }).sample_code ?? t.sample_id },
              { title: "状态", dataIndex: "status", width: 110 },
              { title: "窗口", width: 140, render: (_, t) => (t.segment_start_ms != null && t.segment_end_ms != null
                ? `${fmtMs(t.segment_start_ms)}–${fmtMs(t.segment_end_ms)}` : "整个样本") },
              { title: "", width: 90, render: (_, t) => (
                <a onClick={(e) => { e.stopPropagation(); setSegTask(t.id); setSegPicked([]); }}>
                  {segTask === t.id ? <b>挑事件 ▾</b> : "挑事件"}
                </a>) },
            ]}
          />
        )}
        {segTask != null && (
          <div style={{ border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }}>
            <Space wrap style={{ marginBottom: 6 }}>
              <b>任务 #{segTask} 的标注片段</b>
              <Select size="small" style={{ width: 130 }} value={segTop} onChange={setSegTop} allowClear placeholder="全部大类"
                options={[...TOPS, "其他"].map((x) => ({ value: x, label: x }))} />
              <span style={{ color: "#888" }}>勾哪几个事件，每个加成一段（起止 = 事件起止，再按下面「凑够」前后延长）</span>
              <a onClick={() => { setSegTask(null); setSegPicked([]); }}>收起</a>
            </Space>
            <Table<TaskSeg>
              size="small" rowKey="id" loading={segLoading} dataSource={segShown} pagination={{ pageSize: 8, showSizeChanger: false }}
              rowSelection={{ selectedRowKeys: segPicked, onChange: (k) => setSegPicked(k as number[]) }}
              columns={[
                { title: "类别", render: (_, x) => <span>{x.label}{x.uncertain && <Tag color="gold" style={{ marginLeft: 4 }}>待定</Tag>}</span> },
                { title: "起止", render: (_, x) => `${fmtMs(x.start_ms)}–${fmtMs(x.end_ms)}` },
                { title: "时长", render: (_, x) => fmtSec((x.end_ms - x.start_ms) / 1000) },
              ]}
            />
          </div>
        )}
        <Space wrap>
          <span>时间窗口（可空 = 整个任务）：</span>
          <Input style={{ width: 100 }} placeholder="开始 1:30" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>—</span>
          <Input style={{ width: 100 }} placeholder="结束 2:30" value={to} onChange={(e) => setTo(e.target.value)} />
          <Tooltip title="围绕起止前后各延长一半凑够这么长（碰到样本头尾就往另一边补）。比如 10 秒抓挠凑成 60 秒：窗口里有事件前后的上下文，模型报早报晚、起止准不准（交并比）才测得出来。空 = 不延长">
            <span>凑够 <InputNumber size="small" min={1} max={3600} style={{ width: 80 }} value={padSec} onChange={(v) => setPadSec(v)} /> 秒</span>
          </Tooltip>
          <Input style={{ width: 220 }} placeholder="备注（为什么挑它，可空）" value={note} onChange={(e) => setNote(e.target.value)} />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          勾了事件就按事件加（上面的时间窗口不用填）；否则窗口对这次选中的所有任务都一样。不超过 3 分钟算「短片段」，否则「长片段」。
          延长出来的那部分也要标全（休息、活动也标），不然模型在那里报的会算误报。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── 按条件挑 ─────────────────────────
const SITE_NAMES = ["公司影棚", "佛山博朗旺狗场", "深圳雷诺狗场"];
/** 从已有的标注片段（人工标过的 / AI 预标的）里按条件挑，凑窗口，先看配比再加进来 */
function ComposeModal({ setId, open, onClose }: { setId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: tree } = useQuery({ queryKey: ["mt-label-tree"], queryFn: getLabelTree, enabled: open });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs, enabled: open });
  const { data: mvs } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions, enabled: open });
  const [labels, setLabels] = useState<string[]>(["抓挠"]);
  const [sites, setSites] = useState<string[]>([]);
  const [dogIds, setDogIds] = useState<number[]>([]);
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [source, setSource] = useState<"any" | "human" | "ai">("any");
  const [seenMode, setSeenMode] = useState<"any" | "unseen" | "seen">("any");
  const [modelIds, setModelIds] = useState<number[]>([56, 61, 62]);
  const [perGroup, setPerGroup] = useState(10);
  const [maxTotal, setMaxTotal] = useState(200);
  const [padSec, setPadSec] = useState(60);
  const [minSec, setMinSec] = useState(0);
  const [seed, setSeed] = useState(1);
  const [mode, setMode] = useState<"positive" | "negative">("positive");
  const [anchors, setAnchors] = useState<string[]>([]);
  const [perDog, setPerDog] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ stats: ComposeStats; warnings: string[] } | null>(null);

  const treeData = useMemo(() => {
    const kids = new Map<string | null, { name: string; parent: string | null }[]>();
    (tree ?? []).forEach((x) => kids.set(x.parent, [...(kids.get(x.parent) ?? []), x]));
    type Node = { title: string; value: string; children: Node[] };
    const build = (p: string | null, depth = 0): Node[] =>
      depth > 4 ? [] : (kids.get(p) ?? []).map((x) => ({ title: x.name, value: x.name, children: build(x.name, depth + 1) }));
    return build(null);
  }, [tree]);

  const body = (): ComposeBody => ({
    label_names: labels, sites: sites.length ? sites : undefined, dog_ids: dogIds.length ? dogIds : undefined,
    date_from: range?.[0]?.format("YYYY-MM-DD") ?? null, date_to: range?.[1]?.format("YYYY-MM-DD") ?? null,
    source, seen_mode: seenMode, model_ids: seenMode === "any" ? undefined : modelIds,
    per_group: perGroup, max_total: maxTotal, pad_sec: padSec, min_sec: minSec, seed,
    mode, anchor_names: mode === "negative" && anchors.length ? anchors : undefined, per_dog: perDog,
  });
  const preview = async () => {
    if (!labels.length) return message.warning("至少选一个类别");
    setBusy(true);
    try { setRes(await composePreview(setId, body())); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await composeApply(setId, body());
      message.success(`加了 ${r.added} 段`);
      qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
      qc.invalidateQueries({ queryKey: ["model-test-sets"] });
      onClose();
    } finally { setBusy(false); }
  };

  const st = res?.stats;
  const leafs = st ? Array.from(new Set(Object.values(st.by_dog_label).flatMap((m) => Object.keys(m)))).sort() : [];
  const dogRows = st ? Object.keys({ ...st.available }).sort() : [];
  return (
    <Modal title="按条件挑片段" open={open} onCancel={onClose} width={1100}
      footer={<Space>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={preview} loading={busy}>预览配比</Button>
        <Button type="primary" disabled={!st?.n_picked} loading={busy} onClick={apply}>加进测试集（{st?.n_picked ?? 0} 段）</Button>
      </Space>}>
      <Space direction="vertical" style={{ width: "100%" }}>
        <Alert type="info" showIcon message={
          <span>从<b>已有的标注片段</b>里挑（以前人工标过的，或 AI 预标的），片段前后延长凑成窗口，挂在原任务上——不建新任务、不用从零标。
            加进来以后在「片段」里点「看 / 标」核对：片段起止、类别不对就调，窗口里漏的补上，然后勾「核对」。打分可以只用核对过的。</span>} />
        <Space wrap>
          <span>类别：</span>
          <TreeSelect style={{ minWidth: 360 }} treeData={treeData} value={labels} onChange={(v) => setLabels(v as string[])}
            treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} placeholder="比如 抓挠 / 抓挠-头颈耳 / 抓挠-躯干" maxTagCount={6} />
          <Tooltip title="选上一级就含下面所有细类；只要某个部位就只勾那个部位">
            <span style={{ color: "#888" }}>（勾大类 = 含全部部位）</span>
          </Tooltip>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} optionType="button" buttonStyle="solid"
            options={[{ value: "positive", label: "有这类" }, { value: "negative", label: "无这类" }]} />
        </Space>
        {mode === "negative" && (
          <Space wrap>
            <Tooltip title="「无抓挠」窗口以哪类片段为中心：选相似动作（舔、甩头、啃）就是考模型会不会把它们误当抓挠；选活动 / 休息就是一般情况。不选 = 任何别的类别。窗口里这个样本所有任务都不能有选的类别（待定的也不行）">
              <span>以哪类片段为中心：</span>
            </Tooltip>
            <TreeSelect style={{ minWidth: 360 }} treeData={treeData} value={anchors} onChange={(v) => setAnchors(v as string[])}
              treeCheckable showCheckedStrategy={TreeSelect.SHOW_PARENT} allowClear placeholder="不选 = 任何别的类别（比如 舔 / 甩头/抖身 / 活动）" maxTagCount={6} />
          </Space>
        )}
        <Space wrap>
          <span>窗口时长：</span>
          <Radio.Group value={[60, 300, 600].includes(padSec) ? padSec : -1} optionType="button"
            onChange={(e) => { if (e.target.value > 0) setPadSec(e.target.value); }}
            options={[{ value: 60, label: "1 分钟" }, { value: 300, label: "5 分钟" }, { value: 600, label: "10 分钟" }, { value: -1, label: "自定义" }]} />
          <InputNumber min={5} max={3600} value={padSec} onChange={(v) => setPadSec(v ?? 60)} addonAfter="秒" style={{ width: 130 }} />
          <span style={{ color: "#888", fontSize: 12 }}>
            {mode === "positive" ? "事件比窗口短就前后延长；长时间的事件不截，留完整过程" : "中心片段比窗口长就在里面截一段"}
          </span>
        </Space>
        <Space wrap>
          <span>场地：</span>
          <Select mode="multiple" style={{ minWidth: 260 }} placeholder="全部" value={sites} onChange={setSites}
            options={SITE_NAMES.map((x) => ({ value: x, label: x }))} />
          <span>狗：</span>
          <Select mode="multiple" style={{ minWidth: 320 }} placeholder="全部" value={dogIds} onChange={setDogIds} optionFilterProp="label"
            options={(dogs ?? []).filter((d) => !sites.length || sites.includes(d.site ?? ""))
              .map((d) => ({ value: d.id, label: `${d.name ?? d.dog_code}（${d.size ?? "?"}·${(d.site ?? "").slice(0, 2)}）` }))} />
          <span>日期：</span>
          <DatePicker.RangePicker value={range as never} onChange={(v) => setRange(v as never)} allowEmpty={[true, true]} />
        </Space>
        <Space wrap>
          <span>片段来源：</span>
          <Radio.Group value={source} onChange={(e) => setSource(e.target.value)} optionType="button" size="small"
            options={[{ value: "any", label: "都要（人工优先）" }, { value: "human", label: "只要人工标过的" }, { value: "ai", label: "只要 AI 预标的" }]} />
          <span>模型见没见过：</span>
          <Radio.Group value={seenMode} onChange={(e) => setSeenMode(e.target.value)} optionType="button" size="small"
            options={[{ value: "any", label: "不管" }, { value: "unseen", label: "没见过" }, { value: "seen", label: "见过" }]} />
          {seenMode !== "any" && (
            <Select mode="multiple" style={{ minWidth: 260 }} value={modelIds} onChange={setModelIds} placeholder="相对哪些模型"
              options={(mvs ?? []).filter((m) => m.status === "done").map((m) => ({ value: m.id, label: `#${m.id} train${m.algo_job_id}` }))} />
          )}
        </Space>
        <Space wrap>
          <span>每只狗 × 每个细类最多 <InputNumber size="small" min={1} max={500} value={perGroup} onChange={(v) => setPerGroup(v ?? 10)} /> 段</span>
          <span>每只狗最多 <InputNumber size="small" min={1} max={3000} value={perDog} placeholder="不限" onChange={(v) => setPerDog(v)} /> 段</span>
          <span>总共最多 <InputNumber size="small" min={1} max={3000} value={maxTotal} onChange={(v) => setMaxTotal(v ?? 200)} /> 段</span>
          <span>片段至少 <InputNumber size="small" min={0} max={3600} value={minSec} onChange={(v) => setMinSec(v ?? 0)} /> 秒</span>
          <Tooltip title="同样的条件和种子挑出来的一样；换个数字就换一批">
            <span>随机种子 <InputNumber size="small" min={1} value={seed} onChange={(v) => setSeed(v ?? 1)} /></span>
          </Tooltip>
        </Space>
        {res?.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />)}
        {st && (
          <>
            <Space wrap>
              <span>符合条件的片段 <b>{st.n_found}</b> 条，挑出 <b>{st.n_picked}</b> 段，视频 <b>{st.video_hours}</b> 小时</span>
              {Object.entries(st.by_site).map(([k, n]) => <Tag key={k} color="blue">{k} {n}</Tag>)}
              {Object.entries(st.by_source).map(([k, n]) => <Tag key={k} color={k === "人工标过" ? "green" : "orange"}>{k} {n}</Tag>)}
              <span style={{ color: "#888" }}>日期 {Object.keys(st.by_date).length} 天</span>
            </Space>
            <Table size="small" bordered pagination={false} rowKey="dog" scroll={{ x: true }}
              dataSource={dogRows.map((dog) => ({ dog }))}
              columns={[
                { title: "狗", dataIndex: "dog", fixed: "left", render: (v: string) => `${v}${st.dogs[v]?.size ? `（${st.dogs[v].size}）` : ""}` },
                ...leafs.map((lf) => ({
                  title: lf, key: lf,
                  render: (_: unknown, r: { dog: string }) => {
                    const n = st.by_dog_label[r.dog]?.[lf] ?? 0, a = st.available[r.dog]?.[lf] ?? 0;
                    return <Tooltip title={`挑了 ${n} 段 / 符合条件 ${a} 条`}><span style={{ color: n ? undefined : "#ccc" }}>{n}<span style={{ color: "#888", fontSize: 11 }}> /{a}</span></span></Tooltip>;
                  },
                })),
                { title: "合计", key: "sum", render: (_: unknown, r: { dog: string }) => <b>{Object.values(st.by_dog_label[r.dog] ?? {}).reduce((a, b) => a + b, 0)}</b> },
              ]} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>格子里「挑了 / 符合条件」。不满意就改条件再预览；同样的条件和种子，加进去的就是预览这批。</Typography.Text>
          </>
        )}
      </Space>
    </Modal>
  );
}

// ───────────────────────── 打分 ─────────────────────────
type EvalRow = { key: string; group: string; n: number; version: string; r: VersionResult };

/** 选哪些模型版本、哪个类别；默认只用「选中的模型都没见过」的样本 */
function useEvalPicker() {
  const [label, setLabel] = useState("抓挠");
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setScope] = useState<SeenScope>("unseen");
  const [iou, setIou] = useState(0.3);
  const [checkedOnly, setCheckedOnly] = useState(true);
  const { data: runs, refetch } = useQuery({ queryKey: ["eval-runs-all"], queryFn: () => listEvalRuns() });
  const options = (runs?.runs ?? []).map((r) => ({
    value: `${r.model_tag}::${r.mode}`, label: `${r.model_tag} · ${modeLabelOf(r.mode)}（跑过 ${r.n_samples} 个样本）`,
  }));
  const versions = picked.map((p) => { const [model_tag, mode] = p.split("::"); return { model_tag, mode }; });
  return { label, setLabel, picked, setPicked, scope, setScope, iou, setIou, checkedOnly, setCheckedOnly, options, versions, refetchRuns: refetch };
}

/** 打分用哪些样本：选中的模型都没见过的 / 至少一个见过的 / 全部 / 两部分分开各打一次 */
type SeenScope = "unseen" | "seen" | "all" | "split";
const SCOPE_OPTIONS = [
  { value: "unseen", label: "只用没见过的（正式成绩）" },
  { value: "seen", label: "只用见过的（训练用过）" },
  { value: "all", label: "全部" },
  { value: "split", label: "见过 / 没见过 分开看" },
];
/** 按范围把样本分成几份：[名字, 样本 id] */
async function scopeParts(setId: number, items: TestItem[], tags: string[], scope: SeenScope, notes: string[], prefix = "") {
  const all = Array.from(new Set(items.map((i) => i.sample_id)));
  if (scope === "all") return [[`${prefix}全部`, all]] as [string, number[]][];
  const { seenSamples, unknown } = await seenSamplesOf(setId, items, tags);
  if (unknown.length) notes.push(`${unknown.join("、")} 对不上训练记录，见没见过不知道（都算没见过）`);
  const seen = all.filter((s) => seenSamples.has(s));
  const unseen = all.filter((s) => !seenSamples.has(s));
  notes.push(`${prefix}选中的模型见过 ${seen.length} 个样本、都没见过 ${unseen.length} 个`);
  if (scope === "seen") return [[`${prefix}见过`, seen]] as [string, number[]][];
  if (scope === "unseen") return [[`${prefix}没见过`, unseen]] as [string, number[]][];
  return [[`${prefix}没见过`, unseen], [`${prefix}见过`, seen]] as [string, number[]][];
}

/** 一批测试集里，选中模型见过的样本（按训练记录的数据集算）。认不出训练记录的模型返回 unknown */
async function seenSamplesOf(setId: number, items: TestItem[], tags: string[]) {
  const mvs = await listModelVersions();
  const jobIds = tags.map(jobIdOfTag);
  const unknown = tags.filter((_, i) => jobIds[i] == null || !mvs.some((m) => m.algo_job_id === jobIds[i]));
  const ids = mvs.filter((m) => jobIds.includes(m.algo_job_id)).map((m) => m.id);
  const seenItems = new Set<number>();
  if (ids.length) {
    const r = await getTestSeen(setId, ids);
    r.models.forEach((m) => m.seen_item_ids.forEach((i) => seenItems.add(i)));
  }
  const seenSamples = new Set(items.filter((it) => seenItems.has(it.id)).map((it) => it.sample_id));
  return { seenSamples, unknown: Array.from(new Set(unknown)) };
}

function EvalPickerBar({ p, extra }: { p: ReturnType<typeof useEvalPicker>; extra?: ReactNode }) {
  return (
    <Space wrap>
      <Select style={{ width: 130 }} value={p.label} onChange={p.setLabel} options={EVAL_LABELS.map((x) => ({ value: x, label: x }))} />
      <Select mode="multiple" style={{ minWidth: 420 }} placeholder="选要比的模型版本（要先在这批样本上跑过）"
        value={p.picked} onChange={p.setPicked} options={p.options} maxTagCount={3} />
      <Tooltip title="重叠多少算同一段：0.3 宽松，起止差一点也认；想严格看边界调到 0.5 以上">
        <span>IoU ≥ <InputNumber size="small" min={0.05} max={0.95} step={0.05} value={p.iou} onChange={(v) => p.setIou(v ?? 0.3)} /></span>
      </Tooltip>
      <Tooltip title="见过 = 样本在选中的任一模型的训练数据里。正式成绩看「没见过」；跟「见过」差得多说明模型在背答案">
        <Select style={{ width: 210 }} value={p.scope} onChange={(v) => p.setScope(v as SeenScope)} options={SCOPE_OPTIONS} />
      </Tooltip>
      <Tooltip title="正确答案只认人工核对过的片段（看过窗口、该调的调了）。没核对的里面可能还是没改过的 AI 预标">
        <Checkbox checked={p.checkedOnly} onChange={(e) => p.setCheckedOnly(e.target.checked)}>只用核对过的</Checkbox>
      </Tooltip>
      {extra}
    </Space>
  );
}

const evalColumns = (groupTitle: string) => [
  { title: groupTitle, dataIndex: "group", width: 140 },
  { title: "样本", dataIndex: "n", width: 70 },
  { title: "版本", dataIndex: "version" },
  { title: "精确率", render: (_: unknown, x: EvalRow) => pct(x.r.precision) },
  { title: "召回率", render: (_: unknown, x: EvalRow) => pct(x.r.recall) },
  { title: "F1", render: (_: unknown, x: EvalRow) => <b>{pct(f1(x.r.precision, x.r.recall))}</b> },
  { title: "命中 / 误报 / 漏报", render: (_: unknown, x: EvalRow) => `${x.r.tp} / ${x.r.fp} / ${x.r.fn}` },
  { title: "跑了几个", render: (_: unknown, x: EvalRow) => (
    <span style={{ color: x.r.n_samples_with_result < x.n ? "#ff4d4f" : undefined }}>{x.r.n_samples_with_result}/{x.n}</span>) },
];

function EvalTab({ setId, items: allItems }: { setId: number; items: TestItem[] }) {
  const p = useEvalPicker();
  const items = useMemo(() => (p.checkedOnly ? allItems.filter((i) => i.checked) : allItems), [allItems, p.checkedOnly]);
  const { options: modeOptions } = useInferModes();
  const [runModes, setRunModes] = useState<string[]>([]);
  const [bySize, setBySize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const { data: prog, refetch: refetchProg } = useQuery({
    queryKey: ["eval-run-progress"], queryFn: getEvalRunProgress,
    refetchInterval: 5000,
  });
  useEffect(() => { if (prog?.status === "done") p.refetchRuns(); }, [prog?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // 跑推理按全部片段的样本跑（核对没核对都先跑上），打分时再按核对筛
  const allSamples = useMemo(() => Array.from(new Set(allItems.map((i) => i.sample_id))), [allItems]);

  const run = async () => {
    if (!runModes.length) return message.warning("选要跑的版本");
    const r = await startEvalRun({ sample_ids: allSamples, modes: runModes });
    message[r.started ? "success" : "warning"](r.started ? `开始跑：${r.n_samples} 个样本 × ${r.modes.length} 个版本` : "已经有一批在跑了，等它跑完");
    refetchProg();
  };

  const score = async () => {
    if (!p.versions.length) return message.warning("选要比的版本");
    if (!items.length) return message.warning(p.checkedOnly ? "还没有核对过的片段：先在「片段」里看 / 标并勾「核对」，或者去掉「只用核对过的」" : "没有片段");
    setBusy(true);
    try {
      const ns: string[] = [];
      if (p.checkedOnly) ns.push(`只用核对过的 ${items.length} / ${allItems.length} 段`);
      const parts = await scopeParts(setId, items, p.versions.map((v) => v.model_tag), p.scope, ns);
      const groups: [string, number[]][] = [];
      for (const [pname, use] of parts) {
        groups.push([pname, use]);
        if (bySize) {
          for (const sz of [...SIZES, null]) {
            const ids = Array.from(new Set(items.filter((i) => (sz == null ? !SIZES.includes(i.size ?? "") : i.size === sz)
              && use.includes(i.sample_id)).map((i) => i.sample_id)));
            if (ids.length) groups.push([`${pname}·${sz == null ? "体型未知" : `${sz}型犬`}`, ids]);
          }
        }
      }
      const out: EvalRow[] = [];
      for (const [g, ids] of groups) {
        if (!ids.length) continue;
        const r = await compareModels({ sample_ids: ids, versions: p.versions, label: p.label, iou_min: p.iou, windows: windowsOf(items, ids), task_ids: taskIdsOf(items, ids) });
        r.warnings.forEach((w) => ns.push(`${g}：${w}`));
        r.versions.forEach((v) => out.push({ key: `${g}-${v.key}`, group: g, n: ids.length, version: `${v.model_tag} · ${modeLabelOf(v.mode)}`, r: v }));
      }
      setRows(out);
      setNotes(ns);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={
        <span>打分按事件配对（跟「模型训练 → 模型对比」一样），<b>只算挑的时间窗口里的</b>：窗口外的标注和预测都不算，
          跨窗口边的段在边上切开。先「跑」：让选中的版本在测试集样本上推理一遍（推理按整个样本跑，前后有上下文）；跑完再「打分」。
          IoU 门槛调高（如 0.5）就是在考起止准不准。</span>} />
      <Space wrap>
        <Select mode="multiple" style={{ minWidth: 420 }} placeholder="要跑的版本" value={runModes} onChange={setRunModes}
          options={modeOptions as never} maxTagCount={3} />
        <Button onClick={run} disabled={prog?.status === "running"}>在测试集上跑（{allSamples.length} 个样本）</Button>
        {prog?.status === "running" && <Tag color="processing">在跑 {prog.done}/{prog.total}{prog.current ? ` · ${prog.current}` : ""}</Tag>}
      </Space>
      <EvalPickerBar p={p} extra={<>
        <Checkbox checked={bySize} onChange={(e) => setBySize(e.target.checked)}>按体型拆开</Checkbox>
        <Button type="primary" loading={busy} onClick={score}>打分</Button>
      </>} />
      {notes.map((n) => <Alert key={n} type="warning" showIcon message={n} />)}
      <Table size="small" rowKey="key" pagination={false} dataSource={rows} columns={evalColumns("范围")} />
    </Space>
  );
}

/** 多批交叉对比：同一组模型在几批测试集上各打一次分，看平均和波动——只在一批上好，可能是那一批碰巧 */
function CrossTab({ sets }: { sets: TestSet[] }) {
  const p = useEvalPicker();
  const [setIds, setSetIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  const score = async () => {
    if (setIds.length < 2) return message.warning("至少选两批测试集");
    if (!p.versions.length) return message.warning("选要比的版本");
    setBusy(true);
    try {
      const out: EvalRow[] = [];
      const ns: string[] = [];
      for (const sid of setIds) {
        const s = sets.find((x) => x.id === sid)!;
        const got = await getTestItems(sid);
        const items = p.checkedOnly ? got.items.filter((i) => i.checked) : got.items;
        if (p.checkedOnly) ns.push(`「${s.name}」只用核对过的 ${items.length} / ${got.items.length} 段`);
        if (!items.length) continue;
        const parts = await scopeParts(sid, items, p.versions.map((v) => v.model_tag), p.scope, ns, `「${s.name}」`);
        for (const [pname, use] of parts) {
          if (!use.length) { ns.push(`${pname}没有可用样本`); continue; }
          const r = await compareModels({ sample_ids: use, versions: p.versions, label: p.label, iou_min: p.iou, windows: windowsOf(items, use), task_ids: taskIdsOf(items, use) });
          r.versions.forEach((v) => out.push({ key: `${sid}-${pname}-${v.key}`, group: parts.length > 1 ? `${s.name}·${pname.replace(`「${s.name}」`, "")}` : s.name, n: use.length, version: `${v.model_tag} · ${modeLabelOf(v.mode)}`, r: v }));
        }
      }
      setRows(out);
      setNotes(Array.from(new Set(ns)));
    } finally {
      setBusy(false);
    }
  };

  // 每个版本：几批的 F1 / 精确率 / 召回率 平均 ± 标准差
  const summary = useMemo(() => {
    const by = new Map<string, EvalRow[]>();
    // 分开看时，见过 / 没见过各算各的平均，不混在一起
    const keyOf = (r: EvalRow) => r.version + (r.group.endsWith("·见过") ? "（见过）" : r.group.endsWith("·没见过") ? "（没见过）" : "");
    rows.forEach((r) => by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]));
    return Array.from(by.entries()).map(([version, rs]) => {
      const P = rs.map((x) => x.r.precision), R = rs.map((x) => x.r.recall), F = rs.map((x) => f1(x.r.precision, x.r.recall));
      return { version, n: rs.length, P, R, F };
    });
  }, [rows]);
  const ms = (xs: number[]) => `${pct(mean(xs))} ± ${(std(xs) * 100).toFixed(1)}`;

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert type="info" showIcon message={
        <span>交叉验证：同一组模型在<b>几批互不重叠</b>的测试集上各打一次分，看平均和波动（±）。
          波动大说明结论不稳：要么某批数据太少，要么模型对某些狗 / 场景特别差。
          几批最好按不同的狗 / 日期分，别是同一批数据随便切几刀。</span>} />
      <Space wrap>
        <Select mode="multiple" style={{ minWidth: 320 }} placeholder="选几批测试集" value={setIds} onChange={setSetIds}
          options={sets.map((s) => ({ value: s.id, label: `${s.name}（${s.n_samples} 个样本）${s.frozen ? " · 已冻结" : ""}` }))} />
      </Space>
      <EvalPickerBar p={p} extra={<Button type="primary" loading={busy} onClick={score}>打分</Button>} />
      {notes.map((n) => <Alert key={n} type="warning" showIcon message={n} />)}
      {summary.length > 0 && (
        <Table size="small" rowKey="version" pagination={false} dataSource={summary}
          columns={[
            { title: "版本", dataIndex: "version" },
            { title: "批数", dataIndex: "n", width: 60 },
            { title: "F1 平均 ± 标准差", render: (_, x) => <b>{ms(x.F)}</b> },
            { title: "精确率", render: (_, x) => ms(x.P) },
            { title: "召回率", render: (_, x) => ms(x.R) },
            { title: "最差一批 F1", render: (_, x) => pct(Math.min(...x.F)) },
          ]} />
      )}
      <Table size="small" rowKey="key" pagination={false} dataSource={rows} columns={evalColumns("测试集")} />
    </Space>
  );
}

// ───────────────────────── 见没见过 ─────────────────────────
function SeenTab({ setId }: { setId: number }) {
  const [ids, setIds] = useState<number[]>([]);
  const { data: mvs } = useQuery({ queryKey: ["model-versions"], queryFn: listModelVersions });
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["model-test-seen", setId, ids], queryFn: () => getTestSeen(setId, ids), enabled: false,
  });
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        「见过」= 这段所在的样本在模型训练用的数据集里。不选就看「上架的 + 最近 5 个训练完的」。正式成绩只看没见过的。
      </Typography.Text>
      <Space wrap>
        <Select mode="multiple" style={{ minWidth: 420 }} placeholder="选训练记录（可空）" value={ids} onChange={setIds}
          options={(mvs ?? []).filter((m) => m.status === "done").map((m) => ({ value: m.id, label: `#${m.id} train${m.algo_job_id} ${m.model_version ?? ""}` }))} />
        <Button type="primary" loading={isFetching} onClick={() => refetch()}>查</Button>
      </Space>
      {data && (
        <Table size="small" rowKey="model_id" pagination={false} dataSource={data.models}
          columns={[
            { title: "训练记录", render: (_, m) => <span>#{m.model_id} train{m.algo_job_id} {m.listed && <Tag color="green">已启用</Tag>}</span> },
            { title: "版本", dataIndex: "model_version" },
            { title: "没见过", render: (_, m) => <b style={{ color: "#52c41a" }}>{m.n_unseen}</b> },
            { title: "见过", render: (_, m) => <span style={{ color: m.n_seen ? "#ff4d4f" : undefined }}>{m.n_seen}</span> },
            { title: "训练数据集", render: (_, m) => (
              <Space size={2} wrap>
                {m.datasets.map((d) => <Tag key={d} color={m.missing_datasets.includes(d) ? "red" : undefined}>
                  {d}{m.missing_datasets.includes(d) ? "（找不到导出文件，不知道）" : ""}</Tag>)}
              </Space>) },
          ]} />
      )}
    </Space>
  );
}

// ───────────────────────── 一批测试集 ─────────────────────────
function SetDetail({ setId }: { setId: number }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);
  const [wsWin, setWsWin] = useState<{ startMs: number; endMs: number } | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["model-test-items", setId], queryFn: () => getTestItems(setId) });
  // 在这一页直接打开工作台看 / 标：开在窗口开头。没认领时只读，工作台里点「认领」就能标
  const userId = useAuthStore((st) => st.userInfo?.id);
  const role = useAuthStore((st) => st.userInfo?.role);
  // 管理员 / 超管不用认领，没通过的任务直接改（后端 save_draft 放行）；已通过的要先「继续编辑」
  const isAdmin = role === "admin" || role === "super_admin";
  const [wsTask, setWsTask] = useState<Task | null>(null);
  const [wsLabels, setWsLabels] = useState<LabelDefinition[]>([]);
  const [wsSeekMs, setWsSeekMs] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const openTask = async (taskId: number, seekMs: number, endMs?: number) => {
    setOpening(taskId);
    try {
      const t = await getTask(taskId);
      setWsLabels(await listLabels(t.project_id));
      setWsSeekMs(seekMs);
      // 挂在原任务（整段样本）上的窗口：工作台顶上提示只看这一段
      setWsWin(endMs != null ? { startMs: seekMs, endMs } : null);
      setWsTask(t);
    } finally {
      setOpening(null);
    }
  };
  const closeWs = () => {
    setWsTask(null);
    // 标了东西回来，覆盖率 / 配额表跟着变
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
  };
  if (isLoading || !data) return <Table loading />;
  const frozen = data.set.frozen;
  const colors = data.colors ?? {};
  // 没配颜色的（「其他」之类）给个中性灰，免得一片白看不出来
  const colorOf = (k: string): string | undefined => colors[k] ?? (k === "其他" ? "#8c8c8c" : undefined);
  const labelRank = (k: string) => { const i = TOPS.indexOf(k); return i < 0 ? 99 : i; };
  const del = async (id: number) => {
    await deleteTestItem(id);
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
    qc.invalidateQueries({ queryKey: ["model-test-sets"] });
  };
  const toggleCheck = async (id: number, checked: boolean) => {
    await checkTestItem(id, checked);
    qc.invalidateQueries({ queryKey: ["model-test-items", setId] });
  };
  return (
    <>
      <Tabs defaultActiveKey="plan" items={[
        { key: "plan", label: "选样", children: (
          <ModelTestPlan setId={setId} initial={data.set.plan ?? null} frozen={frozen} existing={data.items.length}
            accent={colors[data.set.plan?.target ?? "抓挠"] ?? "#27AE60"} />) },
        { key: "cov", label: "配额表", children: data.items.length ? <CoverageView cov={data.coverage} /> : <Empty description="还没有片段：点「片段」→「加片段」" /> },
        {
          key: "items", label: `片段 ${data.items.length}`, children: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space>
                <Tooltip title="按场地 / 狗 / 日期 / 类别（含部位）从已有的标注片段里挑，先看配比再加">
                  <Button disabled={frozen} onClick={() => setComposing(true)}>按条件挑</Button>
                </Tooltip>
                <Button disabled={frozen} onClick={() => setAdding(true)}>手动加</Button>
                {frozen && <Typography.Text type="secondary">这一版已冻结；要补数据先「复制成新版本」</Typography.Text>}
              </Space>
              <Table<TestItem>
                size="small" rowKey="id" dataSource={data.items} pagination={{ pageSize: 50 }} scroll={{ x: 1200 }}
                columns={[
                  { title: <Tooltip title="人工看过这段窗口、片段该调的调了，就勾上。打分默认只用核对过的">核对</Tooltip>, width: 60,
                    render: (_, r) => <Checkbox checked={!!r.checked} disabled={frozen} onChange={(e) => toggleCheck(r.id, e.target.checked)} /> },
                  { title: "任务", dataIndex: "task_id", width: 80 },
                  { title: "项目", dataIndex: "project_name", width: 160, ellipsis: true },
                  { title: "日期", dataIndex: "date", width: 100 },
                  { title: "场地", dataIndex: "site", width: 120 },
                  { title: "狗", width: 130, render: (_, r) => (
                    <span>{r.dog_name ?? "未知"}{r.size ? `（${r.size}）` : ""}
                      {r.dog_source === "推断" && <Tooltip title="按场地 + IMU 号推断的"><Tag style={{ marginLeft: 4 }}>推断</Tag></Tooltip>}
                      {r.dog_unsure && <Tooltip title="老影棚数据，推断常对不上：按狗 / 体型统计不可靠"><Tag color="red">不可靠</Tag></Tooltip>}
                    </span>) },
                  { title: "窗口", width: 140, render: (_, r) => `${fmtMs(r.start_ms)}–${fmtMs(r.end_ms)}` },
                  { title: "长短", dataIndex: "kind", width: 80 },
                  { title: "标了什么", render: (_, r) => (
                    <Space size={4} wrap>
                      {/* 颜色跟工作台里的标签一样；抓挠排最前。实心 = 已有片段，虚线框 = 疑似片段待判 */}
                      {Object.entries(r.labels).sort(([a], [b]) => labelRank(a) - labelRank(b)).map(([k, v]) => (
                        <Tag key={k} color={colorOf(k)} style={TAG_SOLID}>{k} {v.n}次 · {fmtSec(v.sec)}</Tag>))}
                      {r.n_uncertain > 0 && <Tag color="gold" style={TAG_SOLID}>待定 {r.n_uncertain}</Tag>}
                      {Object.entries(r.cands ?? {}).map(([k, v]) => (v.pending ?? 0) > 0 && (
                        <Tooltip key={`c-${k}`} title="疑似片段（还没判）：工作台往下滚到「疑似片段」面板，确认 / 排除 / 调起止">
                          <Tag style={{ ...TAG_SOLID, background: "transparent", color: colorOf(k) ?? "#2f54eb",
                            border: `1.5px dashed ${colorOf(k) ?? "#2f54eb"}` }}>？疑似{k} {v.pending} 待判</Tag>
                        </Tooltip>))}
                      {!Object.keys(r.labels).length && !Object.values(r.cands ?? {}).some((v) => (v.pending ?? 0) > 0)
                        && <span style={{ color: "#ff4d4f" }}>窗口里没有标注</span>}
                    </Space>) },
                  { title: <Tooltip title="窗口里有多少时间标了东西。测试数据要窗口内全标，低于 80% 标红">标注覆盖</Tooltip>, width: 90,
                    render: (_, r) => <span style={{ color: r.label_cover < 0.8 ? "#ff4d4f" : undefined }}>{pct(r.label_cover)}</span> },
                  { title: "任务状态", dataIndex: "task_status", width: 100 },
                  { title: "备注", dataIndex: "note", width: 140, ellipsis: true },
                  { title: "", width: 130, fixed: "right", render: (_, r) => (
                    <Space size={8}>
                      <Tooltip title="打开工作台，从窗口开头放。管理员不用认领、直接改（已通过的要先「继续编辑」）；其他人认领了才能标">
                        <Button size="small" type="link" style={{ padding: 0 }} loading={opening === r.task_id}
                          onClick={() => openTask(r.task_id, r.start_ms, r.end_ms)}>看 / 标</Button>
                      </Tooltip>
                      {!frozen && <Popconfirm title="从测试集拿掉这段？" onConfirm={() => del(r.id)}><a>拿掉</a></Popconfirm>}
                    </Space>) },
                ]}
              />
            </Space>
          ),
        },
        { key: "seen", label: "模型见没见过", children: <SeenTab setId={setId} /> },
        { key: "eval", label: "打分", children: <EvalTab setId={setId} items={data.items} /> },
      ]} />
      {adding && <AddItemsModal setId={setId} open={adding} onClose={() => setAdding(false)} />}
      {composing && <ComposeModal setId={setId} open={composing} onClose={() => setComposing(false)} />}
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        initialSeekMs={wsSeekMs}
        focusWindow={wsWin}
        readOnly={!((isAdmin && wsTask?.status !== "APPROVED") || (wsTask?.status === "IN_PROGRESS" && wsTask?.locked_by === userId))}
        onClaim={
          wsTask && wsTask.status !== "APPROVED" && !isAdmin
            ? async () => setWsTask(await claimTask(wsTask.id))
            : undefined
        }
        onClose={closeWs}
        onSaved={() => qc.invalidateQueries({ queryKey: ["model-test-items", setId] })}
        onSubmitted={closeWs}
      />
    </>
  );
}

// ───────────────────────── 页面 ─────────────────────────
export default function ModelTest() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["model-test-sets"], queryFn: listTestSets });
  const sets = data?.sets ?? [];
  const [cur, setCur] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [copyOf, setCopyOf] = useState<TestSet | null>(null);
  const [copyName, setCopyName] = useState("");
  useEffect(() => { if (cur == null && sets.length) setCur(sets[0].id); }, [sets, cur]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["model-test-sets"] });
  const create = async () => {
    if (!name.trim()) return message.warning("给测试集起个名字，比如「测试集 v1」");
    const s = await createTestSet({ name: name.trim() });
    setName(""); refresh(); setCur(s.id);
  };
  const doCopy = async () => {
    if (!copyOf || !copyName.trim()) return message.warning("给新版本起个名字");
    const s = await copyTestSet(copyOf.id, { name: copyName.trim() });
    setCopyOf(null); setCopyName(""); refresh(); setCur(s.id);
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>模型测试</Typography.Title>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={
        <span>
          测试集是给模型「考试」的数据：<b>测试窗口前后各 60 秒以后不进任何训练导出</b>（整个任务加进来的，整个样本都不进；现在涉及 {data?.n_excluded_samples ?? 0} 个样本）。
          正式成绩只算模型<b>没见过</b>的；多样性优先（体型、狗、场地、白天 / 夜里、日期），数量按批补。
          一版定下来就「冻结」，补数据「复制成新版本」再加——报告注明用的哪一版，前后才比得了。
        </span>} />
      <Tabs items={[
        {
          key: "sets", label: "测试集", children: (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space>
                <Input style={{ width: 240 }} placeholder="新测试集名字，如「测试集 v1」" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} />
                <Button onClick={create}>新建</Button>
              </Space>
              <Table<TestSet>
                size="small" rowKey="id" pagination={false} dataSource={sets}
                rowClassName={(s) => (s.id === cur ? "ant-table-row-selected" : "")}
                onRow={(s) => ({ onClick: () => setCur(s.id), style: { cursor: "pointer" } })}
                columns={[
                  { title: "名字", dataIndex: "name" },
                  { title: "片段", dataIndex: "n_items", width: 70 },
                  { title: "样本", dataIndex: "n_samples", width: 70 },
                  { title: "状态", width: 170, render: (_, s) => (s.frozen ? <Tag color="blue">已冻结 {s.frozen_at?.slice(0, 16).replace("T", " ")}</Tag> : <Tag>可编辑</Tag>) },
                  { title: "备注", dataIndex: "note", ellipsis: true },
                  { title: "", width: 200, render: (_, s) => (
                    <Space onClick={(e) => e.stopPropagation()}>
                      {!s.frozen && (
                        <Popconfirm title="冻结后这一版不能再增删，确定？" onConfirm={async () => { await freezeTestSet(s.id); refresh(); }}>
                          <a>冻结</a>
                        </Popconfirm>)}
                      <a onClick={() => { setCopyOf(s); setCopyName(`${s.name} 补充`); }}>复制成新版本</a>
                      <Popconfirm
                        title={`删除测试集「${s.name}」？`}
                        description={<div style={{ maxWidth: 300 }}>
                          会删掉这个测试集和它的 {s.n_items} 条片段记录{s.frozen ? "（这一版已冻结，删了以后用它做的成绩就对不上版本了）" : ""}。
                          任务、标注、疑似片段都不动；这些窗口以后不再挡训练导出（别的测试集里还有的照样挡）。删了不能恢复。</div>}
                        okText="删除" okButtonProps={{ danger: true }}
                        onConfirm={async () => {
                          const r = await deleteTestSet(s.id);
                          message.success(`已删除「${s.name}」（${r.deleted_items} 条片段记录）`);
                          if (cur === s.id) setCur(null);
                          refresh();
                        }}>
                        <a style={{ color: "#ff4d4f" }}>删除</a>
                      </Popconfirm>
                    </Space>) },
                ]}
              />
              {cur != null && sets.some((s) => s.id === cur) && <SetDetail key={cur} setId={cur} />}
            </Space>
          ),
        },
        { key: "cross", label: "多批交叉对比", children: <CrossTab sets={sets} /> },
      ]} />
      <Modal title={`复制「${copyOf?.name ?? ""}」成新版本`} open={!!copyOf} onCancel={() => setCopyOf(null)} onOk={doCopy} okText="复制">
        <Input value={copyName} onChange={(e) => setCopyName(e.target.value)} placeholder="新版本名字" />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          原样复制所有片段，新版本可以继续加。原来那版不动。
        </Typography.Paragraph>
      </Modal>
    </div>
  );
}
