import { useEffect, useMemo, useState } from "react";
import {
  Alert, AutoComplete, Button, Checkbox, DatePicker, Descriptions, Divider, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs,
  Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";
import { getSavedRange, saveRange } from "@/utils/persistedSize";
import { useAuthStore } from "@/stores/authStore";
import { claimTask, getTask } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import TrainLogModal from "@/components/TrainLogModal";
import { TRACKS, TRACK_NAME } from "@/utils/labelTree";
import ModelCompare from "@/components/ModelCompare";
import type { LabelDefinition, Task } from "@/types";
import {
  type DatasetCheck,
  checkDataset,
  datasetStats,
  type LabelStats,
  type DatasetSegment,
  getDatasetSegments,
  deleteDataset,
  activateModel, cancelModelVersion, deleteModelVersion, exportDataset, listDatasets, listModelVersions, submitTrain,
  trainRemap,
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

/** 提交训练时的那一套选项。按数据集记，另存一份"上一次"给没训过的数据集当起点 */
type TrainOpts = {
  modelType?: string;
  sourceHz?: number;
  hz?: number;
  axes?: number;
  skipSyn?: boolean;
  extraDs?: string[];
  extraHz?: Record<string, number>;
  remapEdits?: Record<string, string>;
};
const TRAIN_OPTS_KEY = "train-submit-opts";

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
    const { modelType, sourceHz, hz, axes, skipSyn } = opts;
    cur.last = { modelType, sourceHz, hz, axes, skipSyn };
    localStorage.setItem(TRAIN_OPTS_KEY, JSON.stringify(cur));
  } catch {
    // 存不了就算了，不影响这次提交
  }
}

/** 「不参与训练」那一项的值。存进表里是空字符串，但空字符串当不了 Select 的
 *  value（antd 当成"没选"），所以下拉里用这个哨兵 */
const DROP = "__drop__";

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
  const [axes, setAxes] = useState<number>(6);
  const [hz, setHz] = useState<number>(16);
  const [skipSyn, setSkipSyn] = useState(false);
  const [tag, setTag] = useState("");
  const [scope, setScope] = useState<"approved" | "reviewed">("approved");
  // 互斥轨的折叠：默认按 行为 > 运动 > 姿态 折成一个时刻一个标签（RF 单标签）；
  // 不折叠 = 各轨原样导，给分轨训练用。没分轨的项目两种一样
  const [flatten, setFlatten] = useState(true);
  const [trackPriority, setTrackPriority] = useState<string[]>(["behavior", "motion", "posture"]);
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
  const openTask = async (taskId: number, seekMs?: number | null) => {
    setWsOpening(taskId);
    try {
      const t = await getTask(taskId);
      setWsLabels(await listLabels(t.project_id));
      setWsSeekMs(seekMs ?? null);
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
        if (v.scope === "approved" || v.scope === "reviewed") setScope(v.scope);
        if (typeof v.includeSubmitted === "boolean") setIncludeSubmitted(v.includeSubmitted);
        if (typeof v.flatten === "boolean") setFlatten(v.flatten);
        if (Array.isArray(v.trackPriority) && v.trackPriority.length) setTrackPriority(v.trackPriority);
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
      });
      message.success(
        `已导出：${meta.n_tasks} 个任务 / ${meta.n_segments} 段 / ${meta.total_hours} 小时` +
          (meta.n_untouched_skipped ? `（跳过 ${meta.n_untouched_skipped} 条没人看过的 AI 片段）` : "")
      );
      try {
        localStorage.setItem(
          EXPORT_FORM_KEY,
          JSON.stringify({ name: name.trim(), projectIds, scope, includeSubmitted, flatten, trackPriority })
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
    const out: { name: string; n: number; sec: number }[] = [];
    for (const r of trainStats?.rows ?? []) {
      const kids = r.sub_labels ?? [];
      if (!kids.length) {
        out.push({ name: r.label, n: r.n_segments, sec: r.seconds });
        continue;
      }
      for (const k of kids) {
        // 「X（未细分）」是只标到大类那部分，映射时按大类名算
        out.push({ name: k.is_root_only ? r.label : k.label, n: k.n_segments, sec: k.seconds });
      }
    }
    return out.sort((a, b) => b.sec - a.sec);
  }, [trainStats]);

  /** 这一类最后算作哪个训练类别。**就是这张表说了算**——算法侧会按它生成
   *  这一次训练专用的重映射表，所以界面上看到什么，训出来就是什么。
   *  空 = 不参与训练（那些样本会被丢掉）。 */
  const finalOf = (name: string): string | null => remapEdits[name] || null;

  /** 这次训练最终会有哪几个类别。少于两个就没法训——分类器要有东西可比 */
  const trainTargets = useMemo(
    () => [...new Set(trainCats.map((c) => remapEdits[c.name]).filter(Boolean))] as string[],
    [trainCats, remapEdits]
  );

  // 类别查出来之后按默认那张 3 类表预填：绝大多数类别本来就该照默认走
  // （行走/奔跑 → 活动），人只需要改自己在意的那两三行。**没有默认的就留空**，
  // 那正是「会被丢掉」，留空才看得见。
  useEffect(() => {
    if (!trainFor || !trainCats.length) return;
    setRemapEdits((prev) => {
      const next = { ...prev };
      let touched = false;
      for (const c of trainCats) {
        if (c.name in next) continue;             // 人改过的不动
        const table = remap?.table ?? {};
        // 细类（抓挠-躯干）默认跟着它的大类走：训练本来就取链的第 0 个
        const root = c.name.includes("-") ? c.name.split("-")[0] : c.name;
        const d = table[c.name] ?? table[root] ?? "";
        if (d) { next[c.name] = d; touched = true; }
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
      if (typeof base.skipSyn === "boolean") setSkipSyn(base.skipSyn);
    }
    // 一起训练的那几份：删掉了的数据集别再选着——选择框里会出现一个认不出的名字
    const alive = new Set((datasets ?? []).map((x) => x.name));
    setExtraDs(mine ? (mine.extraDs ?? []).filter((n) => alive.has(n) && n !== d.name) : []);
    setExtraHz(mine?.extraHz ?? {});
    // 归并表：恢复上次的；这次多出来的类别，下面那个 effect 按默认表补上
    setRemapEdits(mine?.remapEdits ?? {});
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
          skip_syn: skipSyn,
          clean: true,
        },
        model_type: modelType,
        tag: tag.trim() || null,
      });
      saveTrainOpts(trainFor.name, {
        modelType, sourceHz, hz, axes, skipSyn, extraDs, extraHz,
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
                scroll={{ x: "max-content" }}
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
                      return (
                        <Space size={4} wrap>
                          <span>{(sp.date as string) ?? "-"}</span>
                          {extra > 0 && <Tag>+{extra} 份</Tag>}
                          {/* 轴数：3 轴和 6 轴的模型不能拿来直接比，一眼得看出来 */}
                          <Tag color={Number(sp.axes) === 3 ? "purple" : undefined}>
                            {Number(sp.axes) === 3 ? "3 轴" : "6 轴"}
                          </Tag>
                          <Tag>{v.model_type}</Tag>
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
                  { title: "标签", dataIndex: "model_version", width: 110, render: (t: string | null) => t || "-" },
                  {
                    title: "提交时间",
                    dataIndex: "created_at",
                    width: 150,
                    render: (t: string) => t?.replace("T", " ").slice(0, 16),
                  },
                  {
                    title: "操作",
                    fixed: "right",
                    render: (_, v: ModelVersion) => {
                      const busy = v.status === "queued" || v.status === "running";
                      return (
                        <Space size={0}>
                          <Button size="small" type="link" onClick={() => setLogFor(v.id)}>
                            {busy ? "看进度" : "日志"}
                          </Button>
                          <Button size="small" type="link" onClick={() => setDetail(v)}>
                            详情
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
                                启用
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
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            把这段日期里的标注导成训练数据。人工纠正过的 AI 片段、人工新增的、从「疑似抓挠」里确认或
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
              <Radio value="approved">
                <Tooltip title="整份取：这个任务里的片段全要，包括没人看过的纯 AI 片段。任务审核通过意味着「这一份整体认可」，所以不再逐条看确认状态。只审了一部分就提交的任务别用这一档——那几十条没确认的 AI 片段会跟着进训练集，等于拿模型自己的输出喂它自己">
                  <span style={{ borderBottom: "1px dashed #bbb" }}>
                    只用审核通过的任务（整份都算数，<b>含没人确认过的 AI 片段</b>）
                  </span>
                </Tooltip>
              </Radio>
              <Radio value="reviewed">
                <Tooltip title="不看任务状态，只挑出人确认过 / 改过 / 人工加的片段（包括从「疑似抓挠」确认上来的）。没人看过的纯 AI 片段不导出——它只是模型自己的输出，拿去训练就是自我强化。那段时间也不会被当成负样本：导出格式只提取被标注的区间，没标注的时间根本不进数据集">
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
        </Space>
      </Modal>

      {/* 改完关掉就回到详情弹窗接着核对下一条；导出文件不会自动跟着变，
          得重新导一次——按钮上的说明写了 */}
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        initialSeekMs={wsSeekMs}
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
                  <Tooltip title="三种算数：点过「通过」的、改过的（换了标签或拖过起止）、人自己画的（含从「疑似抓挠」确认上来的）。只是打开看过、没点的不算——那些就是下面「跳过没人看过的 AI 片段」的数量">
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
            <Space>
              <Tooltip title="项圈上有陀螺仪就用 6 轴，只有加速度计就用 3 轴。选错的后果是单向的：端侧只有加速度计、却用 6 轴训，指标再好也代表不了端上的表现——那是拿一块板子上根本没有的信号在学。反过来（端上有陀螺仪却只用 3 轴训）只是浪费了一半信号，不会不准">
                <Typography.Text style={{ borderBottom: "1px dashed #666" }}>传感器轴数</Typography.Text>
              </Tooltip>
              <Radio.Group
                size="small"
                value={axes}
                onChange={(e) => setAxes(e.target.value)}
                options={[
                  { value: 6, label: "6 轴（加速度+陀螺仪）" },
                  { value: 3, label: "3 轴（只用加速度）" },
                ]}
                optionType="button"
              />
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
                <Typography.Text>类别归并（可不改）</Typography.Text>
                <Table
                  rowKey="name"
                  size="small"
                  pagination={false}
                  scroll={{ y: 220 }}
                  dataSource={trainCats}
                  columns={[
                    {
                      title: "这次数据里的类别", dataIndex: "name", width: 160,
                      render: (v: string) => <Tag color={labelColor(v.split("-")[0])}>{v}</Tag>,
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
                            {c.n} 段 / {Math.round(c.sec)} 秒
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
                      render: (_, c) => (
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
                          options={[
                            // 自成一类排第一：**这就是「识别出是什么抓挠」的做法**，
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
                          ]}
                        />
                      ),
                    },
                    {
                      title: "", width: 110,
                      render: (_, c) => {
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
        )}
      </Modal>

      <TrainLogModal
        versionId={logFor}
        onClose={() => setLogFor(null)}
        onFinished={() => qc.invalidateQueries({ queryKey: ["model-versions"] })}
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
                          k.seconds >= 3600
                            ? `${(k.seconds / 3600).toFixed(2)} 小时`
                            : `${Math.round(k.seconds)} 秒`,
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
                              <Tooltip key={n} title={`${n}：${Math.round(sec)} 秒`}>
                                <Tag>{n.replace(/^ds_/, "")} {(sec / 60).toFixed(1)}分</Tag>
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
                    r.hours >= 1 ? `${r.hours} 小时` : `${Math.round(r.seconds)} 秒`,
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
                        <Tooltip key={n} title={`${n}：${Math.round(sec)} 秒`}>
                          <Tag>{n.replace(/^ds_/, "")} {(sec / 60).toFixed(1)}分</Tag>
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
