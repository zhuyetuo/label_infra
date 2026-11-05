import { useEffect, useMemo, useState } from "react";
import {
  Alert, AutoComplete, Button, Checkbox, DatePicker, Descriptions, Divider, Dropdown, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Segmented, Select, Slider, Space, Table, Tabs,
  Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";
import TrainReviewModal from "@/components/TrainReviewModal";
import { getSavedRange, saveRange } from "@/utils/persistedSize";
import { useAuthStore } from "@/stores/authStore";
import { claimTask, getTask } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import TrainLogModal from "@/components/TrainLogModal";
import SizeCurveModal from "@/components/SizeCurveModal";
import EdgeFootprint from "@/components/EdgeFootprint";
import { TRACKS, TRACK_NAME } from "@/utils/labelTree";
import { fmtSecs } from "@/utils/fmtDuration";
import ModelCompare from "@/components/ModelCompare";
import DataPoolPanel from "@/components/DataPoolPanel";
import ClassCompare from "@/components/ClassCompare";
import type { LabelDefinition, Task } from "@/types";
import {
  type DatasetCheck,
  checkDataset,
  datasetStats,
  type LabelStats,
  type LabelTreeNode,
  type DatasetSegment,
  getDatasetSegments,
  deleteDataset,
  activateModel, cancelModelVersion, downloadEdgeBundle, type EdgeBundleKind, exportModelEdge, setModelListed, type EdgeMetrics, type SizeCurve, deleteModelVersion, exportDataset, listDatasets, listModelVersions, submitTrain,
  trainRemap,
  type ModelVersion, type TrainDataset,
  type DatasetStats,
  type TrainReview,
  type TrainDiag,
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

const MODEL_TYPES = ["rf", "cnn", "xgb", "lgbm", "catboost", "extratrees", "histgb"];
const MODEL_TYPE_LABEL: Record<string, string> = { rf: "rf（随机森林）", cnn: "cnn（1D-CNN）" };

/**
 * 这一段到底是什么类别——取**叶子**（抓挠-躯干），不是根（抓挠）。
 *
 * 导出里存的是整条链 [抓挠, 抓挠-躯干]，而这一屏上面那排 chip（各类别段数）
 * 数的就是叶子。行里却一直显示 labels[0] = 根，于是：
 *   - 类别列永远只有「抓挠」，看不出标到了哪个部位
 *   - 点 chip「抓挠-躯干 15」筛出 0 行（拿叶子名去比根）
 * 两处都用叶子就对上了。老数据/老接口没有 labels，退回 label（那时它就是全部）。
 */
const leafOf = (r: DatasetSegment): string =>
  r.labels?.length ? r.labels[r.labels.length - 1] : r.label;

const EXPORT_RANGE_KEY = "export-date-range";

/** 一个训练类别至少要有这么多段，验证结果才有点参考价值。
 *  训练是按片段分组切分的（同一段不会一半进训练一半进验证），段数太少的话
 *  训练和验证各只分到一两段，模型只见过这一类的一两个样子 */
const MIN_SEGMENTS = 5;

/** 归并表的一行：这次数据里的一个类别（最细那一级） */
type TrainCat = { name: string; n: number; sec: number; root: string; chain: string[]; nShort?: number };
type TrainRow = TrainCat & { key: string; isGroup?: boolean; children?: TrainRow[] };

/** 提交训练时的那一套选项。按数据集记，另存一份"上一次"给没训过的数据集当起点 */
type TrainOpts = {
  modelType?: string;
  sourceHz?: number;
  hz?: number;
  axes?: number;
  orientFree?: boolean;
  /** 短促动作补齐的类别；undefined = 自动（有比窗口短的片段的训练类别） */
  shortLabels?: string[];
  edgeSize?: boolean;
  edgeTrees?: number | null;
  edgeDepth?: number | null;
  edgeFilters?: string;
  skipSyn?: boolean;
  balance?: string;
  /** 窗口 / 步长（秒），null = 按采样率自动；标签方式；模型超参 */
  windowS?: number | null;
  strideS?: number | null;
  labelMode?: "majority" | "center";
  modelParams?: ModelParams;
  extraDs?: string[];
  extraHz?: Record<string, number>;
  remapEdits?: Record<string, string>;
};
const TRAIN_OPTS_KEY = "train-submit-opts";
type ModelParams = { n_estimators?: number | null; max_depth?: number | null; min_samples_leaf?: number | null; max_features?: string | null };
/** 不填时算法侧按采样率挑的默认窗口 / 步长（跟 label_service/jobs.window_args 一致：整数点数，非整数时取 2 的幂） */
const autoWin = (hz: number, sec: number) => (Number.isInteger(sec * hz) ? sec : 2 ** Math.round(Math.log2(sec * hz)) / hz);

/** 归并习惯：某个类别上次训练时算作了什么（舔-大腿内侧 → 舔）。跨数据集记——
 *  新导的数据集里同名的类别直接按上次的来，不用每份都从头选一遍。"" = 上次选了不参与 */
const REMAP_HABITS_KEY = "train-remap-habits";
function loadRemapHabits(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(REMAP_HABITS_KEY) || "null");
    if (v && typeof v === "object") return v;
  } catch {
    // 坏了当没记过
  }
  return {};
}
function saveRemapHabits(edits: Record<string, string>) {
  try {
    localStorage.setItem(REMAP_HABITS_KEY, JSON.stringify({ ...loadRemapHabits(), ...edits }));
  } catch {
    // 存不下不影响训练
  }
}

function loadTrainOpts(): { byDataset: Record<string, TrainOpts>; last: TrainOpts | null } {
  try {
    const v = JSON.parse(localStorage.getItem(TRAIN_OPTS_KEY) || "null");
    if (v && typeof v === "object") return { byDataset: v.byDataset ?? {}, last: v.last ?? null };
  } catch {
    // 存的东西坏了不该让弹窗打不开，当没存过
  }
  return { byDataset: {}, last: null };
}

function saveTrainOpts(dataset: string, opts: TrainOpts) {
  try {
    const cur = loadTrainOpts();
    // 先删再插：对象的键按**首次**插入的顺序排，直接覆盖不会把它挪到末尾，
    // 下面"只留最近 30 份"就会把刚用过的那份当成最老的删掉
    delete cur.byDataset[dataset];
    cur.byDataset[dataset] = opts;
    // 数据集会越攒越多：只留最近 30 份的，免得 localStorage 被撑满
    const names = Object.keys(cur.byDataset);
    if (names.length > 30) {
      for (const n of names.slice(0, names.length - 30)) delete cur.byDataset[n];
    }
    const { modelType, sourceHz, hz, axes, orientFree, shortLabels, edgeSize, skipSyn, edgeTrees, edgeDepth, edgeFilters, balance } = opts;
    cur.last = { modelType, sourceHz, hz, axes, orientFree, shortLabels, edgeSize, skipSyn, edgeTrees, edgeDepth, edgeFilters, balance };
    localStorage.setItem(TRAIN_OPTS_KEY, JSON.stringify(cur));
  } catch {
    // 存不了就算了，不影响这次提交
  }
}

/** 「不参与训练」那一项的值。存进表里是空字符串，但空字符串当不了 Select 的
 *  value（antd 当成"没选"），所以下拉里用这个哨兵 */
const DROP = "__drop__";
/** 下拉选项按 value 去重，留第一个（上级排在前面，同名的「并进 X」就不再出现） */
const dedupeOpts = <T extends { value: string }>(opts: T[]): T[] => {
  const seen = new Set<string>();
  return opts.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
};
/** 大类那一行「整组各自成一类」的哨兵值 */
const KEEP_EACH = "__keep_each__";

/** "32,64,128" / "32/64/128" → [32,64,128]；填得不对就 null（用默认） */
function parseFilters(s: string): number[] | null {
  const xs = s.split(/[,，/\s]+/).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0);
  return xs.length === 3 ? xs : null;
}

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

  // 数据集里的「各类别段数」只有名字和数量（meta.labels 就是 {名字: 段数}），
  // 拿不到颜色，于是一排全是灰底 tag，扫一眼分不出哪个是抓挠哪个是睡觉。
  // 这里按名字去平台的标签定义里查颜色。
  //
  // 为什么在前端查、而不是导出时把颜色写进 meta：meta 是导出那一刻定死的，
  // 已经导好的数据集补不上；而且颜色是会改的，改完老数据集还留着旧颜色，
  // 跟别处对不上。现查就永远跟当前一致。
  //
  // 不传 project_id = 拿全部项目的标签。同一个名字在不同项目里颜色可能不同，
  // 取用得最多的那个——跟导入脚本借颜色的规则一致。
  // 类别统计：可以看单份、选中的几份、或者全部。
  // 为什么要能跨数据集看：单份数据集的均衡度没什么意义——真正要回答的是
  // 「我手上所有训练数据加起来，抓挠占多少」，而数据是一批批攒的，
  // 答案只能跨数据集看。不够就补采，太多就砍。
  const [statsFor, setStatsFor] = useState<string[] | null>(null); // null=关着, []=全部
  const [pickedDs, setPickedDs] = useState<string[]>([]);
  const { data: stats, isFetching: loadingStats } = useQuery({
    queryKey: ["ds-stats", statsFor],
    queryFn: () => datasetStats(statsFor ?? []),
    enabled: statsFor !== null,
  });

  const { data: allLabels } = useQuery({ queryKey: ["labels", "all"], queryFn: () => listLabels() });
  const labelColor = useMemo(() => {
    const votes = new Map<string, Map<string, number>>();
    for (const l of allLabels ?? []) {
      if (!l.color) continue;
      const m = votes.get(l.display_name) ?? new Map<string, number>();
      m.set(l.color, (m.get(l.color) ?? 0) + 1);
      votes.set(l.display_name, m);
    }
    const out = new Map<string, string>();
    votes.forEach((m, name) => {
      out.set(name, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    });
    return (name: string) => out.get(name);
  }, [allLabels]);

  const [exportOpen, setExportOpen] = useState(false);
  const [name, setName] = useState("");
  // 日期范围可以清空。项目名跟日期不是一回事——导进来的项目名是日期区间
  // （2026_7_17-2026_7_29_old），还有按狗命名的（..._imu4_xiaoman_unwear_old），
  // 只按日期圈根本圈不准，得能直接挑项目。
  // 日期范围记住上次选的：数据是一批批攒的，导的往往就是同一个区间
  // （这几天新采的那批），每开一次弹窗重挑一遍日历纯属浪费。
  // 没存过才退回"最近 30 天"
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(() => {
    const saved = getSavedRange(EXPORT_RANGE_KEY);
    return saved ? [dayjs(saved[0]), dayjs(saved[1])] : [dayjs().subtract(30, "day"), dayjs()];
  });
  const pickRange = (v: [dayjs.Dayjs, dayjs.Dayjs] | null) => {
    setRange(v);
    saveRange(EXPORT_RANGE_KEY, v ? [v[0].format("YYYY-MM-DD"), v[1].format("YYYY-MM-DD")] : null);
  };
  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [includeSubmitted, setIncludeSubmitted] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [trainFor, setTrainFor] = useState<TrainDataset | null>(null);
  // 一起训练的其它数据集。**单独一份常常训不了**：按片段取只收人确认过的片段，
  // 而没人会去确认「活动」「睡觉」，整份只有正样本，分类器没有可对比的负类
  const [extraDs, setExtraDs] = useState<string[]>([]);
  // 每份额外数据集自己的真实采样率。**不能跟主批次一刀切**：老批次是 16Hz
  // 导出的，新的 NAS 原始数据是 50Hz，报错了合并时就按错的采样率重采样
  const [extraHz, setExtraHz] = useState<Record<string, number>>({});
  // 类别归并 {原名: 新名}。细类太少就并进兄弟类别，不训的行为折进「活动」当负样本
  const [remapEdits, setRemapEdits] = useState<Record<string, string>>({});
  const [modelType, setModelType] = useState("rf");
  const [sourceHz, setSourceHz] = useState<number>(50);
  // 用几轴。6=加速度+陀螺仪（默认），3=只用加速度——**端侧只有加速度计时用 3**
  // 默认 3 轴：板子按只开加速度计设计，陀螺仪费电，只按策略短时开（每天合计 ≤2 小时，不然到不了 45 天续航）
  const [axes, setAxes] = useState<number>(3);
  // 方向无关：输入只用跟佩戴方向无关的量 + 训练集随机旋转增强。用户怎么戴都不限制，默认开
  const [orientFree, setOrientFree] = useState(true);
  // 短促动作补齐：null = 自动（有比窗口短的片段的那些训练类别——不按名字猜，抓挠也常常很短）
  const [shortLabels, setShortLabels] = useState<string[] | null>(null);
  // 端侧尺寸：限深限棵数，模型才塞得进板子（给模型留的 flash 约 128KB）
  const [edgeSize, setEdgeSize] = useState(false);
  // 端侧尺寸里具体的规格。空 = 默认（rf 20 棵 × 深 10；cnn filters 32/64/128）。
  // 体积曲线那页点一格会把它填进来
  const [edgeTrees, setEdgeTrees] = useState<number | null>(null);
  const [edgeDepth, setEdgeDepth] = useState<number | null>(null);
  const [edgeFilters, setEdgeFilters] = useState<string>("");
  const [curveFor, setCurveFor] = useState<ModelVersion | null>(null);
  const [hz, setHz] = useState<number>(16);
  const [skipSyn, setSkipSyn] = useState(false);
  // 类别均衡：none / min / cap:N。默认不动——砍数据会丢多样性，先看训练集统计和回放再决定
  const [balance, setBalance] = useState<string>("none");
  // 窗口 / 步长（秒，null = 按采样率自动）、窗口怎么打标签、模型超参
  const [windowS, setWindowS] = useState<number | null>(null);
  const [strideS, setStrideS] = useState<number | null>(null);
  const [labelMode, setLabelMode] = useState<"majority" | "center">("majority");
  const [modelParams, setModelParams] = useState<ModelParams>({});
  const [reviewFor, setReviewFor] = useState<ModelVersion | null>(null);
  const [tag, setTag] = useState("");
  // 默认就是最高质量那一档：片段审核里一条条点了「通过」的。训练集的质量决定模型的上限，
  // 宁可少，不要没人把过关的
  const [scope, setScope] = useState<"approved" | "reviewed" | "seg_approved">("seg_approved");
  // 互斥轨的折叠：默认按 行为 > 运动 > 姿态 折成一个时刻一个标签（RF 单标签）；
  // 不折叠 = 各轨原样导，给分轨训练用。没分轨的项目两种一样
  const [flatten, setFlatten] = useState(true);
  const [trackPriority, setTrackPriority] = useState<string[]>(["behavior", "motion", "posture"]);
  // 减量：预览表里每个大类一个滑块，拖到想留多少（秒）。导出时按段抽到这个量。
  // 「自动」按钮按倍数先摆一遍，人再微调
  const [reduceTargets, setReduceTargets] = useState<Record<string, number>>({});
  const [reduceFactor, setReduceFactor] = useState(3);
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

  // 重叠表里只有绝对时间字符串，没有 start_ms，没法直接把工作台开到那一刻。
  // 片段明细里有（老数据集的由接口现算补上），按 任务+起始时间 对一下就能拿到。
  const msOfSeg = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of dsSegs?.rows ?? []) {
      if (r.start_ms != null) m.set(`${r.task_id}|${r.start}`, r.start_ms);
    }
    return (taskId: number, start: string) => m.get(`${taskId}|${start}`);
  }, [dsSegs]);

  const [segLabel, setSegLabel] = useState<string | null>(null);
  // 核对数据集时发现要改起止，直接把工作台开在这一页——不然得记下任务号，
  // 切到项目/任务页翻出来，再拖进度条找那一刻
  const [wsTask, setWsTask] = useState<Task | null>(null);
  const [wsLabels, setWsLabels] = useState<LabelDefinition[]>([]);
  const [wsSeekMs, setWsSeekMs] = useState<number | null>(null);
  const [wsOpening, setWsOpening] = useState<number | null>(null);
  const userId = useAuthStore((st) => st.userInfo?.id);
  // item：从数据池点「看」——打开就循环那一段（波形浮窗弹出来，能直接改类别 / 起止），片段列表只看那一类
  const [wsSeg, setWsSeg] = useState<{ id: number; labelId: number } | null>(null);
  const openTask = async (taskId: number, seekMs?: number | null, item?: { id: number; labelId: number }) => {
    setWsOpening(taskId);
    try {
      const t = await getTask(taskId);
      setWsLabels(await listLabels(t.project_id));
      setWsSeg(item ?? null);
      if (item) {
        try {
          sessionStorage.removeItem(`seg-panel:${taskId}`);
        } catch {
          /* 无所谓 */
        }
      }
      setWsSeekMs(item ? null : seekMs ?? null);
      setWsTask(t);
    } finally {
      setWsOpening(null);
    }
  };
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
  // 看哪一版的实时日志。提交训练成功后直接打开——人提交完最想知道的就是
  // "它开始跑了没、跑到哪了"，不该让他再去列表里找
  const [logFor, setLogFor] = useState<number | null>(null);

  // 调试时同一套参数要导好几遍，每次重敲一遍条件很烦。上次用的条件存下来，
  // 下次打开直接是它（项目/取法/含待审核/折叠），不用重挑一遍。
  //
  // **名字是例外，每次都给新的时间戳。** 沿用上次那个名字听着方便，代价是
  // 再导一次会**原地覆盖**那个目录——而「训练记录」里可能正引用着它，覆盖之后
  // 那条记录指向的就不是当初训练用的数据了，且看不出来。想覆盖是合理需求，
  // 但得是明说的，所以放到下面「沿用上次」那个按钮上，按钮上写清会覆盖。
  const EXPORT_FORM_KEY = "train-export-form";
  const [lastName, setLastName] = useState<string | null>(null);
  useEffect(() => {
    if (!exportOpen) return;
    if (name) return;
    try {
      const raw = localStorage.getItem(EXPORT_FORM_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v.name === "string" && v.name) setLastName(v.name);
        if (Array.isArray(v.projectIds)) setProjectIds(v.projectIds);
        if (v.scope === "approved" || v.scope === "reviewed" || v.scope === "seg_approved") setScope(v.scope);
        if (typeof v.includeSubmitted === "boolean") setIncludeSubmitted(v.includeSubmitted);
        if (typeof v.flatten === "boolean") setFlatten(v.flatten);
        if (Array.isArray(v.trackPriority) && v.trackPriority.length) setTrackPriority(v.trackPriority);
        if (typeof v.reduceFactor === "number" && v.reduceFactor > 0) setReduceFactor(v.reduceFactor);
      }
    } catch {
      // 存的东西坏了不该让弹窗打不开，退回默认名字就是了
    }
    setName(`ds_${dayjs().format("YYYYMMDD_HHmm")}`);
  }, [exportOpen, name]);

  // 这个名字已经有了：再导一次会原地覆盖那个目录。调试时这往往正是想要的，
  // 但「训练记录」里引用过它的话，那条记录指向的就不是当初训练用的数据了。
  // 所以不拦着，只说清楚。
  const nameExists = (datasets ?? []).some((d) => d.name === name.trim());

  // 导出前先预览：同一套挑法跑一遍、只算统计不落盘。弹窗里的选项一改，旧的预览就作废
  const [preview, setPreview] = useState<TrainDataset | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const exportBody = () => ({
    name: name.trim() || "preview",
    date_from: range ? range[0].format("YYYY-MM-DD") : null,
    date_to: range ? range[1].format("YYYY-MM-DD") : null,
    project_ids: projectIds,
    include_submitted: includeSubmitted,
    scope,
    flatten,
    track_priority: trackPriority,
    reduce_targets: activeTargets,
  });
  // 选项一改旧预览就作废，滑块也清掉：数据范围变了，原来拖的秒数对不上
  useEffect(() => {
    setPreview(null);
    setReduceTargets({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.[0]?.valueOf(), range?.[1]?.valueOf(), JSON.stringify(projectIds), includeSubmitted, scope, flatten, JSON.stringify(trackPriority), exportOpen]);
  // 真要减的那几类：滑块拖到比原来少的才送。原来有多少看减量前的树
  const origOf = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of preview?.label_tree_before ?? preview?.label_tree ?? []) m[n.label] = n.sec;
    return m;
  }, [preview]);
  const activeTargets = useMemo(
    () => Object.fromEntries(Object.entries(reduceTargets).filter(([k, v]) => origOf[k] != null && v < origOf[k] - 0.5)),
    [reduceTargets, origOf]
  );
  const doPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await exportDataset({ ...exportBody(), dry_run: true }));
    } finally {
      setPreviewing(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const meta = await exportDataset({
        name: name.trim(),
        date_from: range ? range[0].format("YYYY-MM-DD") : null,
        date_to: range ? range[1].format("YYYY-MM-DD") : null,
        project_ids: projectIds,
        include_submitted: includeSubmitted,
        scope,
        flatten,
        track_priority: trackPriority,
        reduce_targets: activeTargets,
      });
      message.success(
        `已导出：${meta.n_tasks} 个任务 / ${meta.n_segments} 段 / ${meta.total_hours} 小时` +
          (meta.n_untouched_skipped ? `（跳过 ${meta.n_untouched_skipped} 条没人看过的 AI 片段）` : "")
      );
      try {
        localStorage.setItem(
          EXPORT_FORM_KEY,
          JSON.stringify({ name: name.trim(), projectIds, scope, includeSubmitted, flatten, trackPriority, reduceFactor })
        );
        // 「沿用上次」要指向刚导的这份，不然它还指着更早的那一份
        setLastName(name.trim());
        // 日期范围也在这儿存一份。**只在手动动选择器时存是不够的**：用着默认的
        // 「最近 30 天」直接导出的话什么都没存下，而那个默认值每天往后挪一天，
        // 下次打开看到的是另一个区间——看起来就像没记住
        saveRange(EXPORT_RANGE_KEY,
                  range ? [range[0].format("YYYY-MM-DD"), range[1].format("YYYY-MM-DD")] : null);
      } catch {
        // 存不下（隐私模式/满了）不影响导出本身
      }
      setExportOpen(false);
      qc.invalidateQueries({ queryKey: ["train-datasets"] });
    } finally {
      setExporting(false);
    }
  };

  const extraRows = useMemo(
    () => (datasets ?? []).filter((d) => extraDs.includes(d.name)),
    [datasets, extraDs]
  );

  // 训练时那张类别重映射表：用来写清"这一类最后会变成哪一类、会不会被丢掉"。
  // 拿不到（算法服务没起）也不挡提交，只是少一列说明
  const { data: remap } = useQuery({ queryKey: ["train-remap"], queryFn: trainRemap });

  // 这次要训的全部数据集（主 + 一起训的）按类别摊开。**要的是细类那一层**：
  // 人想归并的正是「抓挠-肩胸只有 1 段」这种，看大类看不出来
  const trainNames = useMemo(
    () => (trainFor ? [trainFor.name, ...extraDs] : []),
    [trainFor, extraDs]
  );
  const { data: trainStats } = useQuery({
    queryKey: ["ds-stats", "train", trainNames],
    queryFn: () => datasetStats(trainNames),
    enabled: trainNames.length > 0,
  });

  /** 这次数据里出现的类别，按时长从多到少。没有细类的大类就是它自己 */
  const trainCats = useMemo(() => {
    const out: TrainCat[] = [];
    for (const r of trainStats?.rows ?? []) {
      const kids = r.sub_labels ?? [];
      if (!kids.length) {
        out.push({ name: r.label, n: r.n_segments, sec: r.seconds, root: r.label, chain: [r.label], nShort: r.n_short });
        continue;
      }
      for (const k of kids) {
        // 「X（未细分）」是只标到大类那部分，映射时按大类名算
        const name = k.is_root_only ? r.label : k.label;
        out.push({ name, n: k.n_segments, sec: k.seconds, root: r.label, chain: k.chain ?? [r.label, name], nShort: k.n_short });
      }
    }
    return out.sort((a, b) => b.sec - a.sec);
  }, [trainStats]);

  // 归并表按大类分组：先看大类，点开再看细类。大类那一行的下拉一次设整组
  const trainTree = useMemo(() => {
    const groups = new Map<string, TrainCat[]>();
    for (const c of trainCats) groups.set(c.root, [...(groups.get(c.root) ?? []), c]);
    const rows: TrainRow[] = [];
    for (const [root, cats] of groups) {
      if (cats.length === 1 && cats[0].name === root) {
        rows.push({ ...cats[0], key: root });
        continue;
      }
      // 组内按链排：同一个上级的挨在一起（舔-前爪、舔-前左爪、舔-前右爪）
      const kids = [...cats].sort((a, b) => a.chain.join("/").localeCompare(b.chain.join("/")));
      rows.push({
        key: `group:${root}`, name: root, root, chain: [root], isGroup: true,
        n: cats.reduce((x, c) => x + c.n, 0), sec: cats.reduce((x, c) => x + c.sec, 0),
        children: kids.map((c) => ({ ...c, key: c.name })),
      });
    }
    return rows.sort((a, b) => b.sec - a.sec);
  }, [trainCats]);

  /** 太少的细类并进上一级：只动「自成一类」的那些（已经并到别处的是人定过的，不动）。
   *  往上找第一个"加起来够"的上级——舔-前左爪 太少就看 舔-前爪，还不够再看 舔。
   *  上级本身也是一行的话，跟着它走（它已经并进了别处就一起去） */
  const mergeSmall = () => {
    const tooSmall = (n: number, sec: number) => n < MIN_SEGMENTS || sec < 60;
    // 每个节点（含中间层）底下一共多少：一条链上的每一级都算一份
    const agg = new Map<string, { n: number; sec: number }>();
    for (const c of trainCats) {
      for (const node of c.chain) {
        const a = agg.get(node) ?? { n: 0, sec: 0 };
        agg.set(node, { n: a.n + c.n, sec: a.sec + c.sec });
      }
    }
    const next = { ...remapEdits };
    let changed = 0;
    for (const c of trainCats) {
      if (next[c.name] !== c.name || !tooSmall(c.n, c.sec) || c.chain.length < 2) continue;
      const ups = c.chain.slice(0, -1).reverse();
      const up = ups.find((u) => {
        const a = agg.get(u);
        return a && !tooSmall(a.n, a.sec);
      }) ?? ups[ups.length - 1];
      const target = (next[up] ?? "") || up;
      next[c.name] = target;
      changed += 1;
    }
    setRemapEdits(next);
    message[changed ? "success" : "info"](changed ? `${changed} 个细类并进了上一级` : "没有太少的细类要并");
  };

  /** 这一类最后算作哪个训练类别。**就是这张表说了算**——算法侧会按它生成
   *  这一次训练专用的重映射表，所以界面上看到什么，训出来就是什么。
   *  空 = 不参与训练（那些样本会被丢掉）。 */
  const finalOf = (name: string): string | null => remapEdits[name] || null;

  /** 这次训练最终会有哪几个类别。少于两个就没法训——分类器要有东西可比 */
  const trainTargets = useMemo(
    () => [...new Set(trainCats.map((c) => remapEdits[c.name]).filter(Boolean))] as string[],
    [trainCats, remapEdits]
  );
  // 短促动作补齐可选的类别：训练类别 + 归并前的原名（甩头/抖身 并进「活动」当负样本时也要补）。
  // 只列这次真的会进训练的（有归并目标的）
  const shortOptions = useMemo(
    () => [...new Set([...trainTargets, ...trainCats.filter((c) => remapEdits[c.name]).map((c) => c.name)])],
    [trainTargets, trainCats, remapEdits]
  );
  // 每个选项有几段比窗口短 / 一共几段：训练类别按归并进来的各行加起来
  const shortCount = (t: string) => {
    const rows = trainTargets.includes(t) ? trainCats.filter((c) => remapEdits[c.name] === t) : trainCats.filter((c) => c.name === t);
    return { short: rows.reduce((a, c) => a + (c.nShort ?? 0), 0), n: rows.reduce((a, c) => a + c.n, 0) };
  };
  const shortEffective = (shortLabels ?? trainTargets.filter((t) => shortCount(t).short > 0)).filter((t) => shortOptions.includes(t));

  // 类别查出来之后预填，按这个顺序：
  //   1. 上次训练时这个类别算作了什么（跨数据集记的习惯：舔-大腿内侧 → 舔）
  //   2. 默认那张 3 类表（行走/奔跑 → 活动）
  //   3. 细类跟着它的大类走：大类在表里就跟大类；不在表里就**并进大类自己**
  //      （舔-大腿内侧 → 舔）。以前这一步是留空 = 丢掉，于是几十行舔的细类要一行行手选
  // 人只需要改自己在意的那两三行
  useEffect(() => {
    if (!trainFor || !trainCats.length) return;
    const habits = loadRemapHabits();
    const table = remap?.table ?? {};
    const hasKids = new Set(trainCats.filter((c) => c.chain.length > 1).map((c) => c.root));
    setRemapEdits((prev) => {
      const next = { ...prev };
      let touched = false;
      for (const c of trainCats) {
        if (c.name in next) continue;             // 这份数据集上次提交时定过的不动
        let d: string;
        if (c.name in habits) d = habits[c.name];
        else d = table[c.name] ?? table[c.root] ?? (hasKids.has(c.root) ? (habits[c.root] || c.root) : "");
        if (d || c.name in habits) { next[c.name] = d; touched = true; }
      }
      return touched ? next : prev;
    });
  }, [trainFor, trainCats, remap]);

  /** 打开「提交训练」。上一次选的一起训练/归并不能留着——换了数据集那些
   *  类别名根本对不上，留着等于把上一份的设置悄悄套到这一份头上 */
  /**
   * 打开「提交训练」：**同一份数据集按上次提交时的那一套恢复**。
   *
   * 调试就是同一份数据反复训——改一个选项、看一眼结果、再改。每次都从头勾一遍
   * 轴数、合成数据、一起训练、十几行归并，光这个就比训练本身烦。
   *
   * 换了一份没训过的数据集：通用的那几个（模型、采样率、轴数、合成数据）沿用
   * 上一次的——人一般是一路按同一套设置在试；跟数据集绑定的（一起训练哪几份、
   * 归并表）清空，那些类别名换了数据集根本对不上，带过来等于悄悄套了一份错的。
   * 标签不记：它是给这一次起的名字。
   */
  const openTrain = (d: TrainDataset) => {
    const saved = loadTrainOpts();
    const mine = saved.byDataset[d.name];
    const base = mine ?? saved.last;
    if (base) {
      if (base.modelType) setModelType(base.modelType);
      if (base.sourceHz) setSourceHz(base.sourceHz);
      if (base.hz) setHz(base.hz);
      if (base.axes) setAxes(base.axes);
      if (typeof base.orientFree === "boolean") setOrientFree(base.orientFree);
      setShortLabels(base.shortLabels ?? null);
      if (typeof base.skipSyn === "boolean") setSkipSyn(base.skipSyn);
      setBalance(base.balance || "none");
      setWindowS(base.windowS ?? null);
      setStrideS(base.strideS ?? null);
      setLabelMode(base.labelMode ?? "majority");
      setModelParams(base.modelParams ?? {});
      if (typeof base.edgeSize === "boolean") setEdgeSize(base.edgeSize);
      setEdgeTrees(base.edgeTrees ?? null);
      setEdgeDepth(base.edgeDepth ?? null);
      setEdgeFilters(base.edgeFilters ?? "");
    }
    // 一起训练的那几份：删掉了的数据集别再选着——选择框里会出现一个认不出的名字
    const alive = new Set((datasets ?? []).map((x) => x.name));
    setExtraDs(mine ? (mine.extraDs ?? []).filter((n) => alive.has(n) && n !== d.name) : []);
    setExtraHz(mine?.extraHz ?? {});
    // 归并表：恢复上次的；这次多出来的类别，下面那个 effect 按默认表补上
    // 空的不恢复：以前没设过的行也存成了 ""，恢复回来会挡住上面的预填（上级 / 习惯）。
    // 真选过「不参与」的，习惯表里记着，预填时还是空
    setRemapEdits(Object.fromEntries(Object.entries(mine?.remapEdits ?? {}).filter(([, v]) => v)));
    setTrainFor(d);
  };

  const doTrain = async () => {
    if (!trainFor) return;
    setSubmitting(true);
    try {
      const row = await submitTrain({
        dataset: {
          date: trainFor.name,
          export_json: trainFor.export_json,
          extra_datasets: extraRows.map((d) => ({
            date: d.name,
            export_json: d.export_json,
            // 各批次自己的采样率：老批次 16Hz、新的 50Hz，不分开报就会按错的
            // 采样率重采样
            source_hz: extraHz[d.name] ?? sourceHz,
          })),
          // **整张表都送**，不只改过的那几行：算法侧按这张表生成这次训练专用的
          // 重映射配置，训练类别就是表里那些目标名。只送改动过的话，没动过的
          // 类别在那边就成了"表里没有"，反而会被丢掉
          label_remap: Object.fromEntries(
            trainCats.map((c) => [c.name, remapEdits[c.name] || ""]).filter(([, to]) => to)
          ),
          source_hz: sourceHz,
          hz,
          axes,
          channel_mode: orientFree ? "inv" : "tilt",
          rot_aug: orientFree ? 2 : 0,
          short_labels: shortEffective,
          edge_size: edgeSize,
          edge_trees: edgeSize && modelType !== "cnn" ? edgeTrees : null,
          edge_depth: edgeSize && modelType !== "cnn" ? edgeDepth : null,
          edge_filters: edgeSize && modelType === "cnn" ? parseFilters(edgeFilters) : null,
          skip_syn: skipSyn,
          balance: balance === "none" ? null : balance,
          window_s: windowS,
          stride_s: strideS,
          label_mode: labelMode === "center" ? "center" : null,
          model_params: modelType !== "cnn" && Object.values(modelParams).some((v) => v != null && v !== "") ? modelParams : null,
          clean: true,
        },
        model_type: modelType,
        tag: tag.trim() || null,
      });
      // 记下这次每个类别算作了什么，下一份数据集里同名的类别直接照这个预填
      saveRemapHabits(Object.fromEntries(trainCats.filter((c) => c.name in remapEdits).map((c) => [c.name, remapEdits[c.name]])));
      saveTrainOpts(trainFor.name, {
        modelType, sourceHz, hz, axes, orientFree, shortLabels: shortLabels ?? undefined, edgeSize, skipSyn, extraDs, extraHz, edgeTrees, edgeDepth, edgeFilters, balance,
        windowS, strideS, labelMode, modelParams,
        // 只存这次数据里真有的类别，别把历史上别的数据集的类别名越攒越多
        remapEdits: Object.fromEntries(trainCats.map((c) => [c.name, remapEdits[c.name] ?? ""])),
      });
      message.success("已提交训练，下面是实时日志（可以关掉，之后在「训练记录」里点「日志」再看）");
      setTrainFor(null);
      setLogFor(row.id);
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
  /** 这一版的数据集参数（提交时存的那份 JSON） */
  const specOf = (v: ModelVersion): Record<string, unknown> => {
    try {
      return JSON.parse(v.dataset_spec) ?? {};
    } catch {
      return {};
    }
  };
  /** 「再训一版」：照这条记录的数据集和配置（模型、轴数、采样率、一起训的数据集、归并表、
   *  端侧尺寸……）打开训练弹窗，「方向无关」默认勾上。确认后提交，原来那版不动 */
  const retrainFrom = (v: ModelVersion) => {
    const sp = specOf(v);
    const ds = (datasets ?? []).find((d) => d.name === sp.date);
    if (!ds) {
      message.warning(`数据集「${String(sp.date ?? "-")}」已经不在了，没法照它再训`);
      return;
    }
    openTrain(ds);
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    setModelType(v.model_type || "rf");
    if (num(sp.source_hz)) setSourceHz(num(sp.source_hz)!);
    if (num(sp.hz)) setHz(num(sp.hz)!);
    setAxes(num(sp.axes) ?? 6);
    setOrientFree(true);
    setEdgeSize(!!sp.edge_size);
    setEdgeTrees(num(sp.edge_trees));
    setEdgeDepth(num(sp.edge_depth));
    setEdgeFilters(Array.isArray(sp.edge_filters) ? (sp.edge_filters as number[]).join(",") : "");
    setSkipSyn(!!sp.skip_syn);
    setBalance(typeof sp.balance === "string" && sp.balance ? sp.balance : "none");
    setWindowS(num(sp.window_s));
    setStrideS(num(sp.stride_s));
    setLabelMode(sp.label_mode === "center" ? "center" : "majority");
    setModelParams((sp.model_params as ModelParams | undefined) ?? {});
    const alive = new Set((datasets ?? []).map((x) => x.name));
    const extras = ((sp.extra_datasets as { date: string; source_hz?: number | null }[] | undefined) ?? [])
      .filter((e) => alive.has(e.date) && e.date !== ds.name);
    setExtraDs(extras.map((e) => e.date));
    setExtraHz(Object.fromEntries(extras.filter((e) => e.source_hz).map((e) => [e.date, e.source_hz as number])));
    const remap = (sp.label_remap as Record<string, string> | undefined) ?? {};
    if (Object.keys(remap).length) setRemapEdits(remap);
    message.info(`已照训练记录 #${v.id} 的配置填好，「方向无关」已勾上，确认后提交`, 5);
  };
  /** 每类的 P/R/F1。训练脚本产出的 json 里叫 per_class，键是类别名 */
  const perClassOf = (v: ModelVersion) => {
    const pc = metricsOf(v)?.per_class as Record<string, Record<string, number>> | undefined;
    if (!pc) return [] as { cls: string; p: number; r: number; f1: number }[];
    return Object.entries(pc).map(([cls, m]) => ({
      cls, p: m.precision ?? 0, r: m.recall ?? 0, f1: m["f1-score"] ?? 0,
    }));
  };
  const f1Color = (f1: number) => (f1 >= 0.8 ? "green" : f1 >= 0.6 ? "gold" : "red");

  const f1Of = (v: ModelVersion) => {
    const m = metricsOf(v);
    if (!m) return null;
    const f1 = (m.f1_macro ?? m.macro_f1 ?? m.f1) as number | undefined;
    return typeof f1 === "number" ? f1 : null;
  };
  /** 导出到端侧之后才有：板上那份 C 在留出集上的成绩 */
  const edgeOf = (v: ModelVersion) => {
    const e = metricsOf(v)?.edge as EdgeMetrics | undefined;
    return e && typeof e.macro_f1 === "number" ? e : null;
  };
  const [exportingEdge, setExportingEdge] = useState<number | null>(null);
  const [downloadingEdge, setDownloadingEdge] = useState<number | null>(null);
  const edgeZipName = (v: ModelVersion, kind: EdgeBundleKind = "src") =>
    `edge_${v.model_type || "rf"}_train${v.algo_job_id}_v${v.id}${kind === "lib" ? "_lib" : ""}.zip`;
  /** 一键下载端侧包：还没导过端侧就先导（算端侧 F1、挂端侧服务），再打包下载 */
  const oneClickEdgeBundle = async (v: ModelVersion, kind: EdgeBundleKind) => {
    setDownloadingEdge(v.id);
    try {
      if (!edgeOf(v)) {
        message.info("这一版还没导出到端侧，先导出（几十秒到一两分钟），导完自动下载", 6);
        await exportModelEdge(v.id);
        qc.invalidateQueries({ queryKey: ["model-versions"] });
        qc.invalidateQueries({ queryKey: ["edge-models"] });
      }
      await downloadEdgeBundle(v.id, edgeZipName(v, kind), kind);
    } finally {
      setDownloadingEdge(null);
    }
  };

  return (
    <div>
      {/* 说明收进问号，放在页签栏最右边，不占一整块地方 */}
      <Tabs
        tabBarExtraContent={
          <Tooltip overlayStyle={{ maxWidth: 460 }} title={<div><b>AI 辅助标注闭环</b><div style={{ marginTop: 4 }}>AI 预标注（稳定版）→ 人工在工作台确认/纠正片段、逐条处理「疑似片段」→ 这里把审核通过的标注导成数据集 → 提交训练 → 训练完「启用」，下一轮预标注就用新模型。</div></div>}>
          <QuestionCircleOutlined style={{ color: "#888", cursor: "help", fontSize: 15 }} />
        </Tooltip>
        }
        items={[
          {
            key: "cmp",
            label: "模型对比",
            children: <ModelCompare />,
          },
          {
            key: "pool",
            label: "数据池",
            children: <DataPoolPanel onTrain={(ds) => openTrain(ds)} onOpen={(id, ms, item) => openTask(id, ms, item)} />,
          },
          {
            key: "compare",
            label: "类别对比",
            children: <ClassCompare />,
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
                  <Button onClick={() => setStatsFor(pickedDs)} disabled={!datasets?.length}>
                    类别统计{pickedDs.length ? `（选中 ${pickedDs.length} 份）` : "（全部）"}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    导出到 NAS 的 data_train/&lt;名字&gt;/。可以只用审核通过的任务，也可以按片段取——
                    人确认过的那些（审了一半的任务也能用）。勾选几份可以合起来看类别够不够。
                  </Typography.Text>
                </Space>
                <Table
                  rowKey="name"
                  size="small"
                  loading={loadingDs}
                  dataSource={datasets ?? []}
                  pagination={false}
                  rowSelection={{
                    selectedRowKeys: pickedDs,
                    onChange: (keys) => setPickedDs(keys as string[]),
                  }}
                  // x 给一个下限而不是 max-content。max-content 会让表格按内容无限
                  // 撑宽，类别标签一多就把「导出时间/操作」挤到屏幕外，只能横向滚——
                  // 而那两列是每行都要用的。给定宽度之后，剩下的空间归「各类别段数」，
                  // 它自己换行。
                  //
                  // 1430 = 其它列固定宽度合计 1050 + 留给标签列的 380。
                  // 这个下限不能只比 1050 多一点：那样窄屏下标签列只剩几十像素，
                  // 十几个标签会挤成一条竖着的细柱，比横向滚动还难看。
                  scroll={{ x: 1430 }}
                  columns={[
                    { title: "数据集", dataIndex: "name", width: 190, render: (n: string) => <strong>{n}</strong> },
                    {
                      title: "范围",
                      width: 230,
                      render: (_, d: TrainDataset) => (
                        <span>
                          {d.date_from} ~ {d.date_to}
                          {d.include_submitted && <Tag color="orange" style={{ marginLeft: 4 }}>含待审核</Tag>}
                          {d.scope === "reviewed" && (
                            <Tooltip title="按片段取的：只包含人确认过/改过/人工加的片段，没人看过的 AI 片段没有导出">
                              <Tag color="blue" style={{ marginLeft: 4 }}>按片段</Tag>
                            </Tooltip>
                          )}
                          {d.scope === "pool" && (
                            <Tooltip title="从数据池挑出来的：审核通过 + 手动认可的片段">
                              <Tag color="gold" style={{ marginLeft: 4 }}>★ 数据池</Tag>
                            </Tooltip>
                          )}
                          {d.scope === "seg_approved" && (
                            <Tooltip title="只包含片段审核里逐条通过的片段">
                              <Tag color="gold" style={{ marginLeft: 4 }}>★ 高质量·审核通过</Tag>
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
                      // 不给 width：让它吃掉其它列分完之后剩下的宽度。
                      // Space 的 wrap 只有在容器有边界时才生效，上面那些列定了宽度，
                      // 这一列才有边界可言。
                      render: (_, d: TrainDataset) => (
                        <Space size={4} wrap>
                          {Object.entries(d.labels).map(([k, v]) => (
                            <Tag key={k} color={labelColor(k)}>{k} {v}</Tag>
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
                          <Button size="small" type="link" onClick={() => openTrain(d)}>
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
                // 不要横向滚动条：列都允许换行，操作按钮折成多行。宁可一行高一点，
                // 也别让人左右拖着找「删除」在哪
                tableLayout="auto"
                columns={[
                  { title: "ID", dataIndex: "id", width: 50 },
                  {
                    title: "状态",
                    width: 80,
                    render: (_, v: ModelVersion) => (
                      <Tag color={STATUS_META[v.status].color}>{STATUS_META[v.status].label}</Tag>
                    ),
                  },
                  {
                    title: "数据集",
                    render: (_, v: ModelVersion) => {
                      const sp = specOf(v);
                      const extra = (sp.extra_datasets as unknown[] | undefined)?.length ?? 0;
                      // 用到的数据集是不是都是「片段审核通过」导出的：都是 = 高质量；混了别的要看得出来
                      const names = [sp.date as string, ...((sp.extra_datasets as { date: string }[] | undefined) ?? []).map((e) => e.date)];
                      const scopes = names.map((n) => (datasets ?? []).find((d) => d.name === n)?.scope);
                      const nHq = scopes.filter((x) => x === "seg_approved" || x === "pool").length;
                      return (
                        <Space size={4} wrap>
                          <span>{(sp.date as string) ?? "-"}</span>
                          {extra > 0 && <Tag>+{extra} 份</Tag>}
                          {nHq === names.length && (
                            <Tooltip title="用到的数据集全部是「片段审核通过」导出的高质量数据">
                              <Tag color="gold">★ 高质量</Tag>
                            </Tooltip>
                          )}
                          {nHq > 0 && nHq < names.length && (
                            <Tooltip title={`${names.length} 份数据集里 ${nHq} 份是审核通过的高质量数据，其余是按任务 / 按片段导出的`}>
                              <Tag color="orange">部分高质量 {nHq}/{names.length}</Tag>
                            </Tooltip>
                          )}
                          {/* 轴数：3 轴和 6 轴的模型不能拿来直接比，一眼得看出来 */}
                          <Tag color={Number(sp.axes) === 3 ? "purple" : undefined}>
                            {Number(sp.axes) === 3 ? "3 轴" : "6 轴"}
                          </Tag>
                          {/* 训练采样率：端侧要跟项圈 IMU 实际采样率一致（QMI8658 原生 31.25），
                              不同采样率的模型不能混用。老记录没存就是默认 16 */}
                          <Tag color={Number(sp.hz) === 31.25 || Number(sp.hz) === 15.625 ? "gold" : undefined}>{String(sp.hz ?? 16)}Hz</Tag>
                          <Tag>{v.model_type}</Tag>
                          {/* 端侧尺寸的跟不限深的大模型不能直接比分数：一个要塞进 128KB，
                              一个没限制。混在一起看，端侧那版永远像是"更差的那个" */}
                          {Boolean(sp.edge_size) && <Tag color="cyan">端侧尺寸</Tag>}
                          {sp.channel_mode === "inv" && (
                            <Tooltip title="方向无关输入 + 旋转增强：佩戴方向不影响识别">
                              <Tag color="green">方向无关</Tag>
                            </Tooltip>
                          )}
                        </Space>
                      );
                    },
                  },
                  {
                    title: <Tooltip title="macro-F1：各类别 F1 的平均，每一类算一票。少数类（抓挠）训不好这个数就上不去——比准确率更能说明问题">F1</Tooltip>,
                    width: 70,
                    sorter: (a, b) => (f1Of(a) ?? -1) - (f1Of(b) ?? -1),
                    render: (_, v: ModelVersion) => {
                      const f1 = f1Of(v);
                      return f1 != null ? <b>{f1.toFixed(3)}</b> : "-";
                    },
                  },
                  {
                    title: <Tooltip title="每一类自己的 F1（绿 ≥0.8，黄 ≥0.6，红 <0.6）。**看这一列比看总的 F1 有用**：静止占了大头的话总分会很好看，而抓挠可能是红的">各类 F1</Tooltip>,
                    render: (_, v: ModelVersion) => {
                      const pc = perClassOf(v);
                      if (!pc.length) return "-";
                      return (
                        <Space size={2} wrap>
                          {pc.map((c) => (
                            <Tooltip key={c.cls} title={`${c.cls}：精确率 ${c.p.toFixed(2)} / 召回 ${c.r.toFixed(2)} / F1 ${c.f1.toFixed(2)}`}>
                              <Tag color={f1Color(c.f1)} style={{ marginInlineEnd: 0 }}>
                                {c.cls} {c.f1.toFixed(2)}
                              </Tag>
                            </Tooltip>
                          ))}
                        </Space>
                      );
                    },
                  },
                  {
                    title: (
                      <Tooltip title="「导出到端侧」之后才有：用板上那份 C 在留出集上跑出来的成绩——rf 是 float32 特征 + 量化过的叶子，cnn 是 int8 量化后的网络。跟左边服务器上的数不是一回事，这个才是项圈上会有的效果">
                        端侧 F1（板上 C · int8）
                      </Tooltip>
                    ),
                    render: (_, v: ModelVersion) => {
                      const e = edgeOf(v);
                      if (!e) return <span style={{ color: "#999" }}>—</span>;
                      const pc = Object.entries(e.per_class ?? {}).map(([cls, m]) => ({ cls, f1: m["f1-score"] ?? 0, p: m.precision ?? 0, r: m.recall ?? 0 }));
                      return (
                        <Space size={2} wrap>
                          <Tooltip title={`端侧${v.model_type === "cnn" ? "（int8）" : ""} macro-F1 ${e.macro_f1.toFixed(3)}，准确率 ${e.accuracy.toFixed(3)}，留出集 ${e.n_windows} 窗${e.flash_bytes ? `，模型 ${(e.flash_bytes / 1024).toFixed(1)} KB` : ""}${typeof e.agree_with_sklearn === "number" ? `，跟 sklearn 判决一致 ${(e.agree_with_sklearn * 100).toFixed(1)}%` : ""}${typeof e.agree_with_float === "number" ? `，跟 float 判决一致 ${(e.agree_with_float * 100).toFixed(1)}%` : ""}${e.quant_percentile != null ? `，量程取 ${e.quant_percentile} 百分位` : ""}`}>
                            <b>{e.macro_f1.toFixed(3)}</b>
                          </Tooltip>
                          {pc.map((c) => (
                            <Tooltip key={c.cls} title={`${c.cls}（端侧）：精确率 ${c.p.toFixed(2)} / 召回 ${c.r.toFixed(2)} / F1 ${c.f1.toFixed(2)}`}>
                              <Tag color={f1Color(c.f1)} style={{ marginInlineEnd: 0 }}>
                                {c.cls} {c.f1.toFixed(2)}
                              </Tag>
                            </Tooltip>
                          ))}
                        </Space>
                      );
                    },
                  },
                  {
                    title: (
                      <Tooltip title="训练集：这次喂了什么（每类多少、来自几天）。回放：训练完用这一版把训练集再预测一遍，对不上的段列出来，点进去看是标错了还是模型弱">
                        数据 · 回放
                      </Tooltip>
                    ),
                    width: 150,
                    render: (_, v: ModelVersion) => {
                      const m = metricsOf(v);
                      const ds = m?.dataset as DatasetStats | undefined;
                      const rv = m?.review as TrainReview | undefined;
                      if (!ds && !rv) return <span style={{ color: "#999" }}>—</span>;
                      const miss = rv?.by_kind?.["漏识别"] ?? 0;
                      const fp = (rv?.by_kind?.["误识别"] ?? 0) + (rv?.by_kind?.["未标注区报事件"] ?? 0);
                      return (
                        <a onClick={() => setReviewFor(v)} style={{ fontSize: 12 }}>
                          {ds && <div>{ds.rows.length} 类 · {ds.total_windows.toLocaleString()} 窗{ds.hints.length ? <Tag color="orange" style={{ marginLeft: 4 }}>{ds.hints.length} 提示</Tag> : null}</div>}
                          {rv ? (
                            <div>
                              {rv.n_segments} 段 · 错 {rv.n_wrong}
                              {miss ? <Tag color="red" style={{ marginLeft: 4, marginInlineEnd: 0 }}>漏 {miss}</Tag> : null}
                              {fp ? <Tag color="volcano" style={{ marginLeft: 4, marginInlineEnd: 0 }}>误 {fp}</Tag> : null}
                            </div>
                          ) : v.status === "done" ? <div style={{ color: "#999" }}>回放未跑</div> : null}
                        </a>
                      );
                    },
                  },
                  {
                    title: "标签 / 时间",
                    width: 120,
                    render: (_, v: ModelVersion) => (
                      <div style={{ fontSize: 12 }}>
                        <div>{v.model_version || "-"}</div>
                        <div style={{ color: "#888" }}>{v.created_at?.replace("T", " ").slice(5, 16)}</div>
                      </div>
                    ),
                  },
                  {
                    title: "操作",
                    width: 230,
                    render: (_, v: ModelVersion) => {
                      const busy = v.status === "queued" || v.status === "running";
                      return (
                        <Space size={0} wrap>
                          <Button size="small" type="link" onClick={() => setLogFor(v.id)}>
                            {busy ? "看进度" : "日志"}
                          </Button>
                          <Button size="small" type="link" onClick={() => setDetail(v)}>
                            详情
                          </Button>
                          {v.status === "done" && v.model_path && (
                            <Tooltip
                              title={
                                v.listed
                                  ? "已启用：新建项目、批量预标注、模型对比的「版本」下拉里能选到它。停用后下拉里就不再出现（已经跑出来的结果不受影响）"
                                  : "启用后才会出现在新建项目、批量预标注、模型对比的「版本」下拉里。只影响下拉列表，不改 AI 服务的默认模型"
                              }
                            >
                              <Button
                                size="small"
                                type="link"
                                onClick={async () => {
                                  await setModelListed(v.id, !v.listed);
                                  message.success(v.listed ? `已停用训练记录 #${v.id}` : `已启用训练记录 #${v.id}，项目的版本下拉里可以选了`);
                                  qc.invalidateQueries({ queryKey: ["model-versions"] });
                                }}
                              >
                                {v.listed ? "停用" : "启用"}
                              </Button>
                            </Tooltip>
                          )}
                          {v.status === "done" && v.model_path && (v.model_type === "rf" || v.model_type === "cnn") && (
                            <Tooltip title="这一版剪到多小、F1 掉多少。rf 是棵数 × 深度的网格（不重训直接剪）；cnn 是各档 filters 的 int8 体积。看中哪一格直接按那个规格重训">
                              <Button size="small" type="link" onClick={() => setCurveFor(v)}>
                                体积曲线
                              </Button>
                            </Tooltip>
                          )}
                          {v.status === "done" && v.model_path && (v.model_type === "rf" || v.model_type === "cnn") && (
                            <Tooltip
                              title={
                                edgeOf(v)
                                  ? "已经导过端侧了。再点一次会重新导（模型没变的话结果一样）"
                                  : "转成板上那份 C，在留出集上算「端侧 F1」，并挂到端侧服务上。之后启用它，「端侧模型 · 板上 C」那组下拉里就能选、能跟稳定版 v2 对比。要几十秒到一两分钟"
                              }
                            >
                              <Button
                                size="small"
                                type="link"
                                loading={exportingEdge === v.id}
                                disabled={exportingEdge != null && exportingEdge !== v.id}
                                onClick={async () => {
                                  setExportingEdge(v.id);
                                  try {
                                    const r = await exportModelEdge(v.id);
                                    const f1 = r.edge?.macro_f1;
                                    message.success(
                                      `端侧模型导好了（${r.tag}）${typeof f1 === "number" ? `，端侧 F1 ${f1.toFixed(3)}` : ""}` +
                                        (r.reloaded ? "，端侧服务已挂上" : `。${r.reload_error ?? ""}`),
                                      8,
                                    );
                                    qc.invalidateQueries({ queryKey: ["model-versions"] });
                                    qc.invalidateQueries({ queryKey: ["edge-models"] });
                                  } finally {
                                    setExportingEdge(null);
                                  }
                                }}
                              >
                                {edgeOf(v) ? "重导端侧" : "导出到端侧"}
                              </Button>
                            </Tooltip>
                          )}
                          {v.status === "done" && v.model_path && (v.model_type === "rf" || v.model_type === "cnn") && (
                            <Dropdown
                              trigger={["click"]}
                              disabled={(downloadingEdge != null && downloadingEdge !== v.id) || exportingEdge === v.id}
                              menu={{
                                items: [
                                  { key: "src", label: "源码包（内部）", title: "板上 C 源码 + 这版模型 + PC 命令行测试程序 + README，Linux 上 make test 就能跑" },
                                  { key: "lib", label: "编译库（保密，给外部）", title: "只有编译好的 .a + 头文件 + PC 验证工具，不含源码" },
                                ],
                                onClick: ({ key }) => oneClickEdgeBundle(v, key as EdgeBundleKind),
                              }}
                            >
                              <Tooltip title="还没导出到端侧的会先自动导出">
                                <Button size="small" type="link" loading={downloadingEdge === v.id}>
                                  下载端侧包 ▾
                                </Button>
                              </Tooltip>
                            </Dropdown>
                          )}
                          {!busy && (
                            <Tooltip title="照这一版的数据集和配置再训一版新的（方向无关默认勾上），原来这版不动">
                              <Button size="small" type="link" onClick={() => retrainFrom(v)}>
                                再训一版
                              </Button>
                            </Tooltip>
                          )}
                          {v.status === "done" && v.model_path && (
                            <Popconfirm
                              title="把它换成 AI 服务的默认模型？"
                              description={
                                <span>
                                  会影响所有人：所有没指定版本的预标注都改用它；正在跑的推理会中断；
                                  AI 服务重启后回到配置里的默认模型。
                                  <br />
                                  <b>只是想在某个项目上试一下的话用「启用」就行</b>——启用后在新建项目、重跑预标注、
                                  模型对比的「版本」下拉里选「训练记录 #{v.id}」
                                </span>
                              }
                              onConfirm={async () => {
                                const r = await activateModel(v.id);
                                message.success(`已设为默认：${r.classes.join("/")}`);
                              }}
                            >
                              <Button size="small" type="link">
                                设为默认
                              </Button>
                            </Popconfirm>
                          )}
                          {/* 在跑的给「停止」，结束了的给「删除」。原来在跑的只有一个
                              灰掉的删除——而服务一重启，那些任务就永远是「训练中」，
                              删也删不掉、停也停不了（2026-09-23 就是这样） */}
                          {busy ? (
                            <Popconfirm
                              title={`停掉第 ${v.id} 版的训练？`}
                              description="整个训练进程一起停掉，停了之后可以删"
                              okButtonProps={{ danger: true }}
                              onConfirm={async () => {
                                await cancelModelVersion(v.id);
                                message.success("已停止");
                                qc.invalidateQueries({ queryKey: ["model-versions"] });
                              }}
                            >
                              <Button size="small" type="link" danger>
                                停止
                              </Button>
                            </Popconfirm>
                          ) : (
                            /* 删掉效果不好的那一版。每一版各存各的，删一版只删它自己；
                               正在用的那个算法服务会拒绝，原因原样显示 */
                            <Popconfirm
                              title={`删掉第 ${v.id} 版？`}
                              description="算法机上这一版的模型、预处理数据、日志都会删掉，这条记录也一起删，删了找不回来"
                              okButtonProps={{ danger: true }}
                              onConfirm={async () => {
                                const r = await deleteModelVersion(v.id);
                                message.success(`已删除，清掉了 ${r.deleted.length} 处文件`);
                                qc.invalidateQueries({ queryKey: ["model-versions"] });
                              }}
                            >
                              <Button size="small" type="link" danger>
                                删除
                              </Button>
                            </Popconfirm>
                          )}
                        </Space>
                      );
                    },
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
        width={preview ? 920 : 520}
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <Tooltip title="按上面的选项把数据挑一遍，只看统计（各类别多少段、多长、占比，跳过了多少），不导出">
              <Button onClick={doPreview} loading={previewing} style={{ float: "left" }}>
                预览统计
              </Button>
            </Tooltip>
            <CancelBtn />
            <OkBtn />
          </>
        )}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            把这段日期里的标注导成训练数据。人工纠正过的 AI 片段、人工新增的、从「疑似片段」里确认或
            改成别的类别的，都算数；标了「待定」的和采集掉数据的时段会挖掉。下面选按什么范围取。
          </Typography.Paragraph>
          {/* 标签 + 输入框占一行，两个次要操作另起一行。
              挤在一行里的话（弹窗只有 520 宽）标签会被压成竖排的「数 据 集 名」，
              右边那个还会溢出到框外去 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Typography.Text style={{ whiteSpace: "nowrap" }}>数据集名</Typography.Text>
            <AutoComplete
              style={{ flex: 1, minWidth: 0 }}
              value={name}
              onChange={setName}
              placeholder="字母/数字/下划线"
              // 已有的名字列出来，调试时重导同一份直接选，不用照着抄
              options={(datasets ?? []).map((d) => ({ value: d.name }))}
              filterOption={(input: string, opt?: { value: string }) =>
                (opt?.value ?? "").toLowerCase().includes(input.toLowerCase())
              }
            />
          </div>
          <Space size={0} wrap>
            <Button size="small" type="link" onClick={() => setName(`ds_${dayjs().format("YYYYMMDD_HHmm")}`)}>
              换个新名字
            </Button>
            {/* 想覆盖上次那份是合理需求（同一套条件重导），但得是明说的——
                默认沿用的话，「训练记录」里引用着它的那条记录会指向新数据，
                而且一点痕迹都没有。点了之后下面那条黄字会说清会覆盖，
                所以按钮上不用再写一遍，省得这一行又撑开 */}
            {lastName && lastName !== name && (
              <Tooltip title={`上次导的是「${lastName}」，用同一个名字会原地覆盖那份数据`}>
                <Button size="small" type="link" onClick={() => setName(lastName)}>
                  沿用上次
                </Button>
              </Tooltip>
            )}
          </Space>
          {nameExists && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              已经有同名数据集了，导出会<strong>原地覆盖</strong>它。调试时重导同一份就是要这样；
              但「训练记录」里引用过它的话，那条记录指向的就不再是当初训练用的数据了。
            </Typography.Text>
          )}
          <Space>
            <Typography.Text>日期范围</Typography.Text>
            <DatePicker.RangePicker
              value={range}
              onChange={(v) => pickRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
              allowClear
            />
          </Space>
          <Space>
            <Typography.Text>项目</Typography.Text>
            <Select
              mode="multiple"
              allowClear
              placeholder="全部项目（可多选）"
              style={{ width: 420 }}
              maxTagCount="responsive"
              // 项目多了得能搜，光靠下拉翻找不现实
              showSearch
              optionFilterProp="label"
              value={projectIds}
              onChange={setProjectIds}
              options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
          </Space>
          {!range && projectIds.length === 0 && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              日期和项目都没限制 = 导出全部标注。确实想要就继续，只是会比较大。
            </Typography.Text>
          )}
          {/* 人工复看很费时间，实际总是"这个任务只审了抓挠""那个审了一半"。
              等整份审完再用，数据集永远攒不起来——所以给一个按片段取的口子 */}
          <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: "100%" }}>
            <Space direction="vertical" size={4}>
              <Radio value="seg_approved">
                <Tooltip title="只要在「片段审核」里一条条审过、点了「通过」的片段——起止准、类别对、没混别的动作。量少但质量最高；待审和退回的都不导出（那段时间不参与训练，不会变成负样本）。通过之后又被人改过起止 / 类别的，会自动回到待审，不会混进来">
                  <span style={{ borderBottom: "1px dashed #bbb" }}>
                    <b>高质量：只要片段审核通过的</b>（推荐，你逐条把过关的）
                  </span>
                </Tooltip>
              </Radio>
              <Radio value="approved">
                <Tooltip title="整份取：这个任务里的片段全要，包括没人看过的纯 AI 片段。任务审核通过意味着「这一份整体认可」，所以不再逐条看确认状态。只审了一部分就提交的任务别用这一档——那几十条没确认的 AI 片段会跟着进训练集，等于拿模型自己的输出喂它自己">
                  <span style={{ borderBottom: "1px dashed #bbb" }}>
                    只用审核通过的任务（整份都算数，<b>含没人确认过的 AI 片段</b>）
                  </span>
                </Tooltip>
              </Radio>
              <Radio value="reviewed">
                <Tooltip title="不看任务状态，只挑出人确认过 / 改过 / 人工加的片段（包括从「疑似片段」确认上来的）。没人看过的纯 AI 片段不导出——它只是模型自己的输出，拿去训练就是自我强化。那段时间也不会被当成负样本：导出格式只提取被标注的区间，没标注的时间根本不进数据集">
                  <span style={{ borderBottom: "1px dashed #bbb" }}>
                    按片段取：人确认过的（审了一半也能用）
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
          {/* 分了互斥轨的项目（姿态 / 运动 / 行为可以同时标）：模型是单标签的，导出时得折成一个时刻一个标签 */}
          <Space wrap size={8}>
            <Tooltip title="分了互斥轨的项目里，卧 + 静止 + 舔前爪是同时标的三条。RF 这类模型一个窗口只要一个标签，所以按优先级折叠：高优先级轨盖住的时间从低优先级轨里挖掉（那几秒归「舔」，「卧」让开）。每段另带 tracks={轨: 同时在标什么}，以后训分轨模型不用重标。设备轨（颈圈松动）不参与折叠，单独放在 aux 里。没分轨的项目勾不勾一样">
              <Checkbox checked={flatten} onChange={(e) => setFlatten(e.target.checked)}>
                <span style={{ borderBottom: "1px dashed #bbb" }}>按互斥轨折叠成一个时刻一个标签</span>
              </Checkbox>
            </Tooltip>
            {flatten && (
              <Tooltip title="前面的赢。默认 行为 > 运动 > 姿态：具体行为最有信息量，姿态只在什么都没标时才出现">
                <Select
                  size="small"
                  mode="multiple"
                  style={{ minWidth: 260 }}
                  value={trackPriority}
                  onChange={(v) => setTrackPriority(v)}
                  placeholder="折叠优先级"
                  options={TRACKS.filter((t) => t.key !== "device").map((t) => ({ value: t.key, label: `${t.name}轨` }))}
                />
              </Tooltip>
            )}
            {!flatten && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                不折叠：各轨原样导，同一时刻会有几条，给分轨训练用；现有单标签训练读到的是重叠的窗口
              </Typography.Text>
            )}
          </Space>
          {preview && (
            <ExportPreview
              meta={preview}
              targets={reduceTargets}
              setTargets={setReduceTargets}
              factor={reduceFactor}
              setFactor={setReduceFactor}
            />
          )}
        </Space>
      </Modal>

      {/* 改完关掉就回到详情弹窗接着核对下一条；导出文件不会自动跟着变，
          得重新导一次——按钮上的说明写了 */}
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        initialSeekMs={wsSeekMs}
        initialSegId={wsSeg?.id ?? null}
        focusLabelIds={wsSeg ? [wsSeg.labelId] : undefined}
        jumpToFocus={!!wsSeg}
        readOnly={!(wsTask?.status === "IN_PROGRESS" && wsTask?.locked_by === userId)}
        onClaim={
          wsTask && wsTask.status !== "APPROVED"
            ? async () => {
                const t = await claimTask(wsTask.id);
                setWsTask(t);
              }
            : undefined
        }
        onClose={() => setWsTask(null)}
        onSubmitted={() => setWsTask(null)}
      />

      <Modal
        title={`数据集详情 - ${dsDetail?.name ?? ""}`}
        open={dsDetail != null}
        onCancel={() => setDsDetail(null)}
        footer={null}
        // 跟着屏幕走，别写死。原来固定 980px，片段明细那张表六列排不下，
        // 每次点「去修」都得先往右拖一段。大屏上明明有空间，白白浪费。
        width="94vw"
        style={{ maxWidth: 1400, top: 24 }}
      >
        {dsDetail && (
          <>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="日期范围">
                {dsDetail.date_from} ~ {dsDetail.date_to}
              </Descriptions.Item>
              <Descriptions.Item label="取法">
                {/* 「人确认过的」而不是「人碰过的」：打开看一眼不算，得真的点了
                    「通过」、改过、或者自己画的。下面「跳过没人看过的 AI 片段」
                    那一栏就是被这条规则挡下来的数量 */}
                {dsDetail.scope === "reviewed" ? (
                  <Tooltip title="三种算数：点过「通过」的、改过的（换了标签或拖过起止）、人自己画的（含从「疑似片段」确认上来的）。只是打开看过、没点的不算——那些就是下面「跳过没人看过的 AI 片段」的数量">
                    <span style={{ borderBottom: "1px dashed #bbb" }}>按片段取（人确认过的）</span>
                  </Tooltip>
                ) : (
                  "只用审核通过的任务"
                )}
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
              {dsDetail.flatten != null && (
                <Descriptions.Item label="互斥轨折叠">
                  <Tooltip title="分了互斥轨的项目：高优先级轨盖住的时间从低优先级轨里挖掉（卧着舔前爪：那几秒归「舔」），折成一个时刻一个标签。各轨各导了几段见括号；设备轨（颈圈松动）单独放在 aux 里，不进类别">
                    <span style={{ cursor: "help" }}>
                      {dsDetail.flatten
                        ? `${(dsDetail.track_priority ?? []).map((t) => TRACK_NAME[t] ?? t).join(" > ")}，让出 ${dsDetail.flattened_sec ?? 0} 秒`
                        : "没折叠（各轨原样）"}
                      {dsDetail.tracks && Object.keys(dsDetail.tracks).length > 0 &&
                        `（${Object.entries(dsDetail.tracks).map(([k, n]) => `${TRACK_NAME[k] ?? "没分轨"} ${n} 段`).join("、")}）`}
                      {dsDetail.n_device_segments ? `，设备轨 ${dsDetail.n_device_segments} 段` : ""}
                    </span>
                  </Tooltip>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="同类别重叠并掉">
                <Tooltip title="「疑似片段」补上来的段常跟已有 AI 段覆盖同一次动作，只是起止差几百毫秒。不并的话重叠那部分会被导两遍，等于偷偷加权">
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
                  <Button size="small" type="link" style={{ paddingLeft: 0 }}
                          onClick={() => setStatsFor([dsDetail.name])}>
                    按时长看
                  </Button>
                  {Object.entries(dsDetail.labels).map(([k, v]) => (
                    <Tag key={k} color={labelColor(k)}>
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
            {(dsDetail.conflicts?.length ?? 0) > 0 && (
              <>
                <Typography.Text strong style={{ display: "block", marginTop: 12 }}>
                  类别冲突（{dsDetail.n_label_conflicts ?? 0} 处，共挖掉{" "}
                  {dsDetail.label_conflict_excluded_sec ?? 0} 秒）
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  同一段时间标了两个类别，重叠那一小段两边都没要。点「去修」直接把工作台开到那一刻，
                  改完起止重新导一次就能拿回来。
                </Typography.Text>
                {/* 挖掉一两秒无所谓，挖掉一大截就不是"边角料"了，得回去改 */}
                {(dsDetail.label_conflict_excluded_sec ?? 0) > dsDetail.total_hours * 3600 * 0.05 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 4 }}
                    message={`挖掉的时间占了这份数据的 ${(
                      ((dsDetail.label_conflict_excluded_sec ?? 0) / (dsDetail.total_hours * 3600)) *
                      100
                    ).toFixed(1)}%，建议先把起止改开再导`}
                  />
                )}
                <Table
                  style={{ marginTop: 4 }}
                  size="small"
                  rowKey={(r) => `${r.task_id}-${r.start_ms}`}
                  dataSource={dsDetail.conflicts}
                  pagination={{ pageSize: 8, size: "small" }}
                  scroll={{ x: "max-content", y: 220 }}
                  columns={[
                    { title: "任务", dataIndex: "task_id", width: 80 },
                    { title: "样本", dataIndex: "sample_code", ellipsis: true },
                    {
                      title: "两个类别",
                      width: 160,
                      render: (_, r) => (
                        <>
                          <Tag>{r.label_a}</Tag>
                          <Tag>{r.label_b}</Tag>
                        </>
                      ),
                    },
                    { title: "挖掉(秒)", dataIndex: "seconds", width: 90 },
                    {
                      title: "",
                      width: 80,
                      render: (_, r) => (
                        <Button
                          size="small"
                          type="link"
                          loading={wsOpening === r.task_id}
                          onClick={() => openTask(r.task_id, r.start_ms)}
                        >
                          去修
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            )}

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
                              <Tag color={labelColor(r.label_a)}>{r.label_a}</Tag>
                              {r.start_a.slice(11)} ~ {r.end_a.slice(11)}
                              {" ／ "}
                              <Tag color={labelColor(r.label_b)}>{r.label_b}</Tag>
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
                        {
                          title: "",
                          width: 80,
                          fixed: "right",
                          // 重叠这一行原来只能看不能动，想核对得自己去任务列表里翻。
                          // 而"这两段是不是同一次动作"恰恰是只有看画面才判断得了的。
                          render: (_, r) => {
                            const ms = msOfSeg(r.task_id, r.start_a);
                            return (
                              <Button
                                size="small"
                                type="link"
                                loading={wsOpening === r.task_id}
                                onClick={() => openTask(r.task_id, ms)}
                              >
                                去修
                              </Button>
                            );
                          },
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
                  {/* CheckableTag 没有 color 属性——它的底色是用来表达"选中没选中"的，
                      硬塞颜色会把这个区别弄没。所以在名字前点一个小色块，
                      既能对上类别颜色，又不动选中态。 */}
                  {labelColor(k) && (
                    <span
                      style={{
                        display: "inline-block", width: 8, height: 8, borderRadius: 2,
                        background: labelColor(k), marginRight: 5, verticalAlign: "middle",
                      }}
                    />
                  )}
                  {k} {dsDetail.labels[k]}
                </Tag.CheckableTag>
              ))}
            </Space>
            <Table<DatasetSegment>
              size="small"
              rowKey={(r) => `${r.task_id}-${r.start}-${r.label}`}
              loading={loadingSegs}
              dataSource={(dsSegs?.rows ?? []).filter((r) => !segLabel || leafOf(r) === segLabel)}
              pagination={{ pageSize: 20, size: "small" }}
              // max-content 会按内容无限撑宽，「去修」被推到屏幕外；给个下限，
              // 剩下的宽度归「样本」那一列。
              // 每一列都定了宽度，加起来 960（80+260+90+175+175+100+80）；
              // x 给这个数，表格正好铺满，也不会有哪一列被多出来的空间撑开。
              // 之前「样本」是唯一没宽度的列，弹窗一放宽它就吃掉全部富余，
              // 样本和类别之间空出一大片。
              scroll={{ x: 960, y: 300 }}
              tableLayout="fixed"
              columns={[
                { title: "任务", dataIndex: "task_id", width: 80 },
                // 给「样本」定宽。原来它是唯一没有宽度的列，于是把弹窗放宽之后
                // 多出来的空间全被它吃了——样本编号明明 230px 就够，却撑出一大片
                // 空白，把「类别」推到老远。260 = 编号本身 230 + 内边距。
                { title: "样本", dataIndex: "sample_code", width: 260, ellipsis: true },
                {
                  // 整条链一起显示：只给根的话，行上永远是「抓挠」，跟上面
                  // 按类别统计出来的「抓挠-躯干 15」对不上，人会以为二级标签
                  // 没导进去——其实导出文件里一直是全的，是这一列只画了 labels[0]
                  title: "类别", dataIndex: "label", width: 190,
                  render: (v: string, r: DatasetSegment) => {
                    // 显示**叶子全名**，跟上面那排 chip 一模一样（抓挠-躯干）。
                    // 之前显示的是 labels[0]（根），所以这一列永远只有「抓挠」，
                    // 看不出标到了哪个部位
                    const leaf = leafOf(r);
                    return (
                      <Space size={2}>
                        <Tag color={labelColor(v)}>{leaf}</Tag>
                        {/* labels 整个字段都没有 = 后端还是旧版，这一列画不出二级标签。
                            不标出来的话人分不清"本来就没有子标签"和"服务还没更新"，
                            只会反复重导数据集——而重导改不了这件事 */}
                        {!("labels" in r) && (
                          <Tooltip title="这个接口还是旧版，只回了根那一级。导出文件里二级/三级标签一直是全的，重新部署一次就能看到——重导数据集没用">
                            <Tag style={{ background: "transparent" }}>旧版接口</Tag>
                          </Tooltip>
                        )}
                      </Space>
                    );
                  },
                },
                // 2026-08-22 14:38:43.248 实际约 170px，190 是拍脑袋定的
                { title: "开始", dataIndex: "start", width: 175 },
                { title: "结束", dataIndex: "end", width: 175 },
                {
                  title: "时长(秒)",
                  dataIndex: "seconds",
                  width: 100,
                  sorter: (a, b) => (a.seconds ?? 0) - (b.seconds ?? 0),
                },
                {
                  title: "",
                  width: 80,
                  // 钉在右边：横向滚动时也够得着。列一多就得先往右拖才能点，
                  // 而这一列恰恰是这张表存在的意义——看到不对的就地点开改。
                  fixed: "right",
                  // 按时长排一下，长得离谱的那几条多半是起止没调好，就地点开改
                  render: (_, r) => (
                    // start_ms 是后加的字段，早先导出的数据集里没有。没有它就只能
                    // 把工作台开在开头，人还得自己按时间戳找——那跟"就地改"差远了。
                    // 与其静默地跳不过去，不如说清楚为什么、以及怎么办。
                    <Tooltip
                      title={
                        r.start_ms == null
                          ? "这份数据集导出得早，片段里没记时间偏移，点进去只能停在开头。重新导出一次就能直接跳到这一段。"
                          : undefined
                      }
                    >
                      <Button
                        size="small"
                        type="link"
                        loading={wsOpening === r.task_id}
                        onClick={() => openTask(r.task_id, r.start_ms)}
                      >
                        去修{r.start_ms == null ? "（无法定位）" : ""}
                      </Button>
                    </Tooltip>
                  ),
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
        // 宽一点、分两栏：左边参数，右边一起训练 + 类别归并，一眼看完不用上下翻
        width={1240}
        style={{ top: 24 }}
      >
        {trainFor && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.15fr)", gap: 24, alignItems: "start" }}>
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
                options={MODEL_TYPES.map((m) => ({ value: m, label: MODEL_TYPE_LABEL[m] ?? m }))}
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
              <Tooltip title="端侧要跟项圈 IMU 的实际采样率一致。QMI8658 没有 16/25/50 档，原生是 31.25 Hz：选 31.25 就不用在固件里软件抽样（没有频率误差、功耗最低）。31.25 下窗口自动用 64 点 = 2.048 秒、步长 32 点 = 1.024 秒">
                <Typography.Text style={{ borderBottom: "1px dashed #666" }}>训练采样率</Typography.Text>
              </Tooltip>
              <Select
                style={{ width: 150 }}
                value={hz}
                onChange={setHz}
                popupMatchSelectWidth={false}
                options={[
                  { value: 16, label: "16Hz" },
                  { value: 25, label: "25Hz" },
                  { value: 15.625, label: "15.625Hz（31.25 二分频）" },
                  { value: 31.25, label: "31.25Hz（QMI8658 原生）" },
                  { value: 50, label: "50Hz" },
                ]}
              />
            </Space>
            <Space>
              <Tooltip title="项圈上有陀螺仪就用 6 轴，只有加速度计就用 3 轴。选错的后果是单向的：端侧只有加速度计、却用 6 轴训，指标再好也代表不了端上的表现——那是拿一块板子上根本没有的信号在学。反过来（端上有陀螺仪却只用 3 轴训）只是浪费了一半信号，不会不准">
                <Typography.Text style={{ borderBottom: "1px dashed #666" }}>传感器轴数</Typography.Text>
              </Tooltip>
              <Radio.Group
                size="small"
                value={axes}
                onChange={(e) => setAxes(e.target.value)}
                options={[
                  { value: 3, label: "3 轴（只用加速度，默认）" },
                  { value: 6, label: "6 轴（加速度+陀螺仪）" },
                ]}
                optionType="button"
              />
            </Space>
            <Space>
              <Checkbox checked={orientFree} onChange={(e) => setOrientFree(e.target.checked)}>
                <Tooltip title="用户怎么戴都不限制，所以模型不该看佩戴方向。勾上后：输入换成跟方向无关的量（竖直/水平分量、模长、偏离重力的角度、jerk），正着戴、倒着戴、转个角度输入都一样；训练集每个窗口再加 2 份随机旋转（含窗口内的小幅滑动）。不勾就是老的输入（重力对齐 + 姿态角），佩戴方向一变判决会跟着变">
                  <span style={{ borderBottom: "1px dashed #666" }}>方向无关（怎么戴都识别，推荐）</span>
                </Tooltip>
              </Checkbox>
            </Space>
            <Space wrap>
              <Tooltip title="甩动、短促的抓挠这类一两秒的动作比训练窗口（默认 2 秒）还短：按片段切时整段被丢掉，按记录切时被前后别的片段多数投票吞掉——模型没见过甩动，一甩就判成抓挠。选上的类别：比窗口短的片段以事件为中心、带上前后真实的上下文补成一段，每个训练窗口都完整包含这次事件；上下文碰到别的类别的标注就截住，不够长用这段真实数据镜像补齐，不编造信号。比窗口长的片段不动">
                <span style={{ borderBottom: "1px dashed #666", fontSize: 13 }}>短促动作补齐</span>
              </Tooltip>
              <Select
                mode="multiple"
                size="small"
                allowClear
                style={{ width: 280 }}
                placeholder="不补（这次训练里没有短促动作类别）"
                value={shortEffective}
                onChange={(v) => setShortLabels(v)}
                options={shortOptions.map((t) => {
                  const c = shortCount(t);
                  const name = trainTargets.includes(t) ? t : `${t}（并进 ${remapEdits[t]}）`;
                  return { value: t, label: `${name} · ${c.short}/${c.n} 段短于 2 秒` };
                })}
                maxTagCount="responsive"
              />
              {shortLabels === null && shortEffective.length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  自动选了有比 2 秒短的片段的类别（{shortEffective.map((t) => `${t} ${shortCount(t).short} 段`).join("、")}）
                </Typography.Text>
              )}
            </Space>
            <Space>
              <Checkbox checked={edgeSize} onChange={(e) => setEdgeSize(e.target.checked)}>
                <Tooltip title="要上端侧（烧进项圈）就勾上。默认的模型是 200 棵不限深的树，几十 MB，板子上装不下。勾上之后：rf = 20 棵 × 深 10（约 100 KB），跟板上现在跑的 edge_rf_d10 同规格；cnn = filters 32/64/128（int8 约 35 KB）；xgb = 50 轮 × 深 6。要更小的，在后面填具体规格，或者训完看「体积曲线」挑">
                  <span style={{ borderBottom: "1px dashed #666" }}>端侧尺寸（要烧进项圈就勾）</span>
                </Tooltip>
              </Checkbox>
              {edgeSize && modelType === "cnn" && (
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>filters</Typography.Text>
                  <Input
                    size="small"
                    style={{ width: 120 }}
                    value={edgeFilters}
                    onChange={(e) => setEdgeFilters(e.target.value)}
                    placeholder="32,64,128"
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    三层卷积的通道数；空 = 32/64/128（int8 约 35 KB）。16/32/64 约 9 KB。cnn 会把含缺失值（蓝牙断联）的窗口丢掉
                  </Typography.Text>
                </Space>
              )}
              {edgeSize && modelType !== "cnn" && (
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>棵数</Typography.Text>
                  <InputNumber size="small" min={1} max={200} style={{ width: 70 }} value={edgeTrees} onChange={(v) => setEdgeTrees(v ?? null)} placeholder="20" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>深度</Typography.Text>
                  <InputNumber size="small" min={2} max={30} style={{ width: 70 }} value={edgeDepth} onChange={(v) => setEdgeDepth(v ?? null)} placeholder="10" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {modelType === "rf"
                      ? "空 = 20 棵 × 深 10（约 100 KB，板上 edge_rf_d10 同规格）；体积大致跟 棵数 × 2^深度 走"
                      : modelType === "xgb"
                        ? "空 = 50 轮 × 深 6"
                        : `${modelType} 用端侧那套超参（configs/ml_edge.yaml），能不能导到板上要看 algo_tinyml 支不支持这种模型`}
                  </Typography.Text>
                </Space>
              )}
            </Space>
            {axes === 3 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                只用加速度那三列训，陀螺仪整个丢掉。
                <b>只在项圈上没有陀螺仪时才该这么选</b>——不然等于白扔一半信号。
                3 轴的预处理产物单独存，跟 6 轴那版互不覆盖，两版可以并存对比。
              </Typography.Text>
            )}
            <Checkbox checked={skipSyn} onChange={(e) => setSkipSyn(e.target.checked)}>
              跳过合成数据（只训练纯标注那一版，快一些）
            </Checkbox>
            <Space wrap>
              <Tooltip title="只砍训练集的窗口，验证集不动，指标还是在原分布上算的。砍数据会丢多样性——先看上一版的「训练集」统计和「回放」，确认少的类别是量少不是标错，再开这个对比一版">
                <span style={{ cursor: "help" }}>类别均衡</span>
              </Tooltip>
              <Select
                size="small"
                style={{ width: 300 }}
                value={balance.startsWith("cap:") ? "cap" : balance}
                onChange={(v) => setBalance(v === "cap" ? "cap:2000" : v)}
                options={[
                  { value: "none", label: "不动（默认，靠类别权重补）" },
                  { value: "min", label: "多的类砍到跟最少的一样多" },
                  { value: "cap", label: "每类最多 N 个窗口" },
                ]}
              />
              {balance.startsWith("cap:") && (
                <InputNumber
                  size="small" min={100} step={100}
                  value={Number(balance.slice(4)) || 2000}
                  onChange={(v) => setBalance(`cap:${v ?? 2000}`)}
                  addonAfter="窗"
                />
              )}
            </Space>

            {/* ── 数据处理 / 模型参数 ─────────────────────────────── */}
            <Divider style={{ margin: "4px 0" }} orientation="left" plain>数据处理 / 模型参数（不填用默认）</Divider>
            <Space wrap size={[12, 6]}>
              <Tooltip title={`一个窗口多长。短促动作（抓挠一两秒）窗口太长会被别的动作冲淡；状态类（睡觉 / 未佩戴）窗口长一点更稳。不填按采样率自动：${autoWin(hz, 2)} 秒（${Math.round(autoWin(hz, 2) * hz)} 点）`}>
                <span style={{ borderBottom: "1px dashed #666" }}>时间窗口</span>
              </Tooltip>
              <InputNumber size="small" min={0.5} max={20} step={0.256} value={windowS} onChange={(v) => setWindowS(v ?? null)}
                placeholder={`自动 ${autoWin(hz, 2)}`} addonAfter="秒" style={{ width: 150 }} />
              <Tooltip title={`窗口每次往前挪多少。越小窗口越多（训练慢、相邻窗口很像），一般取窗口的一半。不填按采样率自动：${autoWin(hz, 1)} 秒`}>
                <span style={{ borderBottom: "1px dashed #666" }}>滑动步长</span>
              </Tooltip>
              <InputNumber size="small" min={0.1} max={20} step={0.128} value={strideS} onChange={(v) => setStrideS(v ?? null)}
                placeholder={`自动 ${autoWin(hz, 1)}`} addonAfter="秒" style={{ width: 150 }} />
              {(windowS != null || strideS != null) && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  = {Math.round((windowS ?? autoWin(hz, 2)) * hz)} 点 / 步 {Math.round((strideS ?? autoWin(hz, 1)) * hz)} 点
                  {windowS != null && <Button size="small" type="link" onClick={() => { setWindowS(null); setStrideS(null); }}>恢复自动</Button>}
                </Typography.Text>
              )}
            </Space>
            <Space wrap size={[12, 6]}>
              <Tooltip title="一个窗口里混了两种动作时，这个窗口算哪一类。多数投票 = 占时间多的那类（默认）；窗口中心 = 窗口正中那一刻的标签，短促动作在窗口边上时不会被吞掉，但标签噪声大一点">
                <span style={{ borderBottom: "1px dashed #666" }}>窗口标签</span>
              </Tooltip>
              <Segmented size="small" value={labelMode} onChange={(v) => setLabelMode(v as "majority" | "center")}
                options={[{ value: "majority", label: "多数投票（默认）" }, { value: "center", label: "窗口中心" }]} />
            </Space>
            {modelType !== "cnn" && (
              <Space wrap size={[12, 6]}>
                <Tooltip title="树模型的超参。不填用默认（随机森林 200 棵、不限深、叶子最少 1 个样本）。勾了「端侧尺寸」时棵数 / 深度以上面端侧那两格为准，这里只改叶子和特征。验证集远低于训练集（过拟合）时把「叶子最少样本」调大（5~20）">
                  <span style={{ borderBottom: "1px dashed #666" }}>模型参数</span>
                </Tooltip>
                {!edgeSize && (
                  <>
                    <InputNumber size="small" min={10} max={2000} step={50} value={modelParams.n_estimators ?? null}
                      onChange={(v) => setModelParams({ ...modelParams, n_estimators: v ?? null })} placeholder="默认" addonBefore="棵数" style={{ width: 150 }} />
                    <InputNumber size="small" min={2} max={100} value={modelParams.max_depth ?? null}
                      onChange={(v) => setModelParams({ ...modelParams, max_depth: v ?? null })} placeholder="不限" addonBefore="最大深度" style={{ width: 170 }} />
                  </>
                )}
                <InputNumber size="small" min={1} max={500} value={modelParams.min_samples_leaf ?? null}
                  onChange={(v) => setModelParams({ ...modelParams, min_samples_leaf: v ?? null })} placeholder="1" addonBefore="叶子最少样本" style={{ width: 180 }} />
                <Select size="small" style={{ width: 200 }} allowClear placeholder="每次分裂看的特征：默认 sqrt"
                  value={modelParams.max_features ?? undefined} onChange={(v) => setModelParams({ ...modelParams, max_features: v ?? null })}
                  options={[{ value: "sqrt", label: "特征：sqrt（默认）" }, { value: "log2", label: "特征：log2（更随机）" }, { value: "0.5", label: "特征：一半" }]} />
              </Space>
            )}
          </Space>
          <Space direction="vertical" style={{ width: "100%" }}>
            {/* ── 一起训练的其它数据集 ──────────────────────────────
                单独一份常常训不了：按片段取只收人确认过的片段，而没人会去
                确认「活动」「睡觉」，整份只有正样本，分类器没有可对比的负类 */}
            <Divider style={{ margin: "4px 0" }} />
            <Space align="start" wrap>
              <Typography.Text>一起训练</Typography.Text>
              <Select
                mode="multiple"
                allowClear
                style={{ minWidth: 380 }}
                placeholder="再挑几份数据集合并训练（可不选）"
                value={extraDs}
                onChange={setExtraDs}
                options={(datasets ?? [])
                  .filter((d) => d.name !== trainFor.name)
                  .map((d) => ({
                    value: d.name,
                    label: `${d.name}（${d.n_segments} 段 / ${d.total_hours} 小时）`,
                  }))}
              />
            </Space>
            {extraRows.length > 0 && (
              <Space wrap size={4}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>各自的原始采样率：</Typography.Text>
                {extraRows.map((d) => (
                  <Space key={d.name} size={4}>
                    <Typography.Text style={{ fontSize: 12 }}>{d.name}</Typography.Text>
                    <Select
                      size="small"
                      style={{ width: 84 }}
                      value={extraHz[d.name] ?? sourceHz}
                      onChange={(v) => setExtraHz((m) => ({ ...m, [d.name]: v }))}
                      options={[16, 25, 50, 100].map((v) => ({ value: v, label: `${v}Hz` }))}
                    />
                  </Space>
                ))}
              </Space>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「按片段取」的数据集只收人确认过的片段，而没人会去确认「活动」「睡觉」——
              整份可能只有正样本，分类器没有可对比的负类。掺上带状态标签的老批次再训。
              <b>老批次多半是 16Hz 导出的，新的 NAS 原始数据是 50Hz</b>，各报各的，
              别一刀切，不然会按错的采样率重采样。
            </Typography.Text>

            {/* ── 类别归并 ──────────────────────────────────────────
                两个用处：细类太少就并进兄弟类别；不训的行为折进「活动」当负样本。
                后者是必须的——remap 表对不上名字的类别会被静默丢掉 */}
            {trainCats.length > 0 && (
              <>
                <Divider style={{ margin: "4px 0" }} />
                <Space style={{ justifyContent: "space-between", width: "100%" }}>
                  <Typography.Text>类别归并（可不改）</Typography.Text>
                  <Tooltip title={`段数少于 ${MIN_SEGMENTS} 或不到 1 分钟、又是「自成一类」的细类，并进上一级（上一级加起来还不够就再往上）。并完还能逐行改`}>
                    <Button size="small" onClick={mergeSmall}>太少的细类并进上一级</Button>
                  </Tooltip>
                </Space>
                <Table<TrainRow>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  scroll={{ y: 260 }}
                  dataSource={trainTree}
                  columns={[
                    {
                      title: "这次数据里的类别（点 + 看细类）", dataIndex: "name", width: 200,
                      render: (v: string, c) =>
                        c.isGroup ? (
                          <Typography.Text strong>{v}（{c.children?.length} 个细类）</Typography.Text>
                        ) : (
                          <Tag color={labelColor(v.split("-")[0])}>{v}</Tag>
                        ),
                    },
                    {
                      title: "份量", width: 120,
                      // **段数少和时长短是两回事，都得标。** 未佩戴 2 段 / 7197 秒：
                      // 按时长看很充足，可训练是按片段分组切分的——1 段进训练、1 段整个
                      // 进验证，模型只见过一次不戴项圈的样子，验证那段全认成了静止，
                      // 召回 0（2026-09-23 第一次跑通的那一版）
                      render: (_, c) => {
                        const fewSeg = c.n < MIN_SEGMENTS;
                        const short = c.sec < 60;
                        const text = (
                          <Typography.Text type={fewSeg || short ? "warning" : undefined} style={{ fontSize: 12 }}>
                            {c.n} 段 / {fmtSecs(c.sec)}
                          </Typography.Text>
                        );
                        if (!fewSeg && !short) return text;
                        return (
                          <Tooltip
                            title={
                              fewSeg
                                ? `只有 ${c.n} 段。训练按片段分组切分：一两段进训练、剩下的整段进验证——模型只见过这一类的一两个样子，时长再长也没用，验证结果基本看运气。并进别的类别，或者先攒够段数`
                                : "不到一分钟，切成窗口没几个，这一类训不出来。并进兄弟类别，或者先攒够份量"
                            }
                          >
                            {text}
                          </Tooltip>
                        );
                      },
                    },
                    {
                      title: "训练时算作", width: 210,
                      render: (_, c) => c.isGroup ? (
                        <Select
                          size="small"
                          showSearch
                          style={{ width: 195 }}
                          placeholder="整组一起设…"
                          value={null}
                          // 大类这一行不存值：选了就把底下每一行都改成它
                          onChange={(v: string) => setRemapEdits((m) => {
                            const next = { ...m };
                            for (const k of c.children ?? []) {
                              next[k.name] = v === DROP ? "" : v === KEEP_EACH ? k.name : v;
                            }
                            return next;
                          })}
                          options={[
                            { value: c.name, label: `整组并成「${c.name}」一类` },
                            { value: KEEP_EACH, label: "整组各自成一类" },
                            ...(remap?.classes ?? []).filter((v) => v !== c.name).map((v) => ({ value: v, label: `整组算作 ${v}` })),
                            { value: DROP, label: "整组不参与训练" },
                          ]}
                        />
                      ) : (
                        <Select
                          size="small"
                          allowClear
                          showSearch
                          style={{ width: 195 }}
                          placeholder="不参与训练"
                          value={remapEdits[c.name] || undefined}
                          // DROP 是"不参与训练"的哨兵值，存进去是空字符串——
                          // 空字符串当不了 Select 的 value（antd 会当成"没选"，
                          // 于是选项永远选不中、看着像没生效）
                          onChange={(v) => setRemapEdits((m) => ({ ...m, [c.name]: v === DROP || v == null ? "" : v }))}
                          options={dedupeOpts([
                            // 上级排最前（近的在前）：细类最常见的去处就是并进上级
                            // （舔-大腿内侧 → 舔-大腿 → 舔），以前它们夹在一长串兄弟里得翻
                            ...c.chain.slice(0, -1).reverse().map((u) => ({ value: u, label: `并进上级 ${u}` })),
                            // 然后是自成一类：**这就是「识别出是什么抓挠」的做法**，
                            // 选了它这一类就是一个独立的训练类别
                            { value: c.name, label: `${c.name}（自成一类）` },
                            // 再是默认那几类（活动/睡觉/抓挠），把不训的行为折进去当负样本
                            ...(remap?.classes ?? [])
                              .filter((v) => v !== c.name)
                              .map((v) => ({ value: v, label: v })),
                            // 同批数据里的别的类别，用来把太少的细类并进兄弟
                            ...trainCats
                              .filter((o) => o.name !== c.name && !(remap?.classes ?? []).includes(o.name))
                              .map((o) => ({ value: o.name, label: `并进 ${o.name}` })),
                            // **「不参与训练」得是一个真选项。** 原来它只是 placeholder，
                            // 想清空只能去点那个悬停才出现的小 ✕——没人找得到，而
                            // "这一类干脆不要"恰恰是常用操作（份量太少、这次不训它）
                            { value: DROP, label: "不参与训练（丢掉这些样本）" },
                          ])}
                        />
                      ),
                    },
                    {
                      title: "", width: 110,
                      render: (_, c) => {
                        if (c.isGroup) {
                          // 大类那一行：底下几行要丢、各算作几类，一眼看完不用展开
                          const kids = c.children ?? [];
                          const dropped = kids.filter((k) => !finalOf(k.name)).length;
                          const n = new Set(kids.map((k) => finalOf(k.name)).filter(Boolean)).size;
                          return (
                            <Typography.Text type={dropped ? "danger" : "secondary"} style={{ fontSize: 12 }}>
                              {n ? `→ ${n} 类` : ""}{dropped ? ` ${dropped} 行丢掉` : ""}
                            </Typography.Text>
                          );
                        }
                        const cls = finalOf(c.name);
                        // 留空 = 不参与训练，那些样本会被丢掉。**必须说出来**，
                        // 不然人以为数据都进去了（以前就是只在训练日志里打一句）
                        if (!cls) {
                          return (
                            <Tooltip title="这一类的样本不会进训练集。要留下就在左边选一个——自成一类，或者并进别的类别">
                              <Tag color="red">会被丢掉</Tag>
                            </Tooltip>
                          );
                        }
                        if (cls === c.name) {
                          return <Tag color="green">独立一类</Tag>;
                        }
                        return <Typography.Text type="secondary" style={{ fontSize: 12 }}>→ {cls}</Typography.Text>;
                      },
                    },
                  ]}
                />
                {/* 最终会训出哪几类——这是提交前最该确认的一件事。
                    少于两类根本训不了：分类器要有东西可比 */}
                <Alert
                  type={trainTargets.length < 2 ? "error" : "info"}
                  showIcon
                  message={
                    trainTargets.length < 2
                      ? `这样只会训出 ${trainTargets.length} 个类别，分类器没东西可比，训不了`
                      : `这次会训出 ${trainTargets.length} 个类别`
                  }
                  description={
                    <Space wrap size={4}>
                      {trainTargets.map((t) => {
                        // 归并之后这一类一共多少段。单看每一行不够：几行各 2 段的并在一起可能就够了
                        const n = trainCats.filter((c) => remapEdits[c.name] === t).reduce((a, c) => a + c.n, 0);
                        return (
                          <Tooltip
                            key={t}
                            title={n < MIN_SEGMENTS ? `一共只有 ${n} 段——验证结果不可信，这一类的 F1 别当真` : `${n} 段`}
                          >
                            <Tag color={n < MIN_SEGMENTS ? "warning" : labelColor(t.split("-")[0])}>
                              {t}{n < MIN_SEGMENTS ? `（仅 ${n} 段）` : ""}
                            </Tag>
                          </Tooltip>
                        );
                      })}
                      {trainTargets.length < 2 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          　在「一起训练」里掺上带「活动」「睡觉」的老批次，或者把几个类别拆成独立的
                        </Typography.Text>
                      )}
                    </Space>
                  }
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <b>想识别出「是什么抓挠」，就把「抓挠-头颈耳」「抓挠-躯干」各选「自成一类」</b>——
                  它们就会变成独立的训练类别，模型不只说这是抓挠，还说是哪种。代价是每一类都要够份量，
                  几十秒的那种训不出来，不如并进兄弟类别。
                  <br />
                  这张表只在训练时生效，<b>不动 NAS 上的导出</b>，同一份数据集可以换着配反复试。
                  {remap?.available === false && `　拿不到默认的重映射表（${remap.error}），所以没有预填，要自己每一行都选。`}
                </Typography.Text>
              </>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              训练在 AI 服务那台机器上跑，几十分钟到几小时不等，可以关掉页面。回来在「训练记录」里看结果。
            </Typography.Text>
          </Space>
          </div>
        )}
      </Modal>

      <TrainLogModal
        versionId={logFor}
        onClose={() => setLogFor(null)}
        onFinished={() => qc.invalidateQueries({ queryKey: ["model-versions"] })}
      />

      <SizeCurveModal
        versionId={curveFor?.id ?? null}
        modelType={curveFor?.model_type ?? "rf"}
        cached={(curveFor && (metricsOf(curveFor)?.size_curve as SizeCurve | undefined)) || null}
        onClose={() => {
          qc.invalidateQueries({ queryKey: ["model-versions"] });
          setCurveFor(null);
        }}
        onRetrain={(spec) => {
          // 带着这一格的规格打开训练弹窗：同一份数据集、同样的轴数/采样率/归并表，只换尺寸
          if (!curveFor) return;
          const sp = specOf(curveFor);
          const ds = (datasets ?? []).find((d) => d.name === sp.date);
          if (!ds) {
            message.warning(`数据集「${String(sp.date)}」已经不在了，没法按它重训`);
            return;
          }
          openTrain(ds);
          setModelType(curveFor.model_type);
          setEdgeSize(true);
          if (typeof sp.axes === "number") setAxes(sp.axes);
          setOrientFree(sp.channel_mode === "inv");
          setEdgeTrees(spec.edge_trees ?? null);
          setEdgeDepth(spec.edge_depth ?? null);
          setEdgeFilters(spec.edge_filters ? spec.edge_filters.join(",") : "");
          qc.invalidateQueries({ queryKey: ["model-versions"] });
          setCurveFor(null);
          message.info(
            spec.edge_filters
              ? `已按 filters ${spec.edge_filters.join("/")} 填好，确认后提交`
              : `已按 ${spec.edge_trees} 棵 × 深 ${spec.edge_depth} 填好，确认后提交`,
          );
        }}
      />

      <TrainReviewModal
        versionId={reviewFor?.id ?? null}
        title={`数据 · 回放 · 训练记录 #${reviewFor?.id ?? ""}${reviewFor?.model_version ? `（${reviewFor.model_version}）` : ""}`}
        stats={(reviewFor && (metricsOf(reviewFor)?.dataset as DatasetStats | undefined)) || null}
        review={(reviewFor && (metricsOf(reviewFor)?.review as TrainReview | undefined)) || null}
        diag={(reviewFor && (metricsOf(reviewFor) as TrainDiag | undefined)) || null}
        modelDone={reviewFor?.status === "done"}
        onClose={() => setReviewFor(null)}
        onRefresh={() => void qc.invalidateQueries({ queryKey: ["model-versions"] })}
      />

      <Modal title={`训练详情 #${detail?.id ?? ""}`} open={detail != null} onCancel={() => setDetail(null)} footer={null} width={720}>
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].label}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="模型路径">{detail.model_path || "-"}</Descriptions.Item>
            {/* 效果放最前面：点进详情最想知道的就是"这一版到底怎么样"，
                原来是一坨原始 JSON，得自己在里面找 per_class */}
            {perClassOf(detail).length > 0 && (
              <Descriptions.Item label="各类效果">
                <Table
                  size="small"
                  rowKey="cls"
                  pagination={false}
                  dataSource={perClassOf(detail)}
                  columns={[
                    { title: "类别", dataIndex: "cls" },
                    { title: "精确率", dataIndex: "p", render: (x: number) => x.toFixed(3) },
                    { title: "召回", dataIndex: "r", render: (x: number) => x.toFixed(3) },
                    {
                      title: "F1", dataIndex: "f1",
                      render: (x: number) => <Tag color={f1Color(x)}>{x.toFixed(3)}</Tag>,
                    },
                  ]}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  准确率 {(Number(metricsOf(detail)?.accuracy) || 0).toFixed(3)}，
                  macro-F1 {(f1Of(detail) ?? 0).toFixed(3)}。
                  精确率低 = 报出来的里面混了别的类别；召回低 = 这一类很多没报出来。
                </Typography.Text>
              </Descriptions.Item>
            )}
            {edgeOf(detail) && (
              <Descriptions.Item label={detail.model_type === "cnn" ? "float32 vs int8（端侧）" : "服务器 vs 端侧 C"}>
                {/* 同一个模型两种跑法并排：左边是训练机上的数，右边是板上那份 C 跑出来的。
                    差太多就是导出/量化有问题，不是模型的问题 */}
                {(() => {
                  const e = edgeOf(detail)!;
                  const srv = Object.fromEntries(perClassOf(detail).map((c) => [c.cls, c]));
                  const rows = Object.entries(e.per_class ?? {}).map(([cls, m]) => ({
                    cls,
                    sp: srv[cls]?.p, sr: srv[cls]?.r, sf: srv[cls]?.f1,
                    ep: m.precision ?? 0, er: m.recall ?? 0, ef: m["f1-score"] ?? 0,
                  }));
                  const leftName = detail.model_type === "cnn" ? "float32（训练机）" : "sklearn（训练机）";
                  const rightName = detail.model_type === "cnn" ? "int8（板上 C）" : "板上 C（float32 特征 · 量化叶子）";
                  const diff = (a?: number, b?: number) =>
                    a == null || b == null ? "-" : (
                      <span style={{ color: b - a < -0.03 ? "#f5222d" : b - a > 0.03 ? "#52c41a" : "#888" }}>
                        {b - a >= 0 ? "+" : ""}{(b - a).toFixed(3)}
                      </span>
                    );
                  return (
                    <>
                      <Table
                        size="small"
                        rowKey="cls"
                        pagination={false}
                        dataSource={rows}
                        columns={[
                          { title: "类别", dataIndex: "cls", width: 110 },
                          {
                            title: leftName, children: [
                              { title: "P", dataIndex: "sp", width: 64, render: (x?: number) => x?.toFixed(3) ?? "-" },
                              { title: "R", dataIndex: "sr", width: 64, render: (x?: number) => x?.toFixed(3) ?? "-" },
                              { title: "F1", dataIndex: "sf", width: 70, render: (x?: number) => x == null ? "-" : <Tag color={f1Color(x)}>{x.toFixed(3)}</Tag> },
                            ],
                          },
                          {
                            title: rightName, children: [
                              { title: "P", dataIndex: "ep", width: 64, render: (x: number) => x.toFixed(3) },
                              { title: "R", dataIndex: "er", width: 64, render: (x: number) => x.toFixed(3) },
                              { title: "F1", dataIndex: "ef", width: 70, render: (x: number) => <Tag color={f1Color(x)}>{x.toFixed(3)}</Tag> },
                            ],
                          },
                          { title: "F1 差", width: 70, render: (_, r) => diff(r.sf, r.ef) },
                        ]}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        macro-F1：{leftName} {(f1Of(detail) ?? 0).toFixed(3)} → {rightName} {e.macro_f1.toFixed(3)}
                        （{diff(f1Of(detail) ?? undefined, e.macro_f1)}）
                        {typeof e.agree_with_float === "number" && `；逐窗口判决一致 ${(e.agree_with_float * 100).toFixed(1)}%`}
                        {typeof e.agree_with_sklearn === "number" && `；逐窗口判决一致 ${(e.agree_with_sklearn * 100).toFixed(1)}%`}
                        {e.quant_percentile != null && `；量程取 ${e.quant_percentile} 百分位`}
                        {e.split && `；留出集 ${e.split} ${e.n_windows} 窗`}
                        。差在 ±0.03 内是正常的量化/实现差异；红的是端侧明显掉了，先查导出不是查模型。
                      </Typography.Text>
                    </>
                  );
                })()}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="训练设置">
              {(() => {
                const sp = specOf(detail);
                const remap = (sp.label_remap as Record<string, string> | undefined) ?? {};
                const targets = [...new Set(Object.values(remap))];
                return (
                  <Space direction="vertical" size={2}>
                    <span>
                      {(sp.date as string) ?? "-"}
                      {((sp.extra_datasets as { date: string }[] | undefined) ?? []).map((e) => ` + ${e.date}`).join("")}
                    </span>
                    <span>
                      {Number(sp.axes) === 3 ? "3 轴（只用加速度）" : "6 轴（加速度+陀螺仪）"} ·
                      {sp.channel_mode === "inv" ? " 方向无关 ·" : ""}
                      原始 {String(sp.source_hz ?? "-")}Hz → 训练 {String(sp.hz ?? "-")}Hz · {detail.model_type}
                      {sp.skip_syn ? " · 跳过合成数据" : ""}
                    </span>
                    {targets.length > 0 && (
                      <span>
                        训练类别：{targets.map((t) => <Tag key={t}>{t}</Tag>)}
                      </span>
                    )}
                  </Space>
                );
              })()}
            </Descriptions.Item>
            <Descriptions.Item label="原始参数 / 指标">
              {/* 原样的 JSON 留着排查用，但收起来——不该是人第一眼看到的东西 */}
              <details>
                <summary style={{ cursor: "pointer" }}>展开</summary>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.dataset_spec}</pre>
                <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.metrics || "-"}</pre>
              </details>
            </Descriptions.Item>
            {edgeOf(detail)?.footprint && (
              <Descriptions.Item label="端侧资源占用">
                <EdgeFootprint
                  fp={edgeOf(detail)!.footprint!}
                  onDownload={(kind) => downloadEdgeBundle(detail.id, edgeZipName(detail, kind), kind)}
                />
              </Descriptions.Item>
            )}
            {detail.error && (
              <Descriptions.Item label="错误">
                <Typography.Text type="danger">{detail.error}</Typography.Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Modal>

      {/* 类别统计。段数看不出份量——一段睡觉半小时和一段抓挠 2 秒都算"1 段"，
          按段数排和按时长排能得出完全相反的结论。判断均不均衡只能看时长。 */}
      <Modal
        open={statsFor !== null}
        onCancel={() => setStatsFor(null)}
        title={
          statsFor?.length
            ? `类别统计 · ${statsFor.length} 份数据集`
            : "类别统计 · 全部数据集"
        }
        footer={null}
        width={900}
      >
        {stats && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Typography.Text>
                合计 <strong>{stats.total_hours}</strong> 小时 / {stats.total_segments} 段，
                来自 {stats.datasets.length} 份数据集
              </Typography.Text>
              {stats.missing.length > 0 && (
                <Typography.Text type="danger">
                  {stats.missing.length} 份读不到导出文件：{stats.missing.join("、")}
                </Typography.Text>
              )}
            </Space>
            <Table
              rowKey="label"
              size="small"
              loading={loadingStats}
              pagination={false}
              dataSource={stats.rows}
              scroll={{ y: 420 }}
              // 展开看细类。**大类够不等于细类够**：抓挠 1125 秒占 94%，
              // 看着很充足，可摊开可能某个部位只有几十秒，根本训不出二级。
              // 老数据集回不出细类，那种行就不给展开箭头。
              // 字段叫 sub_labels 不叫 children：后者会被 Table 当成树形子行
              // 自动展开，跟这里的明细表叠成两份
              expandable={{
                rowExpandable: (r) => (r.sub_labels?.length ?? 0) > 0,
                expandedRowRender: (r) => (
                  <Table
                    rowKey="label"
                    size="small"
                    pagination={false}
                    showHeader={false}
                    dataSource={r.sub_labels ?? []}
                    columns={[
                      {
                        title: "细类", width: 140,
                        render: (_, k) =>
                          k.is_root_only
                            ? <Typography.Text type="secondary">{k.label}</Typography.Text>
                            : <Tag color={labelColor(r.label)}>{k.label}</Tag>,
                      },
                      { title: "段数", dataIndex: "n_segments", width: 80,
                        render: (v: number) => `${v} 段` },
                      {
                        title: "时长", width: 110,
                        render: (_, k) =>
                          fmtSecs(k.seconds),
                      },
                      {
                        title: "占本类", width: 200,
                        render: (_, k) => (
                          <Space size={6}>
                            <div style={{ width: 100, height: 6, background: "rgba(128,128,128,.25)", borderRadius: 3 }}>
                              <div style={{
                                width: `${Math.max(k.pct_in_parent, 0.5)}%`, height: "100%", borderRadius: 3,
                                background: labelColor(r.label) ?? "#1677ff",
                              }} />
                            </div>
                            <span style={{ fontSize: 12 }}>{k.pct_in_parent}%</span>
                          </Space>
                        ),
                      },
                      {
                        title: "各数据集贡献",
                        render: (_, k) => (
                          <Space size={4} wrap>
                            {Object.entries(k.by_dataset).map(([n, sec]) => (
                              <Tooltip key={n} title={`${n}：${fmtSecs(sec)}`}>
                                <Tag>{n.replace(/^ds_/, "")} {fmtSecs(sec)}</Tag>
                              </Tooltip>
                            ))}
                          </Space>
                        ),
                      },
                    ]}
                  />
                ),
              }}
              columns={[
                {
                  title: "类别", dataIndex: "label", width: 160,
                  // 有几个细类直接写在大类旁边——不展开也该知道这个大类是不是
                  // 一整块，还是摊在好几个部位上
                  render: (v: string, r) => (
                    <Space size={4}>
                      <Tag color={labelColor(v)}>{v}</Tag>
                      {(r.sub_labels?.filter((k) => !k.is_root_only).length ?? 0) > 0 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {r.sub_labels!.filter((k) => !k.is_root_only).length} 个细类
                        </Typography.Text>
                      )}
                    </Space>
                  ),
                },
                { title: "段数", dataIndex: "n_segments", width: 80,
                  sorter: (a, b) => a.n_segments - b.n_segments },
                {
                  title: "时长", width: 110,
                  sorter: (a, b) => a.seconds - b.seconds,
                  render: (_, r) =>
                    fmtSecs(r.seconds),
                },
                {
                  title: "占比", width: 200,
                  sorter: (a, b) => a.pct - b.pct,
                  // 数字之外再画一条，比例悬殊时（睡觉 70% vs 抓挠 0.3%）
                  // 一眼就看出来，不用在小数点后面数零
                  render: (_, r) => (
                    <Space size={6}>
                      <div style={{ width: 100, height: 8, background: "rgba(128,128,128,.25)", borderRadius: 4 }}>
                        <div style={{
                          width: `${Math.max(r.pct, 0.5)}%`, height: "100%", borderRadius: 4,
                          background: labelColor(r.label) ?? "#1677ff",
                        }} />
                      </div>
                      <span>{r.pct}%</span>
                    </Space>
                  ),
                },
                {
                  title: "各数据集贡献",
                  render: (_, r) => (
                    <Space size={4} wrap>
                      {Object.entries(r.by_dataset).map(([n, sec]) => (
                        <Tooltip key={n} title={`${n}：${fmtSecs(sec)}`}>
                          <Tag>{n.replace(/^ds_/, "")} {fmtSecs(sec)}</Tag>
                        </Tooltip>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10 }}>
              点左边的箭头**展开看细类**——大类够不等于细类够：抓挠总时长很长，摊到
              头颈耳/躯干/肩胸上可能某一类只有几十秒，那就训不出二级标签，只能先当一类用。
              「X（未细分）」是只标到大类、没往下点的那部分。
              <br />
              「各数据集贡献」能看出某个类别是不是只有某一批数据里有——只有一份贡献的类别，
              模型很可能只是记住了那一批的场地/设备，换个场地就不认了。
            </Typography.Paragraph>
          </>
        )}
      </Modal>
    </div>
  );
}


/** 导出弹窗里的「预览统计」：这批数据导出来会是什么样——各类别多少段、多长、占比，跳过 / 挖掉了多少 */
function ExportPreview({
  meta, targets, setTargets, factor, setFactor,
}: {
  meta: TrainDataset;
  targets: Record<string, number>;
  setTargets: (t: Record<string, number>) => void;
  factor: number;
  setFactor: (f: number) => void;
}) {
  const secs = meta.label_seconds ?? {};
  const flat = Object.keys({ ...meta.labels, ...secs })
    .map((k) => ({ label: k, n: meta.labels[k] ?? 0, sec: secs[k] ?? 0, depth: 1 }))
    .sort((a, b) => b.sec - a.sec || b.n - a.n);
  // 按**减量前**的树显示：滑块的上限是原来有多少。先只看大类，点开再看细类。
  // 老后端没有树，退回平铺
  const tree = meta.label_tree_before ?? meta.label_tree;
  const roots: LabelTreeNode[] = tree ?? flat;
  // 每个大类留多少：滑块定的，没拖过就是全留
  const keepOf = (r: LabelTreeNode) => Math.min(targets[r.label] ?? r.sec, r.sec);
  type Row = LabelTreeNode & { key: string; ratio: number; isRoot: boolean; children?: Row[] };
  // 细类按所属大类的保留比例估：抽的时候是按段随机抽，各细类大致同比例减少
  const keyed = (ns: LabelTreeNode[], ratio: number | null, pre = ""): Row[] =>
    ns.map((n) => {
      const r = ratio ?? (n.sec ? keepOf(n) / n.sec : 1);
      return {
        ...n,
        key: `${pre}/${n.label}`,
        ratio: r,
        isRoot: ratio == null,
        ...(n.children ? { children: keyed(n.children, r, `${pre}/${n.label}`) } : {}),
      } as Row;
    });
  const rows = keyed(roots, null);
  const total = roots.reduce((n, r) => n + keepOf(r), 0);
  // 不均衡倍数按大类、按留下来的算：拖滑块时跟着变
  const kept = roots.map(keepOf).filter((v) => v > 0).sort((a, b) => b - a);
  const ratio = kept.length > 1 ? kept[0] / kept[kept.length - 1] : null;
  const changed = roots.some((r) => keepOf(r) < r.sec - 0.5);

  // 自动：每个大类都不超过「大类时长中位数」的 N 倍。摆一遍，人再拖着调
  const autoBalance = () => {
    const v = roots.map((r) => r.sec).filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return;
    const med = v[Math.floor((v.length - 1) / 2)];
    const cap = med * factor;
    setTargets(Object.fromEntries(roots.filter((r) => r.sec > cap).map((r) => [r.label, Math.round(cap)])));
  };

  return (
    <div style={{ borderTop: "1px solid rgba(128,128,128,.3)", paddingTop: 8 }}>
      <Typography.Text strong>预览（没有导出）</Typography.Text>
      <Typography.Paragraph style={{ fontSize: 12, margin: "4px 0 8px", lineHeight: 1.8 }}>
        <b>{meta.n_tasks}</b> 个任务 · 留下 <b>{fmtSecs(total)}</b>
        {changed && <Typography.Text type="secondary">（原 {fmtSecs(roots.reduce((n, r) => n + r.sec, 0))}）</Typography.Text>}
        {ratio != null && (
          <>
            {" "}· 最多的类别是最少的 <b style={{ color: ratio > 20 ? "#ff4d4f" : undefined }}>{ratio.toFixed(0)}</b> 倍
            {ratio > 20 ? "（很不均衡：把多的往左拖，或训练时勾「类别均衡」）" : ""}
          </>
        )}
        <br />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {meta.n_untouched_skipped ? `跳过没人看过的 AI 片段 ${meta.n_untouched_skipped} 段；` : ""}
          {meta.n_unapproved_skipped ? `没在片段审核里通过的 ${meta.n_unapproved_skipped} 段没导出；` : ""}
          {meta.n_uncertain_excluded ? `待定挖掉 ${meta.n_uncertain_excluded} 段；` : ""}
          {meta.missing_excluded_min ? `掉数据挖掉 ${meta.missing_excluded_min} 分钟；` : ""}
          {meta.n_label_conflicts ? `类别冲突 ${meta.n_label_conflicts} 处（挖掉 ${meta.label_conflict_excluded_sec ?? 0} 秒，要回工作台改）；` : ""}
          {meta.flattened_sec ? `互斥轨折叠让出 ${fmtSecs(meta.flattened_sec)}；` : ""}
        </Typography.Text>
      </Typography.Paragraph>
      {tree && (
        <Space wrap size={8} style={{ marginBottom: 6 }}>
          <Tooltip title="拖「保留」那一列的滑块，决定每个大类导出多少。导出时按段随机抽到这个量：同一批数据每次抽到的是同一些段，摊在所有狗、所有天上；抽掉的段不导出，不会变成负样本。只能往少了拖——少的类别要补，训练时勾「类别均衡」">
            <span style={{ borderBottom: "1px dashed #bbb", fontSize: 12 }}>数据量调整</span>
          </Tooltip>
          {/* 说明文字放在框外：放进 addonBefore 的话把输入框挤得只剩几像素，数字根本看不见 */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>自动：每类不超过中位数的</Typography.Text>
          <InputNumber
            size="small"
            min={0.5}
            max={100}
            step={0.5}
            value={factor}
            onChange={(v) => setFactor(v ?? 3)}
            addonAfter="倍"
            style={{ width: 110 }}
          />
          <Button size="small" onClick={autoBalance}>自动摆一遍</Button>
          {changed && <Button size="small" type="link" onClick={() => setTargets({})}>全部恢复</Button>}
        </Space>
      )}
      <Table<Row>
        size="small"
        rowKey="key"
        pagination={false}
        scroll={{ y: 360 }}
        dataSource={rows}
        columns={[
          { title: tree ? "类别（点 + 看细类）" : "类别", dataIndex: "label", width: 190 },
          {
            title: "段数", width: 90, align: "right" as const,
            render: (_, r) => (r.ratio < 1 ? `≈${Math.round(r.n * r.ratio)} / ${r.n}` : r.n),
          },
          {
            title: "保留（拖动或填分钟）", width: 380,
            render: (_, r) => {
              if (!r.isRoot || !tree) {
                return (
                  <Typography.Text type={r.ratio < 1 ? "secondary" : undefined} style={{ fontSize: 12 }}>
                    {r.ratio < 1 ? `≈${fmtSecs(r.sec * r.ratio)} / ${fmtSecs(r.sec)}` : fmtSecs(r.sec)}
                  </Typography.Text>
                );
              }
              const keep = keepOf(r);
              const reduced = keep < r.sec - 0.5;
              // **对数刻度**：700 小时的类别要留几十分钟，线性滑块上那只是最左边 0.1% 的一个点，
              // 根本拖不细。对数下 1 分钟 / 10 分钟 / 1 小时 / 10 小时 间距一样
              const lo = Math.log(Math.min(60, r.sec));
              const hi = Math.log(Math.max(r.sec, 1));
              const toPos = (sec: number) => (hi > lo ? Math.round(((Math.log(Math.max(sec, 1)) - lo) / (hi - lo)) * 1000) : 1000);
              const fromPos = (v: number) => (v >= 1000 ? r.sec : Math.exp(lo + ((hi - lo) * v) / 1000));
              // 拖出来的数取个整：到分钟或到 10 分钟，不然是 37 分 13 秒这种
              const tidy = (sec: number) => (sec >= r.sec - 0.5 ? r.sec : sec >= 3600 ? Math.round(sec / 600) * 600 : Math.max(60, Math.round(sec / 60) * 60));
              const set = (sec: number) => setTargets({ ...targets, [r.label]: Math.min(r.sec, Math.max(0, sec)) });
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Slider
                    style={{ flex: 1, margin: "4px 0", minWidth: 90 }}
                    min={0}
                    max={1000}
                    value={toPos(keep)}
                    tooltip={{ formatter: (v) => fmtSecs(tidy(fromPos(v ?? 0))) }}
                    onChange={(v: number) => set(tidy(fromPos(v)))}
                  />
                  {/* 想要精确值就直接填分钟数 */}
                  <InputNumber
                    size="small"
                    min={0}
                    max={Math.ceil(r.sec / 60)}
                    precision={0}
                    value={Math.round(keep / 60)}
                    onChange={(v) => v != null && set(v * 60)}
                    addonAfter="分"
                    style={{ width: 110 }}
                  />
                  {/* 分钟数大了不好读（888 分），旁边换算成小时；百分比放悬停里 */}
                  <Tooltip title={reduced ? `留原来的 ${Math.max(0.1, Math.round((keep / r.sec) * 1000) / 10)}%` : "全部保留"}>
                    <Typography.Text type={reduced ? undefined : "secondary"} style={{ fontSize: 12, width: 84, textAlign: "right", whiteSpace: "nowrap" }}>
                      {reduced ? fmtSecs(keep) : "全留"}
                    </Typography.Text>
                  </Tooltip>
                </div>
              );
            },
          },
          {
            title: "占比（按时长）",
            render: (_, r) => {
              const p = total ? ((r.sec * r.ratio) / total) * 100 : 0;
              return (
                <Progress
                  percent={Math.round(p * 10) / 10}
                  size="small"
                  format={() => (p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`)}
                />
              );
            },
          },
        ]}
      />
      {meta.warnings?.length > 0 && (
        <details style={{ marginTop: 6, fontSize: 12 }}>
          <summary style={{ cursor: "pointer" }}>提示 {meta.warnings.length} 条</summary>
          {meta.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </details>
      )}
    </div>
  );
}
