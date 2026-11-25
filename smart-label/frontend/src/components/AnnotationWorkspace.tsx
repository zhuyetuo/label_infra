import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import InferModeHelp from "@/components/InferModeHelp";
import {
  Alert,
  Button,
  ConfigProvider,
  Dropdown,
  Empty,
  Modal,
  Popconfirm,
  Popover,
  Collapse,
  Segmented,
  Space,
  Spin,
  Tag,
  Radio,
  Tooltip,
  Typography,
  message, Select, Input, InputNumber, Checkbox, Table, theme as antdTheme
} from "antd";
import { ArrowDownOutlined, DeleteOutlined, DownOutlined, ArrowUpOutlined, EditOutlined, EyeInvisibleOutlined, LinkOutlined, LockOutlined, PlusOutlined, QuestionCircleOutlined, ThunderboltOutlined, UnlockOutlined } from "@ant-design/icons";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { aiPrelabel, getAiLabelInfo, getSampleMedia, scratchCrosscheck, type AiLabelInfo, type ScratchCross } from "@/api/samples";
import { getImuMeta } from "@/api/imu";
import LowlightModal from "@/components/LowlightModal";
import CamFixModal from "@/components/CamFixModal";
import DogPicker from "@/components/DogPicker";
import DogAvatar from "@/components/DogAvatar";
import { NIGHT_VISION } from "@/config/features";
import SegmentPanel, { formatMs, REVIEW_NOTE_PRESETS } from "@/components/SegmentPanel";
import CandidatePanel, { candFocus } from "@/components/CandidatePanel";
import SimilarFramePreview from "@/components/SimilarFramePreview";
import SimilarHitsGrid from "@/components/SimilarHitsGrid";
import SimilarClipPlayer, { type Clip } from "@/components/SimilarClipPlayer";
import type { SimilarThumbView } from "@/api/candidates";
import { ACTION_QUERIES, queryFor } from "@/utils/actionQueries";
import { clearSimilarCandidates, findSimilarCandidates, repairCandidateItems, decideCandidate, listCandidates, setCandidateReviewNote, setCandidateSpan, type AiCandidate, type SimilarHit } from "@/api/candidates";
import LabelTreeSelect from "@/components/LabelTreeSelect";
import { recentLabels, rememberLabel } from "@/utils/recentLabels";
import { DRAFT_STALE_EVENT, getDraft, heartbeat, reopenTask, saveDraft, setReviewNote, submitTask } from "@/api/tasks";
import ImuChart, { ImuChartHint, ImuScrubber, type ChartSegment } from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import { hintOf, modeLabelOf, type InferMode } from "@/utils/inferMode";
import { INFER_SELECT_PROPS, useInferModes } from "@/hooks/useInferModes";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { getSavedBool, getSavedHeight, getSavedKeys, saveBool, saveHeight, saveKeys } from "@/utils/persistedSize";
import { TRACKS, TRACK_NAME, chainOf, conflicts as labelsConflict, currentName, childrenMap, descendantIds, flatten as flattenLabels, related as labelsRelated, shortName, trackOf } from "@/utils/labelTree";
import {
  PANEL_TITLES,
  loadHidden,
  loadOrder,
  moveAmongShown,
  saveHidden,
  saveOrder,
  type PanelKey,
} from "@/utils/panelLayout";
import "./AnnotationWorkspace.css";
import type { LabelDefinition, LabelItem, Task } from "@/types";
import { candTitle } from "@/utils/candReason";
import LoopWaveform, { type AdjustTarget, type LoopInfo } from "@/components/LoopWaveform";
import { segCreate, segDecide, segDedupe, segDelete, segEdit, segMarks, segSendBackReviewer, segSplit } from "@/api/segReview";

interface Props {
  task: Task | null;
  /** 打开时片段列表默认只筛这个标签（皮肤跟踪表跳过来复看「抓挠」用） */
  focusLabelName?: string | null;
  /**
   * 同上，但直接给标签 id——列表页已经按类别筛过一轮了（比如项目页筛了「抓挠」，
   * 只剩那几个任务），点「查看标注」进来就该已经是抓挠，而不是让人在片段面板里
   * 把同一个筛选再点一遍。
   *
   * 跟 focusLabelName 分开两个字段，不是重复：focusIds 还兼着候选面板的
   * scratchLabelIds（「改成别的」要把抓挠排掉）。列表页筛的可能是「睡觉」，
   * 混进去会让候选面板把睡觉当成抓挠。这个字段只影响片段列表的初始筛选。
   */
  focusLabelIds?: number[];
  /** 「疑似片段」面板打开时先只看这几类候选（候选按名字存，所以是名字不是 id） */
  focusCandLabels?: string[];
  /** 从列表里点某个类别标签进来的：不恢复上次的位置，直接跳到这一类的第一段循环，
   *  对应面板（片段列表 / 疑似片段）隐藏了就显示、收起了就展开 */
  jumpToFocus?: boolean;
  /** 打开就循环这一段（片段 id）：数据池里点「看」、链接里的 ?seg= 都走它。波形浮窗跟着弹出，能直接改 */
  initialSegId?: number | null;
  labels: LabelDefinition[];
  /** 只读模式：审核/已提交的任务只能看不能改 */
  readOnly?: boolean;
  onClose: () => void;
  /** 存过草稿之后通知外面刷新列表（段数、类别汇总都会变） */
  onSaved?: () => void;
  onSubmitted?: () => void;
  /**
   * 同一个 IMU（同一只狗）前一个 / 后一个时间段的任务：连着往前往后翻，人眼找喝水这类画面用。
   * label 是按钮上写的时间（比如「18:00」，跨天带日期），不给就不显示那一边
   */
  nav?: { prev?: { label: string; onClick: () => void }; next?: { label: string; onClick: () => void } };
  /** 审核员看完可以直接在这里下结论，省得关掉再回列表点 */
  onApprove?: () => void | Promise<void>;
  onReject?: () => void;
  /** 「通过」按钮上写什么（皮肤复看那边叫「确认无误」，语义更贴那个场景） */
  approveText?: string;
  /** 「通过」二次确认弹窗提示（不填用默认文案） */
  approveConfirmTitle?: string;
  /** 打开就跳到这个时刻（相对 CSV 起点的毫秒）。从别处点「去修」进来时用 */
  initialSeekMs?: number | null;
  /** 只看 / 只标样本里的这一段（模型测试挂在原任务上的窗口）；短任务自己的窗口优先 */
  focusWindow?: {
    startMs: number;
    endMs: number;
    /** 打开时优先循环该事件子区间（如 5 分钟测试窗口中具体几秒的抓挠 / 误报段） */
    loopRange?: { startMs: number; endMs: number };
    /** 从模型打分错例跳来：展示评测模型预测时段与人工标注时段的一键定位 */
    evalHint?: EvalWindowHint;
  } | null;
  /** 隐藏「提交」整任务按钮（测试集只核对单个窗口时不需要提交整条 1 小时任务，避免误操作） */
  hideSubmit?: boolean;
  /** 从找相似 / 补标模式进来：候选面板默认只看「画面相似」或「补标」 */
  initialCandFilter?: "similar" | "all" | "fill" | null;
  /** 开进来就打开「找相似」，样例取 initialSeekMs 那一刻（第一阶段跳过来的） */
  initialSimilar?: boolean;
  /** 跳过来时「标成」预选哪个类别：第一阶段已经判断过是什么动作了，不该再让人选一遍 */
  initialSimilarLabel?: string | null;
  /** 只读状态下想动手改：认领这个任务，转成可编辑。给了才显示这个按钮 */
  onClaim?: () => void | Promise<void>;
  /** 已通过的任务想再改：退回重标（轮次+1，上一轮内容原样带过去） */
  onReopen?: () => void | Promise<void>;
  /** 已提交 / 已通过的任务自己再改（轮次不变，回到标注中）。给了才显示「继续编辑」 */
  onEditAgain?: () => void | Promise<void>;
  /** 只认某一类（皮肤复看那边是「抓挠」）标得对，不动别的类别和任务状态 */
  onConfirmScratch?: () => void | Promise<void>;
  /** 上面那个按钮写什么 */
  confirmScratchText?: string;
  /** 片段审核：打开就循环这一条，波形浮窗里给「通过 / 退回 / 下一条」（或标注员的「改好了」），
   *  起止在浮窗里直接改（走 /segments 接口，不用认领整个任务） */
  segReview?: SegReviewCtx;
}

export interface EvalWindowHint {
  label: string;
  version: string;
  verdict: "tp" | "tn" | "fp" | "fn";
  iouMin?: number;
  truthSegs: [number, number][];
  predSegs: [number, number, number | null][];
}

export interface SegReviewCtx {
  itemId: number;
  /** 改这一条的起止（片段审核接口） */
  onEdit: (startMs: number, endMs: number) => Promise<void>;
  /** 浮窗底下那一栏：通过 / 退回 / 下一条 这些按钮，由片段审核页给 */
  actions: React.ReactNode;
  /** 外面改了这一条（比如改了类别）就加一：工作台重新拉一遍草稿 */
  reloadKey?: number;
  /** 这一条在工作台里被拆开 / 改了（都回到待审）：审核页同步这一条的起止类别、刷新列表和红色数字 */
  onChanged?: (main: { start_time_ms: number; end_time_ms: number; label_id: number }) => void;
}

interface VideoSrc {
  label: string;
  url: string;
  /** 这一路的第 0 秒在样本时间轴上是第几秒（见 SyncedVideoGroup） */
  offsetSec?: number;
}

const FALLBACK_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2"];
const HEARTBEAT_MS = 30_000;
// 片段循环播放时前后各多放这么多毫秒，让人看得到"起止前后是什么动作"
// 快捷键按层级分行：第一行大类用数字键，第二行（选中大类的子类）用 q 那一排，
// 第三行用 a 那一排，第四行 z 那一排。键盘上的一行对应屏幕上的一行，不用记
const ROW_KEYS = ["1234567890", "qwertyuiop", "asdfghjkl;", "zxcvbnm,./"].map((r) => r.split(""));
// 波形区（单条波形模式）默认露出的高度：六条通道全都渲染在里面，这个盒子只
// 卡住"一条通道 + 顶部说明 + 底部日期行"的高度，刚好够，多出来的部分往下滚
// 才看得到，不占视频的地盘。
const CHART_VIEWPORT_PX = 185;
// 展开全部默认高一些：那个模式本来就是为了一眼扫六条
const CHART_EXPANDED_PX = 520;
// 两个模式各记各的高度：单条波形只看一条，拖到刚好一条的高度；展开全部要看六条，
// 拖得高得多。共用一个值的话，来回切模式就得来回拖
// 双波形：上面原始（人工标注）、下面 AI 辅助，各只画一条通道
const CHART_DUAL_PX = 320;
const CHART_DUAL_KEY = "smart-label:chart-dual";
const CHART_DUAL_HEIGHT_KEY = "smart-label:chart-area-height-dual";
const CHART_MODE_KEY = "smart-label:chart-expanded";
const CHART_HEIGHT_KEY = "smart-label:chart-area-height";
const CHART_EXPANDED_HEIGHT_KEY = "smart-label:chart-area-height-expanded";
const CHART_SCROLL_LOCK_KEY = "smart-label:chart-scroll-locked";
// IMU 波形整块的展开/折叠，和下面两个面板的展开状态：都记成用户的习惯
const IMU_OPEN_KEY = "smart-label:imu-open";
const PANELS_KEY = "smart-label:ws-panels";

// 标注工作台：视频 + IMU 波形 + 打标签。选个标签直接在波形上拖出一段即可，
// 时间点不用手填毫秒，所见即所得。
/** 「疑似片段」标题上按类别报待判条数：抓挠 3 · 进食 1 · 吠叫 2（只列还有没判的类别） */
function candKindSummary(cands: AiCandidate[]) {
  const n = new Map<string, number>();
  for (const c of cands) if (c.status === "pending") n.set(currentName(c.label_name), (n.get(currentName(c.label_name)) ?? 0) + 1);
  if (n.size === 0) return null;
  return (
    <span style={{ color: "#888", fontSize: 12 }}>
      {[...n.entries()].map(([k, v]) => `${candTitle(k)} ${v}`).join(" · ")}
    </span>
  );
}

export default function AnnotationWorkspace({
  task,
  focusLabelName,
  focusLabelIds,
  focusCandLabels,
  jumpToFocus,
  initialSegId,
  labels,
  readOnly,
  onClose,
  onSaved,
  onSubmitted,
  nav,
  onApprove,
  onReject,
  approveText,
  approveConfirmTitle,
  hideSubmit,
  onClaim,
  initialSeekMs,
  focusWindow,
  initialCandFilter,
  initialSimilar,
  initialSimilarLabel,
  onReopen,
  onEditAgain,
  onConfirmScratch,
  confirmScratchText,
  segReview,
}: Props) {
  // 主题色（明亮 / 暗黑跟着变）。叫 tk 是因为这个文件里 token 已经是媒体 token 的变量名
  const { token: tk } = antdTheme.useToken();
  const taskId = task?.id ?? null;
  const sampleId = task?.sample_id ?? null;
  // 夜视增强：看哪一段、哪一路。夜里那几路黑得看不出狗在干嘛时用。
  // 存的是整段起止不是中点——抓挠是动作，得能把这一段循环播放着看
  const [lowlightAt, setLowlightAt] = useState<[number, number] | null>(null);
  // 这个样本实际有哪几路，给夜视弹窗切机位用
  const [camList, setCamList] = useState<{ value: string; label: string }[]>([]);
  const role = useAuthStore((s) => s.userInfo?.role);
  // 标题上换了狗：先本地显示新名字（任务对象是外面传进来的，等它刷新太慢）；换任务时清掉
  const [dogLabelOverride, setDogLabelOverride] = useState<string | null | undefined>(undefined);
  // 换狗后档案头像跟着换（dog_id 一起返回了）
  const [dogIdOverride, setDogIdOverride] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    setDogLabelOverride(undefined);
    setDogIdOverride(undefined);
  }, [task?.id]);

  const [loading, setLoading] = useState(false);
  // 打开的任务里有审核标过「有问题」的片段、而且是来改的（不是只读看）：片段列表先只看那几条
  const [flagFocus, setFlagFocus] = useState(false);
  const [candFlagFocus, setCandFlagFocus] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  // 没视频时用来解释是缺哪一步：样本上就没登记，还是登记了但媒体库里找不到
  const [videoWhy, setVideoWhy] = useState<string | null>(null);
  // 路数比该场地应有的少时的那一句（后端算的）。跟 videoWhy 分开：那个只管
  // "一路都没有"，这个管"有，但少了几路"——两种情况的补救办法不一样
  const [videoNote, setVideoNote] = useState<string | null>(null);
  // 这个样本在哪个场地：影棚全是公共区，不需要（也没有）「哪一路拍哪一间」
  const [mediaSite, setMediaSite] = useState<string | null>(null);
  // 播放速度/帧号控件 portal 的目标节点：挂在弹窗标题里的一个空 span 上
  const [controlsHost, setControlsHost] = useState<HTMLSpanElement | null>(null);
  // 「疑似片段」那排筛选/翻页 portal 到它的折叠标题行上，省两行高度
  const [candControlsHost, setCandControlsHost] = useState<HTMLSpanElement | null>(null);
  // 「已标注片段」那排筛选同理
  const [segControlsHost, setSegControlsHost] = useState<HTMLSpanElement | null>(null);
  const [hasCsv, setHasCsv] = useState(false);
  const [prelabeling, setPrelabeling] = useState(false);
  // 稳定版（平滑合并）/ 调试版（逐窗口原始输出），默认稳定版
  // 版本下拉的选项（线上 + 端侧），问服务拿，不写死
  const { options: inferOptions } = useInferModes();
  const [prelabelMode, setPrelabelMode] = useState<InferMode>("stable");
  // IMU 总时长，片段列表算"预测覆盖了多少、哪里是空白"要用
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");
  // 默认只露一条波形把高度让给视频；想通盘看六轴时切到"展开全部"，
  // 波形区改为占满剩余高度，视频相应缩小
  // 用哪个模式也记住：不然每开一个任务都要重新点一次「展开全部」
  const [chartExpanded, setChartExpanded] = useState(() => getSavedBool(CHART_MODE_KEY, false));
  // 双波形（原始 / AI 辅助上下两张）：同样是用户习惯，记住
  const [chartDual, setChartDual] = useState(() => getSavedBool(CHART_DUAL_KEY, false));
  // 展开时要"一屏看全六轴"，所以行高不能写死，得按波形区实际拿到多少高度算
  const chartBoxRef = useRef<HTMLDivElement | null>(null);
  const [chartBoxH, setChartBoxH] = useState(0);
  // 单条波形模式下这块区域的高度，可以拖底边把手调整；跟视频区一样记到
  // localStorage，下次打开别的任务不用重新拖
  const [singleHeight, setSingleHeight] = useState(() => getSavedHeight(CHART_HEIGHT_KEY) ?? CHART_VIEWPORT_PX);
  const [expandedHeight, setExpandedHeight] = useState(
    () => getSavedHeight(CHART_EXPANDED_HEIGHT_KEY) ?? CHART_EXPANDED_PX
  );
  const [dualHeight, setDualHeight] = useState(() => getSavedHeight(CHART_DUAL_HEIGHT_KEY) ?? CHART_DUAL_PX);
  // 单条波形模式下滚轮很容易不小心把波形区滚到别的通道去，锁住之后波形区不响应
  // 滚动，想看别的通道再解锁。是否锁定记住成用户的习惯，下次打开别的任务沿用。
  const [chartScrollLocked, setChartScrollLocked] = useState(() => getSavedBool(CHART_SCROLL_LOCK_KEY, false));
  // 当前模式用哪一份高度。切模式 = 换一份记忆，互不影响
  const chartHeight = chartExpanded ? expandedHeight : chartDual ? dualHeight : singleHeight;
  const setChartHeight = chartExpanded ? setExpandedHeight : chartDual ? setDualHeight : setSingleHeight;
  const chartHeightKey = chartExpanded
    ? CHART_EXPANDED_HEIGHT_KEY
    : chartDual
      ? CHART_DUAL_HEIGHT_KEY
      : CHART_HEIGHT_KEY;
  const chartHeightDefault = chartExpanded ? CHART_EXPANDED_PX : chartDual ? CHART_DUAL_PX : CHART_VIEWPORT_PX;
  // 复看抓挠时波形其实用得不多（主要看视频），可以整块折起来把地方让给视频；
  // 想看再展开。跟下面两个面板一样，记住各人自己的习惯
  const [imuOpen, setImuOpen] = useState(() => getSavedBool(IMU_OPEN_KEY, true));
  const [panelKeys, setPanelKeys] = useState<string[]>(() => getSavedKeys(PANELS_KEY, ["segs"]));
  // 四个面板的先后顺序和哪些被藏起来了：也是用户习惯，记住
  const [panelOrder, setPanelOrder] = useState<PanelKey[]>(loadOrder);
  const [panelHidden, setPanelHidden] = useState<PanelKey[]>(loadHidden);

  const [items, setItems] = useState<LabelItem[]>([]);
  // 从服务端拉回来的那份片段。人工改动后 items 会换成新数组，自动保存据此判断
  // "这是人工改的"还是"刚从服务器同步回来的"，避免每次拉草稿都原样再存一遍
  const serverItemsRef = useRef<LabelItem[]>(items);
  const loadItems = (next: LabelItem[]) => {
    serverItemsRef.current = next;
    setItems(next);
  };
  // 疑似片段候选：不在草稿里，单独一张表，人工逐条确认/排除
  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  // 这次只标的那一段：短任务自己的窗口，或者外面传进来的（模型测试挂在原任务上的窗口）
  const win = task?.segment_start_ms != null && task?.segment_end_ms != null
    ? { s: task.segment_start_ms, e: task.segment_end_ms }
    : focusWindow ? { s: focusWindow.startMs, e: focusWindow.endMs } : null;
  // 有窗口时只显示窗口里的片段 / 疑似片段（只是不显示，保存按 id，窗口外的原样留着）
  const inWin = (a: number, b: number) => !win || (a < win.e && b > win.s);
  // 现在这份 AI 结果是哪个版本/哪个模型跑的
  const [aiInfo, setAiInfo] = useState<AiLabelInfo | null>(null);
  // 重跑之后，跟人工已定片段撞上的那些新片段：标出来方便逐条对比
  const [dupIds, setDupIds] = useState<Set<number>>(new Set());
  // 人工碰过、重跑时必须留下的片段数（确认过/改过/待定/自己画的）
  const humanTouched = items.filter(
    (i) => i.source_type !== "ai_generated" || i.ai_confirmed || i.is_modified || i.uncertain
  ).length;
  const [labelId, setLabelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 抓挠 ↔ 画面对照：IMU 说在抓挠的时候，画面里有狗吗。
  // 不需要任何模型——把已标的片段（毫秒）和画面扫描的时间线（秒）叠起来。
  // 没扫过画面时接口会把 note 说清楚，不会假装"一段可疑的都没有"。
  const { data: cross } = useQuery({
    queryKey: ["scratch-cross", sampleId],
    queryFn: () => scratchCrosscheck(sampleId!),
    enabled: sampleId != null,
    retry: false,
  });

  const bus = useMemo(() => new TimeBus(), [taskId]);
  // 片段区间循环：真正的循环逻辑在 bus/视频组件里跑，这里只留一份给按钮高亮/顶部提示用
  const [loopRange, setLoopRange] = useState<{ startMs: number; endMs: number } | null>(null);
  // 机位纠正：就地循环看这一段该是哪一路画面（改的是整场录制）
  const [camFixOpen, setCamFixOpen] = useState(false);
  const [camFixRange, setCamFixRange] = useState<[number, number]>([0, 4000]);
  // 「找相似」：视频当前在第几秒（高频更新，放 ref 不放 state）
  const curSecRef = useRef(0);
  useEffect(() => bus.onTime((sec) => { curSecRef.current = sec; }), [bus]);

  // 刷新页面回来：停在刚才播到的那一刻、接着循环刚才那一段（波形小窗也就跟着回来）。
  // 每个任务一份，存在 localStorage；在任何 effect 之前读出来，免得开头的 0 秒先把它盖掉
  const posKey = taskId != null ? `ws-pos:${taskId}` : null;
  type MsRange = { startMs: number; endMs: number };
  const savedPos = useMemo<{ sec: number; loop: MsRange | null; view?: MsRange | null } | null>(() => {
    if (!posKey) return null;
    try {
      const v = JSON.parse(localStorage.getItem(posKey) || "null");
      return v && typeof v.sec === "number" ? v : null;
    } catch {
      return null;
    }
  }, [posKey]);
  const posReady = useRef(false);
  const viewRangeRef = useRef<MsRange | null>(null);
  const writePos = () => {
    if (!posKey || !posReady.current) return;
    try {
      const l = bus.getLoop();
      const loop = l ? { startMs: Math.round(l.start * 1000), endMs: Math.round(l.end * 1000) } : null;
      // view：停了循环、浮窗还留着（「停止循环后保留」）时浮窗里那段，也要记
      localStorage.setItem(posKey, JSON.stringify({ sec: curSecRef.current, loop, view: viewRangeRef.current, at: Date.now() }));
    } catch {
      /* 存不了就算了 */
    }
  };
  useEffect(() => {
    posReady.current = false;
    let last = 0;
    const offTime = bus.onTime(() => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      writePos();
    });
    const offLoop = bus.onLoopChange(() => writePos());
    return () => {
      offTime();
      offLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, posKey]);
  const [similarOpen, setSimilarOpen] = useState(false);
  const [similarLabel, setSimilarLabel] = useState<string | null>(null);
  const [similarText, setSimilarText] = useState("");
  const [similarUseText, setSimilarUseText] = useState(false);
  const [similarScope, setSimilarScope] = useState<"project" | "task" | "all">("project");
  const [similarTopK, setSimilarTopK] = useState(60);
  const [similarGap, setSimilarGap] = useState(15);
  const [similarAtSec, setSimilarAtSec] = useState(0);
  const [similarRunning, setSimilarRunning] = useState(false);
  // 找完之后的结果：落到了哪些任务、几点几分——不然人不知道去哪看
  const [similarResult, setSimilarResult] = useState<Awaited<ReturnType<typeof findSimilarCandidates>> | null>(null);
  // 去共同背景：同狗同房同地板把余弦顶到 0.95+，动作差别被淹没；减掉均值再比。默认开
  const [similarCenter, setSimilarCenter] = useState(true);
  // 姿态相似占多少：0 只看画面，1 只看姿态（鼻子够到了哪只爪）。没姿态模型时服务端自动只看画面
  const [similarPoseW, setSimilarPoseW] = useState(0.5);
  // 只要「鼻子够到了这个部位」的帧。几何硬条件，跟相似度是两回事，所以单独一个控件
  const [similarPart, setSimilarPart] = useState("");
  // 「先看命中」：只搜不写，把命中的画面摆出来看
  const [similarPeek, setSimilarPeek] = useState<{ hits: SimilarHit[]; refPath: string | null; refT: number | null; centered: boolean; poseUsed: boolean } | null>(null);
  const [similarPeeking, setSimilarPeeking] = useState(false);
  // 样例大图和命中缩略图看哪种（抠图 / 原图 / 姿态 / 整帧）：一个开关，上下一起切
  const [similarView, setSimilarView] = useState<SimilarThumbView>("mask");
  // 预览里正在循环播的那一段（左栏播放器）
  const [similarClip, setSimilarClip] = useState<Clip | null>(null);
  // 「先看命中」里人勾中的那几帧（`路径@秒` → 标成哪个类别）：只有勾中的写候选。
  // 带上类别是因为一次检索常常混着别的动作（舔着舔着开始甩身体）——当场分开标，
  // 比写完一堆错类别再回列表里一条条改省事得多
  const [similarPicked, setSimilarPicked] = useState<Map<string, string>>(new Map());
  // 点命中：本任务的直接把主画面跳过去循环；别的任务开新页（cand=similar：那边候选置顶高亮、视频停在这一刻循环）
  const openSimilarHit = (h: SimilarHit) => {
    if (h.task_id === taskId) {
      const ms = Math.round(h.t * 1000);
      setLoop({ startMs: Math.max(0, ms - 2000), endMs: ms + 4000 });
      bus.seek(Math.max(0, h.t - 2));
    } else if (h.task_id != null) {
      window.open(`/tasks?task=${h.task_id}&seek=${Math.round(h.t * 1000)}&cand=similar`, "_blank");
    }
  };
  const peekSimilar = async () => {
    if (taskId == null) return;
    setSimilarPeeking(true);
    try {
      const r = await findSimilarCandidates({
        task_id: taskId,
        label_name: similarLabel || "预览",
        t_s: similarUseText ? undefined : similarAtSec,
        text: similarUseText ? similarText.trim() : undefined,
        scope: similarScope,
        top_k: similarTopK,
        gap_s: similarGap,
        center: similarCenter,
        pose_w: similarPoseW,
        part: similarPart || undefined,
        dry_run: true,
      });
      setSimilarPeek({ hits: r.hit_list, refPath: r.ref_path, refT: similarUseText ? null : similarAtSec, centered: r.centered, poseUsed: r.pose_used });
      // **默认一张都不选**。一开始默认全选，是想着"检索大部分时候是对的"——实测
      // 不是：0.55 以下那一截基本全不对，全选等于让人去挑错的那些，挑漏一张就多
      // 写一条脏候选。默认不选则挑漏只是少写一条，回头再搜一次就是。
      // 两种错都会犯，就选后果小的那种。
      setSimilarPicked(new Map());
      if (r.missing) message.info(`${r.missing} 路视频还没建索引，搜不到`);
    } finally {
      setSimilarPeeking(false);
    }
  };
  const runSimilar = async () => {
    if (taskId == null || !similarLabel) return;
    setSimilarRunning(true);
    try {
      const r = await findSimilarCandidates({
        task_id: taskId,
        label_name: similarLabel,
        t_s: similarUseText ? undefined : similarAtSec,
        text: similarUseText ? similarText.trim() : undefined,
        scope: similarScope,
        top_k: similarTopK,
        gap_s: similarGap,
        create_label: true,
        center: similarCenter,
        pose_w: similarPoseW,
        part: similarPart || undefined,
        // 「先看命中」里勾中的那几帧，连同各自标成什么。没先看过命中（没预览直接找）
        // 时是空的，那就照老样子整批按一个类别写
        pick: [...similarPicked].map(([k, lab]) => {
          const i = k.lastIndexOf("@");
          return [k.slice(0, i), Number(k.slice(i + 1)), lab] as [string, number, string];
        }),
      });
      if (r.created_label) message.info(`项目里没有「${similarLabel}」，已经新建了这个标签`);
      if (r.multi_dog_candidates > 0) {
        message.warning(`其中 ${r.multi_dog_candidates} 条落在多狗同场的任务上（影棚 / 公共区），画面里那只不一定是这条 IMU 的狗，确认时对着标题上的狗名看清`, 10);
      }
      setSimilarOpen(false);
      setSimilarResult(r);
      setCandidates(await listCandidates(taskId));
    } finally {
      setSimilarRunning(false);
    }
  };
  // 弹窗是常驻挂载的（task=null 时只是 open=false），所以换任务/重新打开时这份
  // React state 不会自己归零——之前就是因为这个，关掉再进来顶上还挂着「正在循环
  // 播放」，可视频其实没在循环。这里跟着 bus 走：换 bus 就按新 bus 的实际状态重置。
  useEffect(() => {
    const l = bus.getLoop();
    setLoopRange(l ? { startMs: Math.round(l.start * 1000), endMs: Math.round(l.end * 1000) } : null);
    return bus.onLoopChange((x) => setLoopRange(x ? { startMs: Math.round(x.start * 1000), endMs: Math.round(x.end * 1000) } : null));
  }, [bus]);
  // 严格按标注的起止循环，前后不加余量：循环就是用来核对起止标得准不准的，
  // 多放一截反而看不出边界在哪；觉得起止不对就去改起止
  const setLoop = (r: { startMs: number; endMs: number } | null) =>
    bus.setLoop(r ? { start: Math.max(0, r.startMs) / 1000, end: r.endMs / 1000 } : null);
  /** 打开机位纠正：有循环区间就循环那一段，没有就播播放线前后几秒 */
  const openCamFix = () => {
    const t = curSecRef.current * 1000;
    setCamFixRange(loopRange ? [loopRange.startMs, loopRange.endMs] : [Math.max(0, t - 2000), t + 4000]);
    setCamFixOpen(true);
  };
  /** 纠正完这一场视频文件重新挂了，把播放源换成新的（不重开任务、不丢当前编辑） */
  const reloadAfterCamFix = () => {
    if (sampleId == null) return;
    getSampleMedia(sampleId).then(applySampleMedia).catch(() => undefined);
  };
  // 停止循环后浮窗还留着（勾了「停止循环后保留浮窗」）：拆段、调起止时不想一直循环，
  // 循环一停浮窗就没了又得重新点。记住最后一段，浮窗接着显示它；点浮窗的 X 才真正关
  const KEEP_KEY = "loop-popup-keep";
  const [keepPopup, setKeepPopupState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEEP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setKeepPopup = (v: boolean) => {
    setKeepPopupState(v);
    try {
      localStorage.setItem(KEEP_KEY, v ? "1" : "0");
    } catch {
      /* 存不了就只管这一次 */
    }
  };
  const [stickyRange, setStickyRange] = useState<{ startMs: number; endMs: number } | null>(null);
  useEffect(() => {
    if (loopRange) setStickyRange(loopRange);
  }, [loopRange]);
  const viewRange = loopRange ?? (keepPopup ? stickyRange : null);
  useEffect(() => {
    viewRangeRef.current = viewRange;
    writePos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRange?.startMs, viewRange?.endMs]);
  // 浮窗里显示的那段，不在循环时也能改（拆完 / 调完起止后跟着换到新的那段）
  const showRange = (r: { startMs: number; endMs: number }) => {
    if (loopRange) setLoop(r);
    else setStickyRange(r);
  };
  // 点 X 关掉就当作「不看这一段了」，顺手停掉循环；同一个任务再进来是同一个 bus，
  // 不清的话循环会跟着带回来
  // 审核时按片段标「有问题」：管理员 / 审核员能标能清；标注员只能在自己正在改的任务里清掉
  const canFlag = role === "admin" || role === "super_admin" || role === "reviewer";
  // 查看标注（只读）里补片段：审核员 / 管理员点「＋ 新建片段」打开标签条，标出来直接落库，不用认领
  const roCreateAllowed = !!readOnly && canFlag && !segReview && taskId != null;
  const [roCreate, setRoCreate] = useState(false);
  const canCreate = !readOnly || (roCreateAllowed && roCreate);
  const flaggedCount = items.filter((it) => it.review_note).length + candidates.filter((c) => c.review_note).length;
  const handleReviewNote = async (it: LabelItem, note: string | null) => {
    if (taskId == null) return;
    const saved = await setReviewNote(taskId, it.id, note);
    setItems((prev) => prev.map((x) => (x.id === it.id
      ? { ...x, review_note: saved.review_note, review_flag_by: saved.review_flag_by, seg_status: saved.seg_status ?? null }
      : x)));
    message.success(note ? `已退回这一条：${note}` : "已清除问题标记");
  };
  // 窗口核对时，如果一条片段跨越窗口边界，点「通过 / 改类别」前先按窗口边界自动切开，
  // 避免把窗外长达几十分钟、人工没看过的内容一并标成已通过或改了类别
  const WIN_SPLIT_MIN_MS = 300;
  const splitSeqRef = useRef(0);
  const splitForWindowLocal = (it: LabelItem, w: { s: number; e: number }, insidePatch?: Partial<LabelItem>) => {
    const hasLeft = w.s - it.start_time_ms >= WIN_SPLIT_MIN_MS;
    const hasRight = it.end_time_ms - w.e >= WIN_SPLIT_MIN_MS;
    const insideS = hasLeft ? Math.round(w.s) : it.start_time_ms;
    const insideE = hasRight ? Math.round(w.e) : it.end_time_ms;
    if ((!hasLeft && !hasRight) || insideE - insideS < WIN_SPLIT_MIN_MS) return null;
    const nextTmpId = () => -(Date.now() * 100 + (++splitSeqRef.current % 100));
    const pieces: LabelItem[] = [];
    if (hasLeft) {
      pieces.push({ ...it, id: nextTmpId(), end_time_ms: insideS, origin_item_id: null, from_candidate_id: null });
    }
    const inside = touchItem({ ...it, start_time_ms: insideS, end_time_ms: insideE }, insidePatch ?? {});
    pieces.push(inside);
    if (hasRight) {
      pieces.push({ ...it, id: nextTmpId(), start_time_ms: insideE, origin_item_id: null, from_candidate_id: null });
    }
    return { pieces, inside };
  };
  const splitForWindowRemote = async (it: LabelItem, w: { s: number; e: number }) => {
    if (it.id <= 0) return null;
    const hasLeft = w.s - it.start_time_ms >= WIN_SPLIT_MIN_MS;
    const hasRight = it.end_time_ms - w.e >= WIN_SPLIT_MIN_MS;
    const insideS = hasLeft ? Math.round(w.s) : it.start_time_ms;
    const insideE = hasRight ? Math.round(w.e) : it.end_time_ms;
    if ((!hasLeft && !hasRight) || insideE - insideS < WIN_SPLIT_MIN_MS) return null;
    let curId = it.id;
    if (hasLeft) {
      const r1 = await segSplit(curId, insideS);
      curId = r1.right.id;
    }
    if (hasRight) {
      const r2 = await segSplit(curId, insideE);
      curId = r2.left.id;
    }
    return { id: curId, start_time_ms: insideS, end_time_ms: insideE };
  };
  // 片段级「通过」：一条条认可（跟「有问题」一条条退回配对），不用整个任务通过
  const handleSegApprove = async (it: LabelItem, okFlag: boolean) => {
    if (okFlag && win && taskId != null) {
      if (!readOnly) {
        const sp = splitForWindowLocal(it, win);
        if (sp) {
          const next = items.flatMap((x) => (x.id === it.id ? sp.pieces : [x]));
          await saveDraft(taskId, toDraftPayload(next));
          const dr = await getDraft(taskId);
          const insideSaved = dr.items.find(
            (x) => x.start_time_ms === sp.inside.start_time_ms && x.end_time_ms === sp.inside.end_time_ms && x.label_id === it.label_id,
          );
          if (insideSaved) await segDecide(insideSaved.id, "approved");
          loadItems((await getDraft(taskId)).items);
          message.success("已按窗口边界自动切分，仅通过窗内部分（窗外保持原样）");
          return;
        }
      } else {
        const insideRemote = await splitForWindowRemote(it, win);
        if (insideRemote) {
          await segDecide(insideRemote.id, "approved");
          loadItems((await getDraft(taskId)).items);
          message.success("已按窗口边界自动切分，仅通过窗内部分（窗外保持原样）");
          return;
        }
      }
    }
    const r = await segDecide(it.id, okFlag ? "approved" : "pending");
    setItems((prev) => prev.map((x) => (x.id === it.id
      ? { ...x, seg_status: r.seg_status === "pending" ? null : r.seg_status, ...(okFlag ? { review_note: null, review_flag_by: null } : {}) }
      : x)));
    message.success(okFlag ? "这一条通过了" : "已撤销通过");
  };
  // 管理员复查：别人通过的这条有问题，退回给原来通过它的人重审
  const handleSendBackReviewer = async (it: LabelItem, note: string | null) => {
    await segSendBackReviewer(it.id, note ?? undefined);
    setItems((prev) => prev.map((x) => (x.id === it.id
      ? { ...x, seg_status: null, seg_reviewed_by: null, seg_reviewed_at: null, ...(note ? { mark_note: `复查退回：${note}` } : {}) }
      : x)));
    message.success(`已退回给原来通过它的人重审${note ? `（${note}）` : ""}，在他的待审里`);
  };
  const handleCandReviewNote = async (c: AiCandidate, note: string | null) => {
    const saved = await setCandidateReviewNote(c.id, note);
    setCandidates((prev) => prev.map((x) => (x.id === c.id ? { ...x, review_note: saved.review_note, review_flag_by: saved.review_flag_by } : x)));
    message.success(note ? `已标为有问题：${note}` : "已清除问题标记");
  };
  // 已通过 / 已驳回的任务：标完直接退回，原因自动写上是哪几段
  const reopenFlagged = async () => {
    if (taskId == null) return;
    const lines = [
      ...items.filter((it) => it.review_note)
        .map((it) => ({ t: it.start_time_ms, s: `${formatMs(it.start_time_ms)} ${nameOf(it.label_id)}：${it.review_note}` })),
      ...candidates.filter((c) => c.review_note)
        .map((c) => ({ t: c.start_time_ms, s: `${formatMs(c.start_time_ms)} 疑似${c.label_name}：${c.review_note}` })),
    ].sort((a, b) => a.t - b.t).map((x) => x.s);
    await reopenTask(taskId, `${lines.length} 段有问题\n${lines.join("\n")}`.slice(0, 1000));
    message.success(`已退回重标，标注员打开时会先看到这 ${lines.length} 段`);
    onSaved?.();
    handleClose();
  };
  const handleClose = () => {
    bus.setLoop(null);
    setUrlSeg(null);
    onClose();
  };
  /** 把正在看的片段写进地址栏（?seg=片段id），复制链接发给别人就能直接打开到这一段。
   *  只在地址栏里已经有 ?task= 的页面上写（项目页 / 任务页），别的地方打开的工作台不动地址栏。
   *  用 replaceState，不往历史里塞记录 */
  const setUrlSeg = (id: number | null) => {
    const url = new URL(window.location.href);
    if (!url.searchParams.get("task")) return;
    if (id == null) url.searchParams.delete("seg");
    else url.searchParams.set("seg", String(id));
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  };
  const copySegLink = (id: number) => {
    const url = new URL(window.location.href);
    if (taskId != null) url.searchParams.set("task", String(taskId));
    url.searchParams.set("seg", String(id));
    const text = url.href;
    const ok = () => message.success("链接已复制，发给对方打开就是这一段");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, () => window.prompt("复制这个链接：", text));
    else window.prompt("复制这个链接：", text);
  };

  // 按样本当前的视频挂载重建播放源。机位纠正之后几路文件会重新挂，
  // 这里单独抽出来：改完不用重开任务，画面直接换成纠正后的那几路
  const applySampleMedia = async (media: Awaited<ReturnType<typeof getSampleMedia>>) => {
    const entries: [string, number | null][] = [
      ["视角1", media.video1_id],
      ["视角2", media.video2_id],
      ["视角3", media.video3_id],
    ];
    const vids: VideoSrc[] = [];
    // 夜视弹窗要能切机位：黑的那一路看不清时，得拿同一时刻别的机位
    // （尤其是看全场那一路）对一眼，才知道增强出来的东西是不是真的
    const cams: { value: string; label: string }[] = [];
    for (const [i, [label, id]] of entries.entries()) {
      if (id == null) continue;
      cams.push({ value: `cam${i + 1}`, label });
      const { token } = await getMediaToken(id);
      // 这一路的原点跟样本差多少：跨 session 挂过来的那一路（看全场的 cam7）
      // 差着几秒到几十分钟，不换算就是放了十几分钟之外的画面
      const off = (media.video_offsets_ms?.[i] ?? 0) / 1000;
      vids.push({ label: off ? `${label}（差 ${off.toFixed(1)}s，已对齐）` : label,
                  url: mediaStreamUrl(id, token), offsetSec: off });
    }
    setVideos(vids);
    setCamList(cams);
    setMediaSite(media.site ?? null);
    // 影棚该有三路、狗场该有两路。少了但不是一路都没有时，原来这里一声不吭
    setVideoNote(media.video_note ?? null);
    setVideoWhy(
      vids.length > 0
        ? null
        : media.video_missing_in_library.length > 0
          ? `样本上登记了 ${media.video_missing_in_library.length} 路视频，但媒体库里没有这些文件：${media.video_missing_in_library.join("、")}。多半是没传上 NAS，或者传了还没被扫到——去「样本」页点一次「立即扫描」再看。`
          : "这个样本上就没有登记视频文件。采集/归档时这一路只上传了 IMU 数据（比如 imu4 那种只传 csv 的），或者视频还没归档过来。IMU 波形和片段列表照常能用，只是没法对着画面核对。"
    );
    setHasCsv(media.csv_id != null);
    setFps(media.video_fps);
  };

  useEffect(() => {
    if (taskId == null || sampleId == null) {
      setVideos([]);
      setCamList([]);
      setVideoWhy(null);
      setVideoNote(null);
      setHasCsv(false);
      setFps(null);
      loadItems([]);
      setDurationMs(null);
      return;
    }
    setLoading(true);
    setImuView("曲线图");
    (async () => {
      // 打开就先补一次：有一版前端的顺序会把刚从候选确认出来的片段又删掉，
      // 这一步按候选行把丢掉的补回来。没有缺的就是个空操作
      await repairCandidateItems(taskId).catch(() => undefined);
      const media = await getSampleMedia(sampleId);
      await applySampleMedia(media);
      // 从别处点「去修」进来的：直接停在出问题的那一刻，不用自己拖进度条找
      if (initialSeekMs != null) bus.seek(initialSeekMs / 1000);
      // 短任务（只标样本里的一段，比如模型测试的 1 分钟窗口）：没指定位置就停在窗口开头
      else if (win) bus.seek(win.s / 1000);
      // 有窗口：指定了事件子区间（如评测错例点进具体几秒）优先循环该事件；否则循环整段窗口
      if (focusWindow?.loopRange) setLoop(focusWindow.loopRange);
      else if (win) setLoop({ startMs: win.s, endMs: win.e });
      // 第一阶段（大模型找动作 / 疑似片段）跳过来扩样本：样例就是那一刻，
      // 类别也带过来了。人在那边已经判断过一次了，不该到这儿再选一遍
      if (initialSimilar && initialSeekMs != null) {
        setSimilarAtSec(Math.round(initialSeekMs / 100) / 10);
        if (initialSimilarLabel) setSimilarLabel(initialSimilarLabel);
        setSimilarOpen(true);
      }
      if (media.csv_id != null) {
        getImuMeta(sampleId)
          .then((m) => setDurationMs(m.duration_ms))
          .catch(() => setDurationMs(null));
      } else {
        setDurationMs(null);
      }

      const draft = await getDraft(taskId);
      loadItems(draft.items);
      const flagged = draft.items.filter((it) => it.review_note).sort((a, b) => a.start_time_ms - b.start_time_ms);
      setFlagFocus(!readOnly && flagged.length > 0);
      // 从筛过类别的列表点进来（项目页筛了「进食」/候选类别「进食」），又没指定具体时刻：
      // 直接停到第一段对得上的，循环播放。不然进来还是从 0 秒开始，几十段里要自己去找
      // 刷新回来：回到上次的位置和循环（不是从别处指定了时刻点进来的才这么做）
      // 链接里带了片段（?task=…&seg=片段id，别人发过来让改这一段的）：直接循环那一段，优先于上次的位置
      const urlSegId = initialSegId ?? Number(new URLSearchParams(window.location.search).get("seg"));
      const urlSeg = urlSegId && !segReview ? draft.items.find((x) => x.id === urlSegId) : undefined;
      if (urlSeg) {
        bus.seek(urlSeg.start_time_ms / 1000);
        setLoop({ startMs: urlSeg.start_time_ms, endMs: urlSeg.end_time_ms });
      } else if (urlSegId) {
        message.warning("链接里的那一段已经不在了（可能被删了或重新拆过）");
      }
      const restore = !urlSeg && !jumpToFocus && initialSeekMs == null && !segReview && savedPos != null;
      if (restore) {
        bus.seek(savedPos.sec);
        if (savedPos.loop) setLoop(savedPos.loop);
        else if (savedPos.view) setStickyRange(savedPos.view);
      }
      posReady.current = true;
      const autoJump = initialSeekMs == null && !restore && !urlSeg;
      const jumpTo = (r: { start_time_ms: number; end_time_ms: number }, what: string, n: number) => {
        bus.seek(r.start_time_ms / 1000);
        setLoop({ startMs: r.start_time_ms, endMs: r.end_time_ms });
        message.info(`已跳到第一段「${what}」${formatMs(r.start_time_ms)}（共 ${n} 段）`, 3);
      };
      const segSet = new Set(initialSegmentFilter);
      const segHits = [...draft.items].filter((it) => segSet.has(it.label_id))
        .sort((a, b) => a.start_time_ms - b.start_time_ms);
      listCandidates(taskId)
        .then((cs) => {
          setCandidates(cs);
          const flaggedCands = cs.filter((c) => c.review_note).sort((a, b) => a.start_time_ms - b.start_time_ms);
          setCandFlagFocus(!readOnly && flaggedCands.length > 0);
          if (autoJump && !jumpToFocus && !readOnly && flagged.length) {
            // 被退回来改的：先看审核标了问题的那几条，比按类别筛更具体
            jumpTo(flagged[0], `有问题：${flagged[0].review_note}`, flagged.length + flaggedCands.length);
          } else if (autoJump && !jumpToFocus && !readOnly && flaggedCands.length) {
            jumpTo(flaggedCands[0], `${candTitle(flaggedCands[0].label_name)} 有问题：${flaggedCands[0].review_note}`, flaggedCands.length);
          } else if (autoJump) {
            // 候选类别优先：按「疑似进食」筛进来，要看的就是疑似片段；先挑还没判过的
            const want = new Set(focusCandLabels ?? []);
            const hits = cs.filter((c) => want.has(c.label_name))
              .sort((a, b) => Number(a.status !== "pending") - Number(b.status !== "pending") || a.start_time_ms - b.start_time_ms);
            if (hits.length) jumpTo(hits[0], candTitle(hits[0].label_name), hits.length);
            else if (segHits.length) jumpTo(segHits[0], labelById.get(segHits[0].label_id)?.display_name ?? "片段", segHits.length);
          }
          // 从找相似的链接进来（?seek=&cand=similar）：直接把那一段设成循环播放，不用人再去找。
          // 「先看命中」跳来的还没写候选，那就循环命中前 2 秒到后 4 秒
          if (initialSeekMs != null && initialCandFilter != null) {
            // cand=all 是「这一段被挡住了」的链接：挡路的那条不一定是画面相似来的，
            // 所以先按包含关系找任意来源的候选，找不到再退回原来的「只认画面相似」
            const hit = cs.find((c) => c.start_time_ms <= initialSeekMs && initialSeekMs < c.end_time_ms)
              ?? cs.find((c) => c.reason === "similar" && Math.abs(c.start_time_ms - initialSeekMs) < 1500);
            setLoop(hit ? { startMs: hit.start_time_ms, endMs: hit.end_time_ms } : { startMs: Math.max(0, initialSeekMs - 2000), endMs: initialSeekMs + 4000 });
          }
        })
        .catch(() => {
          setCandidates([]);
          if (autoJump && segHits.length) jumpTo(segHits[0], labelById.get(segHits[0].label_id)?.display_name ?? "片段", segHits.length);
        });
      getAiLabelInfo(sampleId).then(setAiInfo).catch(() => setAiInfo(null));
      setLoading(false);
    })();
  }, [taskId, sampleId]);

  // 认领期间定时续锁，不然标到一半锁超时被回收
  useEffect(() => {
    if (taskId == null || readOnly) return;
    const timer = setInterval(() => {
      heartbeat(taskId).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [taskId, readOnly]);

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  // 名字 → 标签 id（项目之间标签 id 不同，只能按名字找）
  const focusIds = useMemo(
    () =>
      focusLabelName
        ? labels.filter((l) => l.display_name === focusLabelName || l.code === focusLabelName).map((l) => l.id)
        : [],
    [focusLabelName, labels]
  );
  // 片段列表打开时默认筛哪几类。focusLabelName（皮肤跟踪表那条路）优先；
  // 没有就用列表页带过来的 id——项目/任务页筛了「抓挠」，进来就该已经是抓挠。
  // 不并进 focusIds：那个还兼着候选面板的 scratchLabelIds，见 Props 上的说明。
  // taskId 也进依赖：同一个项目连着看好几个任务时，focusLabelIds 是同一个数组
  // 引用、不会变，SegmentPanel 里那个"换任务重新套上默认筛选"的 effect 就不会
  // 触发——于是只有第一个任务是筛好的，后面几个又回到全部类别。带上 taskId 让
  // 每次打开都产生一个新引用。
  // 层级：筛「抓挠」把它的子类（抓挠-头颈耳……）一起带上，标了细的也是抓挠
  const initialSegmentFilter = useMemo(
    () => [...descendantIds(labels, focusIds.length ? focusIds : focusLabelIds ?? [])],
    [focusIds, focusLabelIds, taskId, labels]
  );
  // 「抓挠」在这个项目里的标签 id：候选面板的「改成别的」要把它排掉
  // 只排父标签本身：「改成别的」里还得能选到「抓挠-头颈耳」这种细分
  const scratchIds = useMemo(
    () => labels.filter((l) => l.display_name === "抓挠" || l.code === "抓挠").map((l) => l.id),
    [labels]
  );
  // 层级标签：第一行只摆大类（没有上级的）。展开跟"选哪个"分开：
  // 点标签 = 选这个类别（大级别也能直接选）；点后面的 ▾ 才展开子类
  const labelChildren = useMemo(() => childrenMap(labels), [labels]);
  const [expandPath, setExpandPath] = useState<number[]>([]);
  const labelRows = useMemo(() => {
    // 第一行的大类按互斥轨分组排（行为 / 运动 / 姿态 / 设备），组间画个灰字分隔；没分轨的项目原样
    const roots = [...(labelChildren.get(null) ?? [])];
    const rank = (l: LabelDefinition) => {
      const i = TRACKS.findIndex((t) => t.key === trackOf(labelById, l.id));
      return i < 0 ? TRACKS.length : i;
    };
    roots.sort((a, b) => rank(a) - rank(b) || a.sort_order - b.sort_order || a.id - b.id);
    const rows: { parent: LabelDefinition | null; items: LabelDefinition[] }[] = [{ parent: null, items: roots }];
    for (const id of expandPath) {
      const node = labelById.get(id);
      if (!node) break;
      const kids = labelChildren.get(id) ?? [];
      if (!kids.length) break;
      rows.push({ parent: node, items: kids });
    }
    return rows.slice(0, ROW_KEYS.length);
  }, [labels, labelById, labelChildren, expandPath]);
  // 展开某一层的子类（再点一次收起它和它下面的）；只影响看，不动当前选中的类别
  const toggleExpand = (l: LabelDefinition) => {
    setExpandPath((prev) => {
      const idx = prev.indexOf(l.id);
      if (idx >= 0) return prev.slice(0, idx);
      return chainOf(labelById, l.id).map((x) => x.id);
    });
  };
  const selectedChain = useMemo(() => new Set(labelId != null ? chainOf(labelById, labelId).map((l) => l.id) : []), [labelId, labelById]);
  const colorOf = (id: number) =>
    labelById.get(id)?.color || FALLBACK_COLORS[id % FALLBACK_COLORS.length];
  const nameOf = (id: number) => labelById.get(id)?.display_name ?? `#${id}`;

  // 正在循环的是哪一段：按起止对回已标注片段 / 疑似片段，给波形浮窗当标题。
  // 两边都对不上（视频那边手动定的区间）就只写时间
  const loopInfo = useMemo<LoopInfo | null>(() => {
    if (!viewRange) return null;
    const { startMs, endMs } = viewRange;
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;
    const it = items.find((x) => near(x.start_time_ms, startMs) && near(x.end_time_ms, endMs));
    const c = it ? undefined : candidates.find((x) => near(x.start_time_ms, startMs) && near(x.end_time_ms, endMs));
    // 附近 1 分钟内别的片段 / 还没判的疑似片段：浮窗顶上画细色带，看得出前后挨着的是什么
    const lo = startMs - 60000, hi = endMs + 60000;
    const neighbors = [
      ...items.filter((x) => x !== it && x.end_time_ms > lo && x.start_time_ms < hi)
        .map((x) => ({ s: x.start_time_ms, e: x.end_time_ms, color: colorOf(x.label_id), label: nameOf(x.label_id) })),
      ...candidates.filter((x) => x !== c && x.status === "pending" && x.end_time_ms > lo && x.start_time_ms < hi)
        .map((x) => ({ s: x.start_time_ms, e: x.end_time_ms, color: "#999", label: `疑似${x.label_name}` })),
    ];
    if (it) return { startMs, endMs, title: `已标注 · ${nameOf(it.label_id)}`, color: colorOf(it.label_id), itemId: it.id, neighbors };
    if (c) return { startMs, endMs, title: `疑似 · ${c.label_name}`, candId: c.id, neighbors };
    const ep = focusWindow?.evalHint?.predSegs.find(([ps, pe]) => near(ps, startMs) && near(pe, endMs));
    if (ep && focusWindow?.evalHint) {
      return {
        startMs,
        endMs,
        title: `模型预测 · ${focusWindow.evalHint.label}${ep[2] != null ? ` (${ep[2]})` : ""}`,
        color: "#faad14",
        neighbors,
      };
    }
    return { startMs, endMs, title: "循环区间", neighbors };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRange, items, candidates, labelById, focusWindow?.evalHint]);

  // 分了互斥轨的项目：波形上的色块按轨分成几条横带（行为 / 运动 / 姿态 / 设备），
  // 同一时刻「卧 + 静止 + 舔」三条各占一带，不互相盖住。没分轨的项目照旧整高一条
  const usedTracks = useMemo(() => {
    const set = new Set(labels.map((l) => trackOf(labelById, l.id)).filter(Boolean));
    return TRACKS.map((t) => t.key).filter((k) => set.has(k));
  }, [labels, labelById]);
  // 片段列表里筛了（类别：只看抓挠 / 某几类；来源：只看人工 / AI 待确认……），波形图也只画列表里留下的那些：
  // 几百段挤在一起一个个认太累。
  // 筛掉的段挪到时间轴外面（不删、不改顺序）——波形上拖动 / 右键是按下标对回 items 的
  const [chartFilter, setChartFilter] = useState<Set<number> | null>(null);
  // 人工标注模式（按项目记在本机）：AI 片段先藏起来，从零自己标；在片段列表里选类别就把那几类的 AI 片段拿出来参考
  const manualKey = task?.project_id != null ? `smart-label:manual-mode:${task.project_id}` : null;
  const [manualMode, setManualModeState] = useState(false);
  // 双波形只在「从零标注」下有意义（上面原始、下面 AI 对照）。
  // 退出从零标注时一并收回，免得留着一个选不回去的模式
  useEffect(() => {
    if (!manualMode && chartDual) {
      setChartDual(false);
      saveBool(CHART_DUAL_KEY, false);
    }
  }, [manualMode, chartDual]);
  // 类别一排能占两三行（行为/运动/姿态/设备），默认收起，只留当前选中那个；点「类别」向上弹出
  const [labelsOpen, setLabelsOpen] = useState(false);
  // 先拉片段再选类别：在波形上拖出来的起止先挂在这儿，等类别按钮点了才真正建段
  const [pendingSpan, setPendingSpan] = useState<{ startMs: number; endMs: number } | null>(null);
  useEffect(() => {
    try { setManualModeState(manualKey ? localStorage.getItem(manualKey) === "1" : false); } catch { setManualModeState(false); }
  }, [manualKey]);
  const setManualMode = (v: boolean) => {
    setManualModeState(v);
    try { if (manualKey) localStorage.setItem(manualKey, v ? "1" : "0"); } catch { /* ignore */ }
  };
  // 每次打开类别弹窗：待建区间从大类开始（方便一次点到大类）；平时顺着当前类别展开
  useEffect(() => {
    if (!labelsOpen) return;
    if (pendingSpan || labelId == null) setExpandPath([]);
    else setExpandPath(chainOf(labelById, labelId).map((x) => x.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsOpen]);
  // 波形上画哪些片段。mode="main" 是上面那张（人工标注用的），
  // mode="ai" 是双波形下面那张（只看 AI 的结果，人工自己画的不重复画）
  const buildChartSegments = (mode: "main" | "ai"): ChartSegment[] => {
    const rows = items.map((i) => {
      const t = trackOf(labelById, i.label_id);
      const off = !inWin(i.start_time_ms, i.end_time_ms)
        || (chartFilter != null && !chartFilter.has(i.id))
        || (mode === "ai"
          ? i.source_type !== "ai_generated"
          // 从零标注：没人碰过的 AI 片段不画进上面那张（列表里选了什么筛选都一样）
          : manualMode && i.source_type === "ai_generated" && !i.ai_confirmed && !i.is_modified && !i.uncertain);
      return { i, t, off };
    });
    // 只有当别的轨的片段在时间上真压着这一段时才分带，平时整高显示。
    // 按"项目里有几条轨"一律分带的话，一段会缩在最上面那一条里，看着像没画完整
    const alive = rows.map((r, idx) => ({ ...r, idx })).filter((r) => !r.off && r.t);
    const bands: ({ lane: number; lanes: number } | undefined)[] = new Array(rows.length).fill(undefined);
    for (const r of alive) {
      const overlaps = alive.filter(
        (o) => o.idx !== r.idx
          && o.t !== r.t
          && o.i.start_time_ms < r.i.end_time_ms
          && o.i.end_time_ms > r.i.start_time_ms
      );
      if (!overlaps.length) continue;
      const keys = TRACKS.map((t) => t.key).filter((k) => k === r.t || overlaps.some((o) => o.t === k));
      bands[r.idx] = { lane: keys.indexOf(r.t!), lanes: keys.length };
    }
    return rows.map(({ i, off }, idx) => ({
      start_time_ms: off ? -1e12 : i.start_time_ms,
      end_time_ms: off ? -1e12 : i.end_time_ms,
      color: colorOf(i.label_id),
      label: nameOf(i.label_id),
      ...(bands[idx] ?? {}),
    }));
  };
  const segments: ChartSegment[] = useMemo(
    () => buildChartSegments("main"),
    [items, labelById, chartFilter, manualMode, win?.s, win?.e]
  );
  const aiSegments: ChartSegment[] = useMemo(
    () => buildChartSegments("ai"),
    [items, labelById, chartFilter, manualMode, win?.s, win?.e]
  );

  // 同一轨的两段在时间上不能叠（跨轨叠是正常的，靠分带区分）。
  // 新建 / 拖起止碰到别的段就提示一下：跟哪一段叠了、叠了多少
  const warnOverlap = (forLabel: number, startMs: number, endMs: number, excludeId?: number) => {
    const s = Math.round(Math.max(0, startMs)), e = Math.round(Math.max(0, endMs));
    const track = trackOf(labelById, forLabel);
    const hit = items.find(
      (x) => x.id !== excludeId
        && trackOf(labelById, x.label_id) === track
        && x.start_time_ms < e
        && x.end_time_ms > s
    );
    if (!hit) return;
    const overlap = Math.min(e, hit.end_time_ms) - Math.max(s, hit.start_time_ms);
    message.warning({
      content: `和「${nameOf(hit.label_id)}」${formatMs(hit.start_time_ms)} ~ ${formatMs(hit.end_time_ms)} 边界重叠 ${formatMs(overlap)}`,
      key: "seg-overlap",
    });
  };

  const appendItem = (startMs: number, endMs: number, forLabel: number) => {
    warnOverlap(forLabel, startMs, endMs);
    if (readOnly) {
      if (!roCreateAllowed || taskId == null) return;
      void (async () => {
        try {
          await segCreate({
            task_id: taskId, label_id: forLabel,
            start_time_ms: Math.round(Math.max(0, startMs)), end_time_ms: Math.round(Math.max(0, endMs)),
          });
          loadItems((await getDraft(taskId)).items);
          message.success({ content: "已新建并保存（算通过）", key: "ro-create" });
        } catch {
          /* request 拦截器已经弹了错误 */
        }
      })();
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        id: -Date.now(),
        label_id: forLabel,
        start_time_ms: Math.round(Math.max(0, startMs)),
        end_time_ms: Math.round(Math.max(0, endMs)),
        origin_item_id: null,
        source_type: "human_added",
        is_modified: false,
        ai_confidence: null,
        ai_confirmed: false,
        uncertain: false,
        uncertain_reason: null,
        from_candidate_id: null,
        created_by: null,
      },
    ]);
  };

  // 先拉后选：类别点下去时，把刚才拉出来的那段按这个类别建好。
  // 没有待建的就返回 false，让调用方按原来的方式切换类别
  const commitPendingSpan = (forLabel: number) => {
    const span = pendingSpan;
    if (!span) return false;
    setPendingSpan(null);
    appendItem(span.startMs, span.endMs, forLabel);
    message.success({
      content: `已标 ${nameOf(forLabel)} ${formatMs(span.startMs)} ~ ${formatMs(span.endMs)}`,
      key: "mark",
    });
    return true;
  };
  // 键盘选类别（数字键）在 window 上监听，闭包拿不到最新的 pendingSpan，用 ref 过渡
  const commitPendingRef = useRef(commitPendingSpan);
  commitPendingRef.current = commitPendingSpan;

  // 人工改了 AI 片段的类别/起止：本地立刻标成"已纠正"并清掉确认，跟后端
  // save_draft 的判定一致，不用等保存后重新拉一遍才变
  const touchItem = (it: LabelItem, patch: Partial<LabelItem>): LabelItem => {
    const changed =
      (patch.label_id != null && patch.label_id !== it.label_id) ||
      (patch.start_time_ms != null && patch.start_time_ms !== it.start_time_ms) ||
      (patch.end_time_ms != null && patch.end_time_ms !== it.end_time_ms);
    const next = { ...it, ...patch };
    if (changed && it.source_type === "ai_generated") {
      next.is_modified = true;
      next.ai_confirmed = false;
    }
    // 审核标过「有问题」的，改了就算处理过（跟后端存草稿时的规则一致）
    if (changed && it.review_note) {
      next.review_note = null;
      next.review_flag_by = null;
    }
    return next;
  };

  // 波形浮窗里调好的起止：改这一条、立刻落库，再拉一遍——调整记录（第几次、从哪改到哪）
  // 是后端存草稿时记的，不拉回来的话「起止调过 N 次」不会更新。循环跟着换到新起止
  const adjustBoundary = async (target: AdjustTarget, startMs: number, endMs: number) => {
    if (taskId == null) return;
    if (target.kind === "cand") {
      // 疑似片段：直接改那条候选（后端记调整记录），列表拉一遍
      await setCandidateSpan(target.id, startMs, endMs);
      setCandidates(await listCandidates(taskId));
      showRange({ startMs, endMs });
      message.success("起止已保存");
      return;
    }
    const id = target.id;
    const next = items.map((it) => (it.id === id ? touchItem(it, { start_time_ms: startMs, end_time_ms: endMs }) : it));
    setItems(next);
    await saveDraft(taskId, toDraftPayload(next));
    const d = await getDraft(taskId);
    loadItems(d.items);
    showRange({ startMs, endMs });
    message.success("起止已保存");
  };

  // 只读时想拖起止：说清楚为什么改不了、要先做什么。以前拖边没反应也没提示，
  // 实习生以为是功能坏了
  const readOnlyHint = onClaim
    ? "现在是「查看」模式，不能改起止：先点右下角「认领并修改」"
    : task?.status === "SUBMITTED" || task?.status === "APPROVED"
      ? onEditAgain
        ? "这个任务已提交：点右下角「继续编辑」就能接着改，改完再提交"
        : "这个任务已提交，不能再改起止（要改先退回重标）"
      : "这个任务不在你名下，只能看不能改";

  // 片段审核：草稿拉回来之后循环那一条（不靠 initialSeekMs 去找——同一时刻往往还压着
  // 别的轨的片段，按时刻找可能循环到「活动」那条上）
  useEffect(() => {
    if (!segReview) return;
    const it = items.find((x) => x.id === segReview.itemId);
    if (it) setLoop({ startMs: it.start_time_ms, endMs: it.end_time_ms });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segReview?.itemId, items.length > 0]);

  // 正在循环的已标注片段（审核员在浮窗里直接「通过 / 有问题」用）
  const loopItem = loopInfo?.itemId != null ? items.find((x) => x.id === loopInfo.itemId) : undefined;
  // 循环到哪一段，地址栏的 ?seg= 就跟到哪一段（刷新 / 复制地址栏发给别人都是这一段）
  useEffect(() => {
    if (segReview || loopInfo?.itemId == null) return;
    setUrlSeg(loopInfo.itemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopInfo?.itemId]);

  // 退回给我的那条拆出来的「一组」：每一段都能接着拆、调起止、改类别（不止原来那一条）
  // 存在 localStorage 里：刷新页面回来，拆出来的那几段还认得是「这一组」
  const groupKey = segReview ? `seg-split-group:${segReview.itemId}` : null;
  const [splitGroup, setSplitGroup] = useState<number[]>([]);
  useEffect(() => {
    if (!segReview || !groupKey) {
      setSplitGroup([]);
      return;
    }
    let saved: number[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(groupKey) || "[]");
    } catch {
      saved = [];
    }
    setSplitGroup([...new Set([segReview.itemId, ...(Array.isArray(saved) ? saved : [])])]);
  }, [segReview?.itemId]);
  useEffect(() => {
    if (!groupKey || splitGroup.length < 2) return;
    try {
      localStorage.setItem(groupKey, JSON.stringify(splitGroup));
    } catch {
      /* 存不了就算了，只是刷新后要从列表里找 */
    }
  }, [groupKey, splitGroup]);
  const inGroup = (id: number | null | undefined) => !!segReview && id != null && splitGroup.includes(id);
  const groupItems = items.filter((x) => inGroup(x.id)).sort((a, b) => a.start_time_ms - b.start_time_ms);
  // 原来那一条变了：告诉审核页（它那边存着这一条的起止类别，改类别时要用）
  const syncMain = (list: LabelItem[]) => {
    const m = segReview ? list.find((x) => x.id === segReview.itemId) : undefined;
    if (m) segReview?.onChanged?.({ start_time_ms: m.start_time_ms, end_time_ms: m.end_time_ms, label_id: m.label_id });
  };
  const relabelPiece = async (it: LabelItem, labelId: number) => {
    if (taskId == null || labelId === it.label_id) return;
    await segEdit(it.id, { start_time_ms: it.start_time_ms, end_time_ms: it.end_time_ms, label_id: labelId });
    const d = await getDraft(taskId);
    loadItems(d.items);
    syncMain(d.items);
    message.success(`已改成「${nameOf(labelId)}」`);
  };
  // ── 大波形上右键片段：改类别 / 拆开 / 删除 ──
  const [segMenu, setSegMenu] = useState<{ idx: number; at: number; x: number; y: number } | null>(null);
  // 波形上单击选中的片段。按 id 记：重排、删掉别的段之后不会串到别的一段上
  const [selSegId, setSelSegId] = useState<number | null>(null);
  useEffect(() => { setSelSegId(null); }, [task?.id]);
  const selSegIdx = selSegId == null ? -1 : items.findIndex((x) => x.id === selSegId);
  const selectedItem = selSegIdx >= 0 ? items[selSegIdx] : null;
  useEffect(() => {
    if (!segMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSegMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segMenu]);
  const menuItem = segMenu ? items[segMenu.idx] : undefined;
  const relabelFromMenu = async (it: LabelItem, v: number) => {
    setSegMenu(null);
    if (v === it.label_id) return;
    if (!readOnly) {
      updateItems([it.id], { label_id: v });
      message.success({ content: `已改成「${nameOf(v)}」（自动保存）`, key: "relabel" });
    } else if (segReview) {
      if (!inGroup(it.id)) {
        message.info({ content: "这里只能改退回给你的那一条（和从它拆出来的几段）", key: "relabel" });
        return;
      }
      await relabelPiece(it, v);
    } else if (canFlag) {
      await relabelItem(it, v);
    } else {
      message.info({ content: readOnlyHint, key: "relabel" });
    }
  };
  const segMenuEl = segMenu && menuItem && (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 1190 }}
        onMouseDown={() => setSegMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSegMenu(null); }} />
      <div
        style={{
          position: "fixed",
          left: Math.min(segMenu.x, window.innerWidth - 240),
          top: Math.min(segMenu.y, window.innerHeight - 380),
          zIndex: 1200, width: 230, background: tk.colorBgElevated, borderRadius: 8, padding: 8,
          boxShadow: "0 6px 16px rgba(0,0,0,.18)", border: `1px solid ${tk.colorBorderSecondary}`, fontSize: 12,
        }}
      >
        <div style={{ marginBottom: 6, color: "#666" }}>
          <Tag color={colorOf(menuItem.label_id)} style={{ marginRight: 4 }}>{nameOf(menuItem.label_id)}</Tag>
          {formatMs(menuItem.start_time_ms)} → {formatMs(menuItem.end_time_ms)}
        </div>
        <ConfigProvider theme={{ token: { zIndexPopupBase: 1250 } }}>
          <LabelTreeSelect
            labels={labels}
            autoFocus
            defaultOpen
            size="middle"
            placeholder="改成…（可输入搜索）"
            style={{ width: "100%" }}
            value={menuItem.label_id}
            listHeight={260}
            recent={recentLabels(task?.project_id)}
            onChange={(v) => { rememberLabel(task?.project_id, v); relabelFromMenu(menuItem, v); }}
          />
        </ConfigProvider>
        <Space size={4} style={{ marginTop: 6 }} wrap>
          <Button size="small" onClick={() => { const m = segMenu; setSegMenu(null); splitItem(m.idx, m.at); }}>
            ✂ 从这里拆开
          </Button>
          <Button size="small" onClick={() => { setSegMenu(null); setLoop({ startMs: menuItem.start_time_ms, endMs: menuItem.end_time_ms }); }}>
            ▶ 循环
          </Button>
          {(!readOnly || canFlag) && (
            <Button
              size="small"
              danger
              onClick={() => {
                setSegMenu(null);
                if (readOnly) void deleteItemRemote(menuItem);
                else {
                  setSelSegId(null);
                  setItems((prev) => prev.filter((x) => x.id !== menuItem.id));
                }
              }}
            >
              删除
            </Button>
          )}
        </Space>
      </div>
    </>
  );

  // 浮窗里「这一段拆成的几段」：片段审核按拆分组（权限只到这一组）；平时按时间范围——
  // 浮窗第一次打开的那条片段的起止，范围里的片段都列出来（拆出来的、本来就压在里面的）。
  // 按范围不按 id：存草稿后新片段的 id 会变，按 id 记会丢
  const [rootRange, setRootRange] = useState<{ s: number; e: number } | null>(null);
  useEffect(() => {
    if (!viewRange) {
      setRootRange(null);
      return;
    }
    const it = loopInfo?.itemId != null ? items.find((x) => x.id === loopInfo.itemId) : undefined;
    if (!it) return;
    setRootRange((r) => (r && it.start_time_ms >= r.s - 2 && it.end_time_ms <= r.e + 2
      ? r : { s: it.start_time_ms, e: it.end_time_ms }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRange?.startMs, viewRange?.endMs, loopInfo?.itemId]);
  const panelItems = segReview
    ? groupItems
    : rootRange
      ? items.filter((x) => x.start_time_ms >= rootRange.s - 2 && x.end_time_ms <= rootRange.e + 2)
        .sort((a, b) => a.start_time_ms - b.start_time_ms)
      : [];
  const panelIds = new Set(panelItems.map((x) => x.id));
  // 浮窗里「这段时间里 N 段」的逐段列表：段多了会把浮窗撑得很高、挡住后面的片段表。
  // 默认收起只留一行，展开了也限高、自己滚；记住上次的
  const [piecesOpen, setPiecesOpenState] = useState(() => {
    try { return localStorage.getItem("smart-label:wave-pieces-open") === "1"; } catch { return false; }
  });
  const setPiecesOpen = (v: boolean) => {
    setPiecesOpenState(v);
    try { localStorage.setItem("smart-label:wave-pieces-open", v ? "1" : "0"); } catch { /* ignore */ }
  };
  const splitControls = (
    <>
      <Tooltip title={`把播放线压着的那一段拆成两段（类别不变${segReview ? "，都交回重审" : "，自动保存"}）。也可以在下面波形上按住 Alt 点要拆的位置，或按 Alt+S。拆出来的每段都能接着拆、改类别；点「▶」切到那一段调起止`}>
        <Button size="small" onClick={() => splitAtPlayheadRef.current()}>✂ 在播放线处拆开</Button>
      </Tooltip>
      {panelItems.length > 1 && (
        <Typography.Link style={{ fontSize: 12 }} onClick={() => setPiecesOpen(!piecesOpen)}>
          {segReview ? `拆成了 ${panelItems.length} 段` : `这段时间里 ${panelItems.length} 段`}
          {piecesOpen ? " ▴ 收起" : " ▸ 展开逐段改类别 / 调起止"}
        </Typography.Link>
      )}
    </>
  );
  const splitPiecesList = panelItems.length > 1 && piecesOpen ? (
    <div style={{ width: "100%", borderTop: "1px dashed var(--sl-border2)", paddingTop: 4, marginTop: 4, maxHeight: 156, overflowY: "auto" }}>
      {panelItems.map((it, k) => {
        const cur = loopInfo?.itemId === it.id;
        return (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "1px 0",
            background: cur ? "rgba(114,46,209,.08)" : undefined }}>
            <span style={{ width: 16, color: "#888" }}>{k + 1}</span>
            <Tooltip title="浮窗切到这一段：拖两边的竖线调起止，点「保存起止」">
              <Button size="small" type="link" style={{ padding: 0 }}
                onClick={() => showRange({ startMs: it.start_time_ms, endMs: it.end_time_ms })}>
                {cur ? "▶ 当前" : "▶ 切到"}
              </Button>
            </Tooltip>
            <span style={{ fontFamily: "monospace" }}>
              {formatMs(it.start_time_ms)} → {formatMs(it.end_time_ms)}
            </span>
            <span style={{ color: "#888" }}>{((it.end_time_ms - it.start_time_ms) / 1000).toFixed(1)}s</span>
            <LabelTreeSelect
              labels={labels}
              style={{ width: 150, marginLeft: "auto" }}
              value={it.label_id}
              recent={recentLabels(task?.project_id)}
              onChange={(v) => { rememberLabel(task?.project_id, v); relabelFromMenu(it, v); }}
            />
            {!readOnly && (
              <Button size="small" type="link" danger style={{ padding: 0 }}
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}>
                删
              </Button>
            )}
            {readOnly && canFlag && !segReview && (
              <Popconfirm title="删掉这一段？" description="直接从库里删（不用认领）" okText="删除"
                okButtonProps={{ danger: true }} onConfirm={() => deleteItemRemote(it)}>
                <Button size="small" type="link" danger style={{ padding: 0 }}>删</Button>
              </Popconfirm>
            )}
          </div>
        );
      })}
    </div>
  ) : null;
  const splitPanel = (
    <div style={{ width: "100%", borderTop: "1px dashed var(--sl-border2)", paddingTop: 4, marginTop: 2 }}>
      <Space size={6} wrap style={{ marginBottom: splitPiecesList ? 2 : 0 }}>
        {splitControls}
      </Space>
      {splitPiecesList}
    </div>
  );
  const waveReviewBar = (it: LabelItem, withSplit = false) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>这一条：</Typography.Text>
      <Tooltip title="复制这一段的链接：发给标注员，打开就直接循环这一段">
        <Button size="small" type="text" icon={<LinkOutlined />} onClick={() => copySegLink(it.id)} />
      </Tooltip>
      {it.seg_status === "approved" && <Tag color="success" style={{ marginInlineEnd: 0 }}>✓ 已通过</Tag>}
      {it.review_note && <Tag color="red" style={{ marginInlineEnd: 0 }}>退回：{it.review_note}</Tag>}
      {withSplit && splitControls}
      <span style={{ flex: 1 }} />
      {readOnly && (
        <Tooltip title="类别不对就在这里改（只读任务里也能改，不用认领）">
          <LabelTreeSelect
            labels={labels}
            style={{ width: 160 }}
            value={it.label_id}
            recent={recentLabels(task?.project_id)}
            onChange={(v) => { rememberLabel(task?.project_id, v); relabelItem(it, v); }}
          />
        </Tooltip>
      )}
      {!it.review_note && it.seg_status !== "approved" && (
        <Button size="small" type="primary" onClick={() => handleSegApprove(it, true)}>通过</Button>
      )}
      {readOnly && !segReview && (
        <Popconfirm
          title="删掉这一段？"
          description={it.from_candidate_id != null
            ? "重复的 / 不要的直接删（不用认领）。它是从疑似片段确认来的，那条候选会一起标成「排除」"
            : "重复的 / 不要的直接删（不用认领），标注员那边会同步"}
          okText="删除"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteItemRemote(it)}
        >
          <Tooltip title="删掉这一段（比如跟旁边那条完全重复）">
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Tooltip>
        </Popconfirm>
      )}
      {it.review_note ? (
        <Button size="small" onClick={() => handleReviewNote(it, null)}>清除问题</Button>
      ) : (
        <Dropdown
          menu={{
            items: REVIEW_NOTE_PRESETS.map((t) => ({ key: t, label: t })),
            onClick: ({ key }) => handleReviewNote(it, key),
          }}
        >
          <Button size="small" danger>有问题，退回 <DownOutlined /></Button>
        </Dropdown>
      )}
    </div>
  );

  // 存草稿时服务器说：有片段刚被别人（管理员）直接改过 / 拆过，保留了他的版本。
  // 这边手里那几条是旧的，重新拉一遍，不然下次看到的还是旧起止
  useEffect(() => {
    const onStale = (e: Event) => {
      const d = (e as CustomEvent<{ taskId: number; n: number }>).detail;
      if (taskId == null || d.taskId !== taskId) return;
      getDraft(taskId)
        .then((dr) => {
          loadItems(dr.items);
          message.info(`有 ${d.n} 段刚被管理员改过或通过，已按他的版本更新`);
        })
        .catch(() => {});
    };
    window.addEventListener(DRAFT_STALE_EVENT, onStale);
    return () => window.removeEventListener(DRAFT_STALE_EVENT, onStale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // 片段审核那边改了类别：重新拉草稿，片段列表 / 波形色块跟着变
  useEffect(() => {
    if (!segReview?.reloadKey || taskId == null) return;
    getDraft(taskId).then((d) => loadItems(d.items)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segReview?.reloadKey]);

  // 审核员 / 管理员在只读任务里改类别（走片段接口，不用认领）
  // 一键去重：服务器上做（只读的管理员也能用）；自己在编辑时先把手上的改动存了，免得被重拉冲掉
  const handleDedupe = async () => {
    if (taskId == null) return;
    if (!readOnly) await saveDraft(taskId, toDraftPayload(items));
    const r = await segDedupe(taskId);
    const d = await getDraft(taskId);
    loadItems(d.items);
    const n = r.merged + r.removed_parent;
    message.success(
      `${n ? `去掉 ${n} 段（合并同类 ${r.merged}、删父类 ${r.removed_parent}）` : "没有能自动去掉的重复"}` +
        (r.conflicts_left ? `；还有 ${r.conflicts_left} 段是不同类别冲突，要人看` : ""),
      4,
    );
  };
  // 只读（管理员 / 审核员旁观）时删一段：直接走片段接口删到库里，不用认领。
  // 正在循环它的话停掉循环，地址栏的 seg 也清掉
  const deleteItemRemote = async (it: LabelItem) => {
    if (taskId == null) return;
    await segDelete(it.id);
    if (loopInfo?.itemId === it.id) {
      setLoop(null);
      setStickyRange(null);
      setUrlSeg(null);
    }
    setSelSegId(null);
    const d = await getDraft(taskId);
    loadItems(d.items);
    message.success("已删除这一段");
  };
  // 波形上选中一段后按 Delete / 标题行的「删除」都走这里
  const deleteSelected = () => {
    const it = selSegId == null ? null : items.find((x) => x.id === selSegId);
    if (!it) return;
    if (!readOnly) {
      setSelSegId(null);
      setItems((prev) => prev.filter((x) => x.id !== it.id));
      message.success({ content: "已删除这一段（自动保存）", key: "del-seg" });
      return;
    }
    if (!canFlag) {
      message.info({ content: readOnlyHint, key: "del-seg" });
      return;
    }
    void deleteItemRemote(it);
  };
  const deleteSelectedRef = useRef(deleteSelected);
  deleteSelectedRef.current = deleteSelected;
  const selSegRef = useRef<number | null>(null);
  selSegRef.current = selSegId;
  // 只看模式下打标记：直接落库（标记只是记号，不用认领、不动类别起止）
  const marksRemote = async (it: LabelItem, marks: string[], note: string | null) => {
    const r = await segMarks(it.id, marks, note);
    setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, marks: r.marks, mark_note: r.mark_note } : x)));
    message.success(r.marks ? "已记备忘" : "已清掉备忘");
  };
  const relabelItem = async (it: LabelItem, labelId: number) => {
    if (taskId == null || labelId === it.label_id) return;
    if (win) {
      const insideRemote = await splitForWindowRemote(it, win);
      if (insideRemote) {
        await segEdit(insideRemote.id, { start_time_ms: insideRemote.start_time_ms, end_time_ms: insideRemote.end_time_ms, label_id: labelId });
        const d = await getDraft(taskId);
        loadItems(d.items);
        message.success(`已按窗口边界自动切分，仅将窗内部分改为「${nameOf(labelId)}」（窗外保持原样）`);
        return;
      }
    }
    await segEdit(it.id, { start_time_ms: it.start_time_ms, end_time_ms: it.end_time_ms, label_id: labelId });
    const d = await getDraft(taskId);
    loadItems(d.items);
    message.success(`已改成「${nameOf(labelId)}」`);
  };

  // 浮窗里保存起止：片段审核那条走 /segments 接口（审核员不用认领整个任务）；其它走存草稿
  // 保存起止出错 / 超时：不知道服务器到底存没存上。重新拉一次看实际的起止，明确告诉人
  const adjustFromWave = async (target: AdjustTarget, startMs: number, endMs: number) => {
    try {
      await adjustFromWaveInner(target, startMs, endMs);
    } catch (e) {
      if (target.kind !== "item" || taskId == null) throw e;
      try {
        const d = await getDraft(taskId);
        const it = d.items.find((x) => x.id === target.id);
        if (it && Math.abs(it.start_time_ms - startMs) < 2 && Math.abs(it.end_time_ms - endMs) < 2) {
          loadItems(d.items);
          showRange({ startMs, endMs });
          message.success({ content: "刚才服务器回得慢，但起止其实已经保存上了", key: "timeout" });
          return;
        }
        message.warning({ content: "起止没保存上（还是原来的），多半是这条正被别的操作锁着。等一会再点一次「保存起止」；一直不行看「系统监控」里谁在等锁", key: "timeout", duration: 8 });
      } catch {
        /* 连草稿都拉不到：服务器整个没响应，上面已经提示过了 */
      }
      throw e;
    }
  };

  // 片段接口存完：先用它返回的起止把这一条改了（立刻看到），再在后台把整份草稿拉一遍对齐
  // （起止调过几次、审核状态这些）。原来是等整份草稿重拉完才算存好——老项目一个任务几十上百段，
  // 每点一次保存都要多等一两秒
  const savedLocally = (id: number, r: { start_time_ms: number; end_time_ms: number; label_id: number; seg_status: string }) => {
    setItems((prev) => prev.map((it) => (it.id === id
      ? { ...it, start_time_ms: r.start_time_ms, end_time_ms: r.end_time_ms, label_id: r.label_id,
          seg_status: (r.seg_status === "pending" ? null : r.seg_status) as LabelItem["seg_status"] }
      : it)));
    if (taskId != null) getDraft(taskId).then((d) => loadItems(d.items)).catch(() => { /* 对齐失败就用本地这份，下次打开会重拉 */ });
  };

  // 管理员 / 审核员在只读任务里改起止，后端直接算「通过」（改过的就是认可的版本）。
  // 可能手滑拖错了：提示里给两个后悔药——「撤回」= 起止和审核状态都还原；「只撤销通过」= 起止留着、回到待审
  const savedWithUndo = (prev: LabelItem | undefined, r: { start_time_ms: number; end_time_ms: number; label_id: number; seg_status: string }) => {
    if (!prev) return message.success("起止已保存");
    const key = `undo-${prev.id}`;
    const wasApproved = prev.seg_status === "approved";
    const nowApproved = r.seg_status === "approved";
    const undo = async () => {
      message.destroy(key);
      const back = await segEdit(prev.id, { start_time_ms: prev.start_time_ms, end_time_ms: prev.end_time_ms });
      let st = back.seg_status;
      if (!wasApproved && st === "approved") st = (await segDecide(prev.id, "pending")).seg_status;
      savedLocally(prev.id, { ...back, seg_status: st });
      showRange({ startMs: prev.start_time_ms, endMs: prev.end_time_ms });
      message.success("已撤回：起止和审核状态都还原了");
    };
    const unapprove = async () => {
      message.destroy(key);
      const d = await segDecide(prev.id, "pending");
      savedLocally(prev.id, { ...r, seg_status: d.seg_status });
      message.success("起止留着，这一条回到待审");
    };
    message.success({
      key, duration: 8,
      content: (
        <span>
          起止已保存{nowApproved && !wasApproved ? "，并自动算「通过」" : ""}
          <Button size="small" type="link" onClick={undo}>撤回</Button>
          {nowApproved && !wasApproved && <Button size="small" type="link" onClick={unapprove}>只撤销通过</Button>}
        </span>
      ),
    });
  };

  const adjustFromWaveInner = async (target: AdjustTarget, startMs: number, endMs: number) => {
    // 审核员 / 管理员看只读的任务（已提交的、别人的）：直接改这一条，走片段接口，
    // 不用为了调个起止去认领整个任务
    if (readOnly && canFlag && !segReview && target.kind === "item" && taskId != null) {
      const prev = items.find((x) => x.id === target.id);
      const r = await segEdit(target.id, { start_time_ms: startMs, end_time_ms: endMs });
      savedLocally(target.id, r);
      showRange({ startMs, endMs });
      savedWithUndo(prev, r);
      return;
    }
    if (segReview && target.kind === "item" && target.id === segReview.itemId && taskId != null) {
      await segReview.onEdit(startMs, endMs);
      const d = await getDraft(taskId);
      loadItems(d.items);
      showRange({ startMs, endMs });
      message.success("起止已保存");
      return;
    }
    if (segReview && target.kind === "item" && inGroup(target.id) && taskId != null) {
      // 拆出来的其它几段：直接走片段接口
      const prev = items.find((x) => x.id === target.id);
      const r = await segEdit(target.id, { start_time_ms: startMs, end_time_ms: endMs });
      savedLocally(target.id, r);
      showRange({ startMs, endMs });
      savedWithUndo(prev, r);
      return;
    }
    await adjustBoundary(target, startMs, endMs);
  };

  const updateItems = (ids: number[], patch: Partial<LabelItem>) => {
    const set = new Set(ids);
    if (win && !readOnly && (patch.label_id != null || patch.ai_confirmed === true)) {
      let didSplit = false;
      setItems((prev) =>
        prev.flatMap((it) => {
          if (!set.has(it.id)) return [it];
          const sp = splitForWindowLocal(it, win, patch);
          if (sp) {
            didSplit = true;
            return sp.pieces;
          }
          return [touchItem(it, patch)];
        }),
      );
      if (didSplit) {
        message.info({ content: "已按窗口边界自动切分，仅修改窗内部分（窗外保持原样）", key: "win-split" });
      }
      return;
    }
    setItems((prev) => prev.map((it) => (set.has(it.id) ? touchItem(it, patch) : it)));
  };

  // 在波形上直接拖出来一段（参考工具的主要标注方式）。
  // label-studio 式：没选类别也能先拖，拖完向上弹类别，选完才落段
  const handleCreateFromChart = (startMs: number, endMs: number) => {
    if (labelId != null) {
      appendItem(startMs, endMs, labelId);
      return;
    }
    setPendingSpan({ startMs: Math.round(startMs), endMs: Math.round(endMs) });
    setLabelsOpen(true);
    setMarkStartMs(null);
  };

  // 拖已有色块改时间：整段平移也从这里走（起点终点一起变）。
  // 可编辑时只改本地，等「保存草稿」一起落；只读但能审（管理员/审核员）的直接调片段接口
  const handleResizeFromChart = (index: number, startMs: number, endMs: number) => {
    const it = items[index];
    const s = Math.round(Math.max(0, startMs)), e = Math.round(Math.max(0, endMs));
    if (!it) return;
    warnOverlap(it.label_id, s, e, it.id);
    if (!readOnly) {
      setItems((prev) =>
        prev.map((x, i) => (i === index ? touchItem(x, { start_time_ms: s, end_time_ms: e }) : x))
      );
      return;
    }
    if (!it || it.id <= 0 || taskId == null) return;
    if (segReview && it.id === segReview.itemId) {
      void (async () => {
        await segReview.onEdit(s, e);
        loadItems((await getDraft(taskId)).items);
        showRange({ startMs: s, endMs: e });
        message.success("起止已保存");
      })();
      return;
    }
    if (!(segReview ? inGroup(it.id) : canFlag)) return;
    void (async () => {
      try {
        const r = await segEdit(it.id, { start_time_ms: s, end_time_ms: e });
        savedLocally(it.id, r);
        showRange({ startMs: s, endMs: e });
        savedWithUndo(it, r);
      } catch {
        /* request 拦截器已经弹了错误 */
      }
    })();
  };

  // 拆片段：一段从 atMs 处切成两段，类别不变（右半段要换类别就选中它按标签键 / 在列表里改）。
  // 左半段就是原来那条（AI 的会记成「已纠正」），右半段是新加的人工片段。两边至少留 0.3 秒
  const SPLIT_MIN_MS = 300;
  const splitItem = (index: number, atMs: number) => {
    const it = items[index];
    if (!it) return;
    const at = Math.round(atMs);
    if (at - it.start_time_ms < SPLIT_MIN_MS || it.end_time_ms - at < SPLIT_MIN_MS) {
      message.info({ content: "离起点或终点太近（< 0.3 秒），往中间点一点再拆", key: "split" });
      return;
    }
    if (readOnly) {
      // 任务已提交 / 不在名下：退回给我的那一条（或审核员看的任意一条）走片段接口拆，直接落库
      const allowed = segReview ? inGroup(it.id) : canFlag;
      if (!allowed || taskId == null) {
        message.info({
          content: segReview ? "这里只能拆退回给你的那一条（和从它拆出来的几段）" : readOnlyHint,
          key: "split",
        });
        return;
      }
      void (async () => {
        try {
          const r = await segSplit(it.id, at);
          const list = (await getDraft(taskId)).items;
          loadItems(list);
          if (segReview) {
            setSplitGroup((g) => (g.includes(r.right.id) ? g : [...g, r.right.id]));
            // 浮窗接着循环刚才那一段的左半段，方便接着往下切
            if (loopInfo?.itemId === it.id) showRange({ startMs: it.start_time_ms, endMs: at });
            syncMain(list);
          }
          message.success({ content: `已拆成两段（${(it.start_time_ms / 1000).toFixed(1)}–${(at / 1000).toFixed(1)} s ｜ ${(at / 1000).toFixed(1)}–${(it.end_time_ms / 1000).toFixed(1)} s），已保存，两段都交回重审`, key: "split", duration: 5 });
        } catch {
          /* request 拦截器已经弹了错误 */
        }
      })();
      return;
    }
    const right: LabelItem = {
      ...it,
      id: -Date.now(),
      start_time_ms: at,
      origin_item_id: null,
      source_type: "human_added",
      is_modified: false,
      ai_confidence: null,
      ai_confirmed: false,
      from_candidate_id: null,
      created_by: null,
    };
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === it.id);
      if (i < 0) return prev;
      const next = [...prev];
      next[i] = touchItem(prev[i], { end_time_ms: at });
      next.splice(i + 1, 0, right);
      return next;
    });
    // 浮窗正看着这一段：跟到左半段，接着往下拆 / 调起止，循环区间跟片段对得上
    if (loopInfo?.itemId === it.id) showRange({ startMs: it.start_time_ms, endMs: at });
    const fmt = (ms: number) => (ms / 1000).toFixed(1);
    message.success({
      content: `已拆开「${nameOf(it.label_id)}」：${fmt(it.start_time_ms)}–${fmt(at)} s ｜ ${fmt(at)}–${fmt(it.end_time_ms)} s（自动保存，右半段要换类别在右侧列表改）`,
      key: "split",
      duration: 4,
    });
  };
  // Alt+S：从视频播放线的位置拆开它压着的那段（几段叠着时优先当前选中标签那一类，再取最短的）
  const splitAtPlayhead = () => {
    const at = curSecRef.current * 1000;
    const hits = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.start_time_ms < at && at < it.end_time_ms)
      // 从「退回给我的片段」打开的：只拆那一条（和它拆出来的几段）；浮窗开着时优先拆浮窗里这一组
      .filter(({ it }) => (segReview ? inGroup(it.id) : !panelIds.size || panelIds.has(it.id)));
    if (!hits.length) {
      message.info({ content: "播放线没压在任何片段上：先把视频停到要切的位置", key: "split" });
      return;
    }
    hits.sort((a, b) =>
      Number(b.it.label_id === labelId) - Number(a.it.label_id === labelId) ||
      (a.it.end_time_ms - a.it.start_time_ms) - (b.it.end_time_ms - b.it.start_time_ms));
    splitItem(hits[0].i, at);
  };

  const splitAtPlayheadRef = useRef(splitAtPlayhead);
  splitAtPlayheadRef.current = splitAtPlayhead;

  // 边播边标：选好标签，看到动作开始按 [（或点「标起点」），结束按 ]（或「标终点」），中间这段就建好了。
  // 从零标注时比在波形上拖准（对着视频按），也不用停下来
  const [markStartMs, setMarkStartMs] = useState<number | null>(null);
  const fmtMs = (ms: number) => {
    const t = Math.max(0, ms) / 1000, h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
  };
  const markAt = (which: "start" | "end") => {
    const now = Math.round(curSecRef.current * 1000);
    if (which === "start" || markStartMs == null) {
      setMarkStartMs(now);
      message.info({
        content: labelId == null
          ? `起点 ${fmtMs(now)}，看到结束时按 ]，再选类别`
          : `起点 ${fmtMs(now)}，看到结束时按 ] 或点「标终点」`,
        key: "mark",
      });
      return;
    }
    const a = Math.min(markStartMs, now), b = Math.max(markStartMs, now);
    if (b - a < 200) {
      message.info({ content: "起止太近（不到 0.2 秒），没建", key: "mark" });
      return;
    }
    setMarkStartMs(null);
    if (labelId == null) {
      // 先拉后选：区间先挂起，类别弹窗里点一下再建
      setPendingSpan({ startMs: a, endMs: b });
      setLabelsOpen(true);
      message.info({ content: `片段 ${fmtMs(a)} ~ ${fmtMs(b)}，选个类别就建好`, key: "mark" });
      return;
    }
    appendItem(a, b, labelId);
    message.success({ content: `已标 ${nameOf(labelId)} ${fmtMs(a)} ~ ${fmtMs(b)}`, key: "mark" });
  };
  const markAtRef = useRef(markAt);
  markAtRef.current = markAt;

  // ── 疑似片段确认后跟已有片段重叠 ──
  // 同一轨不同类别压在一起是矛盾标注：提交会被拦，导出时重叠那一截两边都挖掉（白白少了数据）。
  // 确认时就提示，并给一键「裁掉旧片段被盖住的部分」：新确认的是人刚看过的，以它为准
  const OVERLAP_MIN_KEEP_MS = 300;
  const trimUnder = (list: LabelItem[], fresh: LabelItem, victims: Set<number>): LabelItem[] => {
    const out: LabelItem[] = [];
    let k = 0;
    for (const it of list) {
      if (!victims.has(it.id)) {
        out.push(it);
        continue;
      }
      const s0 = it.start_time_ms, e0 = it.end_time_ms, s1 = fresh.start_time_ms, e1 = fresh.end_time_ms;
      // 旧片段在新片段左边露出来的部分、右边露出来的部分，太短（< 0.3 s）的就不要了
      const left = s0 < s1 ? [s0, Math.min(e0, s1)] : null;
      const right = e0 > e1 ? [Math.max(s0, e1), e0] : null;
      const parts = [left, right].filter((x): x is number[] => !!x && x[1] - x[0] >= OVERLAP_MIN_KEEP_MS);
      parts.forEach((pp, idx) => {
        if (idx === 0) out.push(touchItem(it, { start_time_ms: pp[0], end_time_ms: pp[1] }));
        else out.push({ ...touchItem(it, {}), id: -Date.now() - ++k, start_time_ms: pp[0], end_time_ms: pp[1],
          origin_item_id: null, source_type: "human_added", ai_confidence: null, ai_confirmed: false,
          from_candidate_id: null, created_by: null, is_modified: false });
      });
    }
    return out;
  };
  const checkOverlapAfterConfirm = (list: LabelItem[], candId: number) => {
    const fresh = list.find((x) => x.from_candidate_id === candId);
    if (!fresh || taskId == null) return;
    const hit = list.filter((x) => x.id !== fresh.id
      && x.start_time_ms < fresh.end_time_ms && fresh.start_time_ms < x.end_time_ms
      && labelsConflict(labelById, x.label_id, fresh.label_id));
    if (!hit.length) return;
    const fmt = (it: LabelItem) => `「${nameOf(it.label_id)}」${formatMs(it.start_time_ms)} → ${formatMs(it.end_time_ms)}`;
    Modal.confirm({
      title: `新确认的「${nameOf(fresh.label_id)}」跟 ${hit.length} 段已有片段时间重叠`,
      width: 520,
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 6 }}>
            同一轨上不同类别压在一起是矛盾标注：<b>提交会被拦</b>，导出训练集时重叠那一截两边都会被挖掉。
          </div>
          <div style={{ color: "#888", marginBottom: 4 }}>新片段：{fmt(fresh)}</div>
          {hit.map((h) => (
            <div key={h.id}>
              · {fmt(h)}
              {h.start_time_ms >= fresh.start_time_ms && h.end_time_ms <= fresh.end_time_ms
                ? <Tag color="red" style={{ marginLeft: 6 }}>整段被盖住，会删掉</Tag>
                : h.start_time_ms < fresh.start_time_ms && h.end_time_ms > fresh.end_time_ms
                  ? <Tag color="orange" style={{ marginLeft: 6 }}>会拆成前后两段</Tag>
                  : <Tag style={{ marginLeft: 6 }}>只裁掉重叠部分</Tag>}
            </div>
          ))}
          <div style={{ marginTop: 6, color: "#888" }}>以新确认的为准：旧片段被盖住的部分裁掉，露在外面的保留（短于 0.3 秒的不留）。</div>
        </div>
      ),
      okText: "裁掉旧片段被盖住的部分",
      cancelText: "先不管，我自己改",
      onOk: async () => {
        const next = trimUnder(list, fresh, new Set(hit.map((h) => h.id)));
        await saveDraft(taskId, toDraftPayload(next));
        loadItems((await getDraft(taskId)).items);
        message.success("已裁好，重叠没有了");
      },
    });
  };

  // 草稿的 payload 形状，存草稿的几个地方都用它——以前是各写一份，
  // 加字段时漏掉一处就会静默丢数据
  const toDraftPayload = (list: typeof items) => list.map((i) => ({
        label_id: i.label_id,
        start_time_ms: i.start_time_ms,
        end_time_ms: i.end_time_ms,
        origin_item_id: i.origin_item_id ?? undefined,
        // 新增条目要带上来源，AI 预标注出来的才能在库里记成 ai_generated
        source_type: i.origin_item_id == null ? i.source_type : undefined,
        ai_confidence: i.origin_item_id == null ? i.ai_confidence : undefined,
        ai_confirmed: i.ai_confirmed,
        uncertain: i.uncertain,
        uncertain_reason: i.uncertain_reason,
        // 空串 = 没有标记（后端会清掉）；不能不传，不然清掉的标记存不回去
        marks: i.marks ?? "",
        mark_note: i.mark_note ?? "",
      }));

  const persist = async () => {
    if (taskId == null) return;
    const snapshot = items;
    await saveDraft(taskId, toDraftPayload(snapshot));
    serverItemsRef.current = snapshot;
    // 存完通知外面刷一遍列表。原来只有「提交」才通知，于是存草稿之后回到列表，
    // 段数、类别汇总全是旧的——人刚标完 3 段「抓挠-躯干」，列表里一条没有，
    // 只能以为没存上。存草稿是最常用的那个动作，它才最该刷新
    onSaved?.();
  };

  // 人工标注自动保存：本地改动（新建、改起止、挪整段、删除、改类别、拆开）停下
  // 0.8 秒就落草稿，不用每次手动点「存草稿」。从服务端拉回来的片段不算改动
  // （loadItems 会同步 serverItemsRef），所以打开任务、别人改过之后的同步都不会空转
  useEffect(() => {
    if (readOnly || taskId == null) return;
    if (items === serverItemsRef.current) return;
    const snapshot = items;
    const timer = window.setTimeout(async () => {
      try {
        await saveDraft(taskId, toDraftPayload(snapshot));
        serverItemsRef.current = snapshot;
        onSaved?.();
      } catch {
        message.error({
          content: "片段自动保存失败，改动还在本地，可以点「存草稿」重试",
          key: "autosave",
        });
      }
    }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, readOnly, taskId]);

  // AI 预标注：后端转发到 imu_train/label_service 的 /infer，返回的类别名按
  // 标签的显示名（退一步按 code）匹配到项目标签，匹配不上的类别整体跳过并提示。
  const handleAiPrelabel = async () => {
    if (sampleId == null) return;
    setPrelabeling(true);
    try {
      const res = await aiPrelabel(sampleId, prelabelMode, taskId ?? undefined);
      // 重新跑过了，标签上的版本/模型/时间也得跟着变
      getAiLabelInfo(sampleId).then(setAiInfo).catch(() => {});
      const byName = new Map<string, number>();
      labels.forEach((l) => {
        byName.set(l.display_name, l.id);
        if (!byName.has(l.code)) byName.set(l.code, l.id);
      });
      const unmatched = new Set<string>();
      const base = -Date.now();
      const created: LabelItem[] = [];
      res.items.forEach((it, idx) => {
        const lid = byName.get(it.label_name);
        if (lid == null) {
          unmatched.add(it.label_name);
          return;
        }
        created.push({
          id: base - idx,
          label_id: lid,
          start_time_ms: it.start_time_ms,
          end_time_ms: it.end_time_ms,
          origin_item_id: null,
          source_type: "ai_generated",
          uncertain: false,
          uncertain_reason: null,
          from_candidate_id: null,
          is_modified: false,
          ai_confidence: it.confidence,
          ai_confirmed: false,
          created_by: null,
        });
      });
      // 只清掉"没人碰过"的 AI 片段，然后填新的。
      // 之前的写法是 `source_type !== ai_generated || origin_item_id != null`——
      // 意思是"已经存过库的 AI 片段"也留着，于是重跑一次就在旧的上面又叠一层，
      // 13 段变 78 段。人工碰过的（确认过/改过/标了待定/自己画的）必须留下：
      // 那是复看的成果，重跑一次模型不能把它抹掉。
      const untouchedAi = (i: LabelItem) =>
        i.source_type === "ai_generated" && !i.ai_confirmed && !i.is_modified && !i.uncertain;
      const kept = items.filter((i) => !untouchedAi(i));
      // 新结果里跟"人工已经定过"的片段撞在一起的，多半是同一段被这一版又标了
      // 一遍。不自动删——起止可能不一样，值得对比——但要标出来让人一眼看见
      const overlaps = (a: LabelItem, b: LabelItem) =>
        a.start_time_ms < b.end_time_ms && b.start_time_ms < a.end_time_ms && labelsRelated(labelById, a.label_id, b.label_id);
      const dup = new Set<number>();
      for (const c of created) {
        if (kept.some((k) => overlaps(c, k))) dup.add(c.id);
      }
      setDupIds(dup);
      setItems([...kept, ...created]);
      const parts = [`AI 预标注完成：填入 ${created.length} 段`];
      if (kept.length) parts.push(`保留了 ${kept.length} 段人工确认/修改过的`);
      if (dup.size) parts.push(`其中 ${dup.size} 段跟人工片段重叠，已标「疑似重复」`);
      if (unmatched.size) parts.push(`类别「${[...unmatched].join("、")}」没有对应标签，已跳过`);
      if (res.skipped) parts.push(`${res.skipped} 段时间无效已忽略`);
      if (taskId != null) listCandidates(taskId).then(setCandidates).catch(() => {});
      if (unmatched.size || res.skipped) message.warning(parts.join("；"), 6);
      else message.success(parts[0]);
    } finally {
      setPrelabeling(false);
    }
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    try {
      await persist();
      message.success("草稿已保存");
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (taskId == null) return;
    setSaving(true);
    try {
      await persist();
      await submitTask(taskId);
      message.success("已提交，等待审核");
      onSubmitted?.();
      handleClose();
    } finally {
      setSaving(false);
    }
  };

  // 只认某一类：外面把草稿改完了，这里重新拉一遍，列表上的「AI 待确认」
  // 立刻变成「AI 已确认」，不用关掉再进来
  const handleConfirmScratch = async () => {
    if (taskId == null || !onConfirmScratch) return;
    setSaving(true);
    try {
      // 可编辑状态下刚改的东西还只在本地，先落草稿——外面那个确认读的是
      // 服务端草稿，不先存的话刚改的类别会被覆盖回去
      if (!readOnly) await persist();
      await onConfirmScratch();
      // 重新拉草稿不等它：确认完多半就关掉这个任务去看下一段了，为一次
      // 「可能根本用不上」的刷新让人多转一圈不值当。工作台留着不关的话，
      // 它回来时再把片段更新上
      void getDraft(taskId)
        .then((d) => loadItems(d.items))
        .catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitAndApprove = async () => {
    if (taskId == null || !onApprove) return;
    setSaving(true);
    try {
      await persist();
      await onApprove();
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const el = chartBoxRef.current;
    if (!el || (!chartExpanded && !chartDual)) return;
    const ro = new ResizeObserver(() => setChartBoxH(el.clientHeight));
    ro.observe(el);
    setChartBoxH(el.clientHeight);
    return () => ro.disconnect();
  }, [chartExpanded, chartDual, imuView, videos]);

  // 紧凑模式下通道名画进图里，没有额外的标题行，height 本身已含时间轴
  const CHANNEL_CHROME_PX = 4;
  // 六条一定要塞进一屏的话，一条就只剩十几像素——曲线压成一条线，什么都看不出来，
  // 等于白展开。所以给一条波形定一个"还看得清"的下限，剩下的宁可让波形区自己滚：
  // 看得清的三条 + 滚一下，比六条糊成六道杠有用
  const MIN_ROW_PX = 86;
  const expandedRowHeight = Math.max(
    MIN_ROW_PX,
    Math.floor((chartBoxH - 24) / 6) - CHANNEL_CHROME_PX
  );
  // 双波形：上下各一张单通道，高度对半分；标题行和日期行各占一点
  const dualRowHeight = Math.max(
    56,
    Math.floor((chartBoxH || chartHeight) / 2) - 40
  );

  // 拖波形区（单条波形模式）底边的把手改高度，跟视频区的把手一个用法；
  // 拖的过程只更新状态，松手才写 localStorage
  const handleChartResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = chartBoxRef.current?.getBoundingClientRect().height ?? chartHeight;
    // 能拖多高 = 现在这么高 + 上面还能挤出来的空间。以前写死 innerHeight-260，
    // 跟实际布局没关系：视频区一高，波形拖到一半底边就滑到屏幕外面去了，
    // 把手也跟着看不见。现在按实际量：视频还能压缩多少（到它的下限为止）
    // 加上这一屏本来就空着的部分。
    const bodyEl = chartBoxRef.current?.closest(".ws-body") as HTMLElement | null;
    const videoEl = bodyEl?.querySelector(".ws-videos") as HTMLElement | null;
    const VIDEO_MIN_PX = 200;
    const slack =
      (videoEl ? Math.max(0, videoEl.getBoundingClientRect().height - VIDEO_MIN_PX) : 0) +
      (bodyEl ? Math.max(0, bodyEl.clientHeight - bodyEl.scrollHeight) : 0);
    const maxHeight = Math.max(120, startHeight + slack);
    let latest = startHeight;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(maxHeight, Math.max(80, startHeight + (ev.clientY - startY)));
      setChartHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveHeight(chartHeightKey, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 数字/字母键快速切标签，跟参考工具一样，标注时手不用离开键盘
  useEffect(() => {
    // 只读时只留 Alt+S（退回给我的那条 / 审核员能拆），标签快捷键不要
    const canSplit = !readOnly || !!segReview || canFlag;
    if (taskId == null || !canSplit) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Alt+S：在播放线处拆开片段。按 code 认：Mac 上 Alt+S 的 e.key 是「ß」
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyS") {
        e.preventDefault();
        splitAtPlayheadRef.current();
        return;
      }
      // Delete / Backspace：删掉波形上选中的那一段
      if ((e.key === "Delete" || e.key === "Backspace") && selSegRef.current != null) {
        e.preventDefault();
        deleteSelectedRef.current();
        return;
      }
      if (!canCreate) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // 取消选中 -> 回到拖动平移模式；正在边播边标的也一起取消，拉了一半的也丢掉
        setLabelId(null);
        setMarkStartMs(null);
        setPendingSpan(null);
        setLabelsOpen(false);
        setSelSegId(null);
        return;
      }
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        markAtRef.current(e.key === "[" ? "start" : "end");
        return;
      }
      const k = e.key.toLowerCase();
      for (let r = 0; r < labelRows.length; r++) {
        const idx = ROW_KEYS[r].indexOf(k);
        if (idx < 0 || idx >= labelRows[r].items.length) continue;
        e.preventDefault();
        const id = labelRows[r].items[idx].id;
        // 刚拉出来一段还没选类别：这一下是给它选类别
        if (commitPendingRef.current(id)) {
          setLabelsOpen(false);
          return;
        }
        // 再按一次同一个键就取消选中，跟点按钮的行为一致
        setLabelId((prev) => (prev === id ? null : id));
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, readOnly, labelRows, !!segReview, canFlag, canCreate]);

  // ── 下面四个面板 ─────────────────────────────────────────────────────
  // 每个面板一个 Collapse，按 panelOrder 的顺序摆，panelHidden 里的不摆。
  // 面板标题右边有「上移 / 下移 / 隐藏」三个小按钮；隐藏了的在面板区上方留一个
  // 「已隐藏」标签，点一下恢复。顺序、隐藏、展开状态都记在 localStorage 里。
  const hasCross = !!(cross && (cross.items.length || cross.note));
  const hasEval = !!focusWindow?.evalHint;
  const [evalOnlyErr, setEvalOnlyErr] = useState(true);
  // 「只标窗口」顶层提示气泡（挂在标题栏橙色胶囊下方，zIndex 高于波形/视频浮窗）：
  // 没点过「知道了 / ×」时首次打开自动展开，点了收起并记住；之后点标题栏橙色胶囊随时展开/收起
  const [winHintOpen, setWinHintOpen] = useState(false);
  useEffect(() => {
    if (!taskId || !win || hasEval) { setWinHintOpen(false); return; }
    try {
      setWinHintOpen(localStorage.getItem("ws-win-hint-ack") !== "1");
    } catch {
      setWinHintOpen(true);
    }
  }, [taskId, win?.s, win?.e, hasEval]);
  const dismissWinHint = () => {
    setWinHintOpen(false);
    try { localStorage.setItem("ws-win-hint-ack", "1"); } catch { /* 隐私模式 */ }
  };
  // 当前任务里实际存在的面板（没跑过画面对照 / 不是从模型测试打分进来的就不显示对应面板），按用户顺序
  const presentPanels: PanelKey[] = panelOrder.filter((k) => (k !== "cross" || hasCross) && (k !== "eval" || hasEval));
  const shownPanels = presentPanels.filter((k) => !panelHidden.includes(k));
  /** 折叠掉的面板标签。查看模式下跟「新建片段」挤一行，不单独占一行把下面的面板区往下压 */
  const hiddenPanelKeys = panelHidden.filter((k) => presentPanels.includes(k));
  const hiddenPanelTags = hiddenPanelKeys.map((k) => (
    <Tooltip key={k} title="点一下恢复显示">
      <Tag style={{ cursor: "pointer" }} onClick={() => showPanel(k)}>{PANEL_TITLES[k]}</Tag>
    </Tooltip>
  ));
  // IMU 波形排在最前面时钉在滚动区外面（跟原来一样：波形要跟视频一起盯着看，
  // 翻列表时不能被滚走）；挪到别的位置就跟其他面板一起在滚动区里
  const pinnedImu = shownPanels[0] === "imu";
  const isPanelOpen = (k: PanelKey) => (k === "imu" ? imuOpen : panelKeys.includes(k));
  const anyOpenInside = shownPanels.some((k) => !(pinnedImu && k === "imu") && isPanelOpen(k));
  const setPanelOpen = (k: PanelKey, open: boolean) => {
    if (k === "imu") {
      saveBool(IMU_OPEN_KEY, open);
      setImuOpen(open);
      return;
    }
    const next = open ? [...panelKeys.filter((x) => x !== k), k] : panelKeys.filter((x) => x !== k);
    setPanelKeys(next);
    saveKeys(PANELS_KEY, next);
  };
  const movePanel = (k: PanelKey, dir: "up" | "down") => {
    const next = moveAmongShown(panelOrder, shownPanels, k, dir);
    setPanelOrder(next);
    saveOrder(next);
  };
  const hidePanel = (k: PanelKey) => {
    const next = [...panelHidden.filter((x) => x !== k), k];
    setPanelHidden(next);
    saveHidden(next);
  };
  const showPanel = (k: PanelKey) => {
    const next = panelHidden.filter((x) => x !== k);
    setPanelHidden(next);
    saveHidden(next);
  };
  // 点类别标签进来：把要看的那个面板亮出来
  useEffect(() => {
    if (!jumpToFocus || taskId == null) return;
    const k: PanelKey = focusCandLabels?.length ? "cands" : "segs";
    if (panelHidden.includes(k)) showPanel(k);
    if (!isPanelOpen(k)) setPanelOpen(k, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, jumpToFocus]);
  // 从模型测试打分进来：确保底部的「识别错误对照」面板自动展开可见
  useEffect(() => {
    if (!hasEval || taskId == null) return;
    if (panelHidden.includes("eval")) showPanel("eval");
    if (!isPanelOpen("eval")) setPanelOpen("eval", true);
    setEvalOnlyErr(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, hasEval]);
  const panelTools = (k: PanelKey) => {
    const i = shownPanels.indexOf(k);
    return (
      <span className="ws-panel-tools" onClick={(e) => e.stopPropagation()}>
        <Tooltip title="往上挪一格（会记住）">
          <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={i <= 0} onClick={() => movePanel(k, "up")} />
        </Tooltip>
        <Tooltip title="往下挪一格（会记住）">
          <Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={i < 0 || i >= shownPanels.length - 1} onClick={() => movePanel(k, "down")} />
        </Tooltip>
        <Tooltip title="隐藏这个面板（会记住）。面板区上方会留一个「已隐藏」标签，点它恢复">
          <Button type="text" size="small" icon={<EyeInvisibleOutlined />} onClick={() => hidePanel(k)} />
        </Tooltip>
      </span>
    );
  };

  // 类别选择往上弹：不再把下面的波形挤出一块；换个类别 / 先拉片段再选都从这里点
  const labelPicker = (
    <div style={{ maxWidth: 620, maxHeight: 300, overflow: "auto" }}>
      {pendingSpan && (
        <div style={{ marginBottom: 8, color: "#888", fontSize: 12 }}>
          已拉出 {formatMs(pendingSpan.startMs)} ~ {formatMs(pendingSpan.endMs)}，点下面类别就建好
        </div>
      )}
      <div style={{ marginBottom: 6, color: "#999", fontSize: 12 }}>
        点标签直接选（大级别也能选）；要往下看细分，点标签后面的 ▾ 展开
      </div>
      <Space wrap size={6}>
        {labelRows.map((row, r) => (
          <span key={row.parent?.id ?? "root"} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {row.parent && (
              <Tooltip title={`「${row.parent.display_name}」的子类。看得清就选具体的；看不清停在上级也行，标了细的自动算进上级`}>
                <span style={{ color: "#999", fontSize: 12, marginLeft: r > 1 ? 8 : 0 }}>
                  {shortName(labelById, row.parent)} ›
                </span>
              </Tooltip>
            )}
            {row.items.map((l, i) => {
              const selected = labelId === l.id;
              const onPath = !selected && selectedChain.has(l.id);
              const c = l.color || FALLBACK_COLORS[l.id % FALLBACK_COLORS.length];
              const kids = (labelChildren.get(l.id) ?? []).length;
              // 第一行：换到另一条互斥轨时插一个灰字组头（同轨互斥、跨轨可以同时标）
              const t = row.parent ? "" : trackOf(labelById, l.id);
              const prevT = row.parent || i === 0 ? null : trackOf(labelById, row.items[i - 1].id);
              const head = !row.parent && usedTracks.length > 1 && t && t !== prevT ? (
                <Tooltip key={`t:${t}`} title={`${TRACKS.find((x) => x.key === t)?.hint ?? ""}。同一轨的标签时间上互斥；不同轨的可以同时标（卧着 + 静止 + 舔前爪）`}>
                  <span style={{ color: "#999", fontSize: 12, marginLeft: i ? 10 : 0, borderLeft: i ? "1px solid #ddd" : undefined, paddingLeft: i ? 8 : 0 }}>
                    {TRACK_NAME[t]} ·
                  </span>
                </Tooltip>
              ) : null;
              return (
                <Fragment key={l.id}>
                {head}
                <Button
                  size="small"
                  onClick={() => {
                    // 拖着一段还没选类别：这次点击是给那段选类别，不是切换"下一个要标的类别"
                    if (commitPendingSpan(l.id)) {
                      setLabelsOpen(false);
                      return;
                    }
                    setLabelId(selected ? null : l.id);
                    setLabelsOpen(false);
                  }}
                  style={{
                    borderColor: c,
                    color: selected ? "#fff" : c,
                    background: selected ? c : tk.colorBgContainer,
                    fontWeight: selected || onPath ? 600 : 400,
                    boxShadow: onPath ? `inset 0 0 0 1px ${c}` : undefined,
                  }}
                >
                  {row.parent ? shortName(labelById, l) : l.display_name}
                  {kids > 0 && (
                    <span
                      title={expandPath.includes(l.id) ? "收起子类" : "展开子类（不影响当前选择的类别）"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(l);
                      }}
                      style={{
                        marginLeft: 4,
                        padding: "0 2px",
                        opacity: expandPath.includes(l.id) ? 1 : 0.65,
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      {expandPath.includes(l.id) ? "▴" : "▾"}
                    </span>
                  )}
                  {i < ROW_KEYS[r].length && (
                    <span style={{ marginLeft: 6, opacity: 0.65, fontSize: 11 }}>{ROW_KEYS[r][i]}</span>
                  )}
                </Button>
                </Fragment>
              );
            })}
          </span>
        ))}
        {labels.length === 0 && (
          <Typography.Text type="secondary">还没有标签，先去「标签管理」里建</Typography.Text>
        )}
      </Space>
    </div>
  );

  const imuItem = {
  key: "imu",
  label: (
    // 这排开关本来单独占一行。工作台里高度最紧，跟标题拼一行，
    // 省下来的给波形
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      onClick={(e) => e.stopPropagation()}
    >
      <span onClick={() => { const next = !imuOpen; saveBool(IMU_OPEN_KEY, next); setImuOpen(next); }} style={{ cursor: "pointer" }}>
        IMU 波形
      </span>
      {hasCsv && labels.length > 0 && (canCreate || roCreateAllowed) && (
        <Tooltip title="从零标注：AI 片段全部藏起来（波形和列表都不显示），只留人工标过的。在波形上拖一段，松手后选类别就建好；边播边标按 [ 开始、] 结束">
          <Button
            size="small"
            type={manualMode ? "primary" : "default"}
            icon={<EditOutlined />}
            onClick={() => {
              const next = !manualMode;
              setManualMode(next);
              // 查看模式下顺手打开新建：不然 AI 藏起来了却标不了
              if (next && roCreateAllowed && !roCreate) setRoCreate(true);
              if (next) message.info({ content: "从零标注：AI 片段已隐藏，在波形上拖一段，松手后选类别", key: "manual-mode" });
            }}
          >
            从零标注
          </Button>
        </Tooltip>
      )}
      {canCreate && !readOnly && hasCsv && sampleId != null && labels.length > 0 && (
        <>
          {/* AI 预标注原来单独占一行，挪到波形标题这排，省一行高度 */}
          <Popconfirm
            title={`用「${modeLabelOf(prelabelMode)}」重新跑一遍？`}
            description={
              <div style={{ maxWidth: 380, whiteSpace: "normal" }}>
                没人碰过的 AI 片段会被这一版的结果整批替换；
                <b>已确认 / 已改类别 / 标了待定 / 自己画的（{humanTouched} 段）会原样保留</b>
                ，跟新结果重叠的会标出「疑似重复」方便对比。
              </div>
            }
            okText="重新跑"
            onConfirm={handleAiPrelabel}
          >
            <Button size="small" icon={<ThunderboltOutlined />} loading={prelabeling}>
              AI预标注
            </Button>
          </Popconfirm>
          {/* 原来是 Radio.Group（按钮条）。加上端侧模型之后它不支持分组，
              线上和端侧会混在一排看不出区别；选项也从 3 个变成 5 个。换成 Select。 */}
          <Tooltip title={hintOf(prelabelMode)}>
            <Select
              size="small"
              {...INFER_SELECT_PROPS}
              value={prelabelMode}
              onChange={(v) => setPrelabelMode(v as InferMode)}
              options={inferOptions}
            />
          </Tooltip>
          <InferModeHelp />
          {/* 项目页批量跑过之后，这些片段到底出自哪个模型完全看不出来；换了
              模型重跑更是。把结果 JSON 里记的版本/模型/时间摆出来 */}
          {aiInfo?.exists && (
            <Tooltip
              title={
                <div style={{ whiteSpace: "normal" }}>
                  现在这些 AI 片段是 {aiInfo.generated_at} 跑的
                  {aiInfo.model_path ? <>，模型 {aiInfo.model_path}</> : null}
                  {aiInfo.missing_seconds ? <>；其中掉数据 {Math.round(aiInfo.missing_seconds)} 秒已挖掉</> : null}
                </div>
              }
            >
              <Tag style={{ margin: 0 }}>
                当前：{aiInfo.mode ? modeLabelOf(aiInfo.mode) : "未知版本"}
                {aiInfo.model_path ? ` · ${aiInfo.model_path.split("/").slice(-1)[0]}` : ""}
              </Tag>
            </Tooltip>
          )}
        </>
      )}
      {canCreate && labels.length > 0 && (
        <>
          <Popover
            open={labelsOpen}
            onOpenChange={(o) => {
              // 没选类别就关掉弹窗 = 放弃这段，别留个半成品挂着
              if (!o) setPendingSpan(null);
              setLabelsOpen(o);
            }}
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={labelPicker}
          >
            <Button size="small" type="link" style={{ padding: "0 2px" }}>类别 ▾</Button>
          </Popover>
          {!labelsOpen && labelId != null && (
            <Tooltip title={chainOf(labelById, labelId).map((l) => l.display_name).join(" › ")}>
              <Tag style={{ marginInlineEnd: 0, color: "#fff", background: colorOf(labelId), borderColor: colorOf(labelId) }}>
                {shortName(labelById, labelById.get(labelId)!)}
              </Tag>
            </Tooltip>
          )}
          <Tooltip title={markStartMs == null
            ? "边播边标：播放 → 动作开始时按 [（或点这里）→ 结束时按 ]，再选类别。比在波形上拖准，也不用停下来。Esc 取消"
            : `起点现在 ${fmtMs(markStartMs)}，点一下按当前播放位置重标`}>
            <Button size="small" danger={markStartMs != null} onClick={() => markAt("start")}>
              {markStartMs == null ? "起点 [" : "重标起点"}
            </Button>
          </Tooltip>
          <Button size="small" disabled={markStartMs == null} onClick={() => markAt("end")}>终点 ]</Button>
          <Tooltip title={<div style={{ maxWidth: 340, whiteSpace: "normal" }}>
            {readOnly && <>查看模式下新建：每标一段直接存库、算你通过（不用认领）。<br /></>}
            {manualMode ? "从零标注：AI 片段已隐藏。" : ""}
            在波形空白处拖一段，松手后「类别」弹窗里点一下就建好；边播边标按 [ 开始、] 结束。
            拖已有片段 = 挪整段 / 改起止；单击片段选中，按 Delete 删除。
          </div>}>
            <QuestionCircleOutlined style={{ color: "#999" }} />
          </Tooltip>
          {readOnly && (
            <Button size="small" type="link" style={{ padding: 0 }}
              onClick={() => { setRoCreate(false); setLabelId(null); setMarkStartMs(null); }}>退出</Button>
          )}
        </>
      )}
      {/* 波形上点中了哪一段：显示起止 + 删除，选中状态跟图上那圈实线框对应 */}
      {selectedItem && (
        <>
          <span style={{ color: "#888", fontSize: 12 }}>
            已选 {nameOf(selectedItem.label_id)} {formatMs(selectedItem.start_time_ms)} ~ {formatMs(selectedItem.end_time_ms)}
          </span>
          {(!readOnly || canFlag) && (
            <Popconfirm
              title="删除这一段？"
              okText="删除"
              okButtonProps={{ danger: true }}
              onConfirm={deleteSelected}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setSelSegId(null)}>取消选择</Button>
        </>
      )}
      {/* 同一只狗前后一个小时：连着翻，人眼找想要的画面（比如喝水） */}
      {nav && (nav.prev || nav.next) && (
        <Space.Compact size="small">
          <Tooltip title={nav.prev ? `同一个 IMU 的上一个时间段（${nav.prev.label}）` : "这只狗前面没有任务了"}>
            <Button size="small" disabled={!nav.prev} onClick={() => nav.prev?.onClick()}>
              ◀ 上一个{nav.prev ? ` ${nav.prev.label}` : ""}
            </Button>
          </Tooltip>
          <Tooltip title={nav.next ? `同一个 IMU 的下一个时间段（${nav.next.label}）` : "这只狗后面没有任务了"}>
            <Button size="small" disabled={!nav.next} onClick={() => nav.next?.onClick()}>
              下一个{nav.next ? ` ${nav.next.label}` : ""} ▶
            </Button>
          </Tooltip>
        </Space.Compact>
      )}
      {hasCsv && sampleId != null && (
        <>
          <Segmented
            size="small"
            options={["曲线图", "表格"]}
            value={imuView}
            onChange={(v) => setImuView(v as "曲线图" | "表格")}
          />
          {imuView === "曲线图" && (
            <>
              <Segmented
                size="small"
                options={manualMode ? ["单条波形", "双波形", "展开全部"] : ["单条波形", "展开全部"]}
                value={chartDual ? "双波形" : chartExpanded ? "展开全部" : "单条波形"}
                onChange={(v) => {
                  const dual = v === "双波形";
                  const expanded = v === "展开全部";
                  setChartDual(dual);
                  setChartExpanded(expanded);
                  saveBool(CHART_DUAL_KEY, dual);
                  saveBool(CHART_MODE_KEY, expanded);
                }}
              />
            </>
          )}
          {imuView === "曲线图" && <ImuChartHint />}
          {imuView === "曲线图" && !chartExpanded && !chartDual && (
            <Tooltip title={chartScrollLocked ? "已锁定滚动，点击解锁（可以滚动切换通道）" : "锁定滚动，防止误滚动切到别的通道"}>
              <Button
                size="small"
                type={chartScrollLocked ? "primary" : "default"}
                icon={chartScrollLocked ? <LockOutlined /> : <UnlockOutlined />}
                onClick={() => {
                  const next = !chartScrollLocked;
                  setChartScrollLocked(next);
                  saveBool(CHART_SCROLL_LOCK_KEY, next);
                }}
              />
            </Tooltip>
          )}
        </>
      )}
    </span>
  ),
  children: (hasCsv && sampleId != null ? (
    <>
      {imuView === "曲线图" ? (
        // 单条波形模式：盒子固定卡在刚好一条波形的高度（flex:"0 0 auto"，
        // 不是 flex:1——写 flex:1 会跟视频抢剩余高度，波形区平白占大半屏）。
        // 两种模式都是这个盒子，底边可以拖：展开全部原来是 flex:1 占满剩余
        // 高度，结果高度由别人（视频、片段面板）决定，想让波形高一点只能
        // 去改别的地方。给个能拖的高度，要多高自己说了算。
        <>
          <div
            ref={chartBoxRef}
            className="ws-charts"
            style={{
              flex: "0 0 auto",
              height: chartHeight,
              // 锁定时不响应滚动，停在当前看到的通道，不会被无意的滚轮带走
              overflowY: chartScrollLocked ? "hidden" : "auto",
            }}
          >
            {chartDual ? (
              // 双波形：上面原始（人工在这里标），下面 AI 辅助（只看 AI 结果）。
              // 只画一条通道；两张图共用一个 syncGroup，缩放/平移联动
              <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
                <div style={{ fontSize: 11, color: tk.colorTextSecondary, padding: "2px 6px 0" }}>
                  原始（人工标注）
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                  <ImuChart
                    key="dual-main"
                    sampleId={sampleId}
                    bus={bus}
                    onlyChannel="acc_x"
                    rowHeight={dualRowHeight}
                    syncGroup={`ws-dual-${taskId ?? 0}`}
                    segments={segments}
                    activeColor={!canCreate || labelId == null ? null : colorOf(labelId)}
                    pendingSegment={pendingSpan}
                    selectedIndex={selSegIdx >= 0 ? selSegIdx : null}
                    onSelectSegment={(idx) => setSelSegId(idx == null ? null : items[idx]?.id ?? null)}
                    onCreateSegment={canCreate ? handleCreateFromChart : undefined}
                    onResizeSegment={!readOnly || canFlag || segReview ? handleResizeFromChart : undefined}
                    onReadOnlyEdit={readOnly ? () => message.info({ content: readOnlyHint, key: "ro-edit" }) : undefined}
                    onSplitSegment={!readOnly || segReview || canFlag ? splitItem : undefined}
                    onSegmentMenu={(idx, at, x, y) => setSegMenu({ idx, at, x, y })}
                  />
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: tk.colorTextSecondary,
                    padding: "2px 6px 0",
                    borderTop: `1px solid ${tk.colorBorderSecondary}`,
                    marginTop: 2,
                  }}
                >
                  AI 辅助（只看 AI 结果，不可修改）
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                  <ImuChart
                    key="dual-ai"
                    sampleId={sampleId}
                    bus={bus}
                    onlyChannel="acc_x"
                    rowHeight={dualRowHeight}
                    syncGroup={`ws-dual-${taskId ?? 0}`}
                    segments={aiSegments}
                  />
                </div>
              </div>
            ) : (
              <ImuChart
                sampleId={sampleId}
                bus={bus}
                rowHeight={chartExpanded && chartBoxH > 0 ? expandedRowHeight : undefined}
                // 展开全部时六条共用最下面那一条时间轴：六条各画一条，
                // 光轴就吃掉一百多像素，而横轴本来就是同一条时间线
                timeAxisOnlyLast={chartExpanded}
                key={chartExpanded ? "expanded" : "single"}
                segments={segments}
                activeColor={!canCreate || labelId == null ? null : colorOf(labelId)}
                pendingSegment={pendingSpan}
                selectedIndex={selSegIdx >= 0 ? selSegIdx : null}
                onSelectSegment={(idx) => setSelSegId(idx == null ? null : items[idx]?.id ?? null)}
                onCreateSegment={canCreate ? handleCreateFromChart : undefined}
                onResizeSegment={!readOnly || canFlag || segReview ? handleResizeFromChart : undefined}
                onReadOnlyEdit={readOnly ? () => message.info({ content: readOnlyHint, key: "ro-edit" }) : undefined}
                onSplitSegment={!readOnly || segReview || canFlag ? splitItem : undefined}
                onSegmentMenu={(idx, at, x, y) => setSegMenu({ idx, at, x, y })}
              />
            )}
          </div>
          {/* 播放进度单独一行放在波形下面：找位置不用在色块上点，避免误动已标片段 */}
          <ImuScrubber sampleId={sampleId} bus={bus} />
          {(
            // 两种模式都给这个把手：波形要多高是看数据的人说了算
            <div
              onMouseDown={handleChartResizeStart}
              onDoubleClick={() => {
                setChartHeight(chartHeightDefault);
                saveHeight(chartHeightKey, null);
              }}
              title="拖拽调整波形区域高度，双击恢复默认"
              className="ws-chart-grip"
            >
              <div className="ws-chart-grip__bar" />
            </div>
          )}
        </>
      ) : (
        <div className="ws-charts" style={{ height: chartHeight }}>
          <ImuTable sampleId={sampleId} />
        </div>
      )}
    </>
  ) : (
    !loading && <Typography.Text type="secondary">没有找到 IMU CSV</Typography.Text>
  )),
  };

  const crossItem = hasCross && cross ? {
    key: "cross",
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        画面对照
        {cross.counts?.no_dog ? <Tag color="red">{cross.counts.no_dog} 段画面里没狗</Tag> : null}
        {cross.counts?.unknown ? <Tag>{cross.counts.unknown} 段判不了</Tag> : null}
        {cross.counts?.agree ? <Tag color="green">{cross.counts.agree} 段对得上</Tag> : null}
      </span>
    ),
    children: (
      <div style={{ maxHeight: 220, overflow: "auto" }}>
        {cross.note && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
            {cross.note}
          </Typography.Text>
        )}
        {/* 可疑的已经由后端排在前面了——这一块的全部意义就是"先看哪几段"，
            按时间排的话人还是得从头翻 */}
        {cross.items.map((it: { id: number; start_time_ms: number; end_time_ms: number; cross: ScratchCross }) => {
          const META: Record<string, { color: string; text: string }> = {
            no_dog: { color: "#d4380d", text: "画面里没狗" },
            unknown: { color: "#8c8c8c", text: "判不了" },
            agree: { color: "#52c41a", text: "对得上" },
          };
          const meta = META[it.cross.state] ?? META.unknown;
          return (
            <div
              key={it.id}
              onClick={() => bus.seek(it.start_time_ms / 1000)}
              title={it.cross.reason}
              style={{ cursor: "pointer", fontSize: 12, padding: "3px 6px", borderRadius: 3,
                       display: "flex", gap: 8, alignItems: "center" }}
            >
              <span style={{ color: meta.color, flexShrink: 0, width: 72 }}>{meta.text}</span>
              <span style={{ color: "#888" }}>{formatMs(it.start_time_ms)} → {formatMs(it.end_time_ms)}</span>
              <span style={{ color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.cross.reason}
              </span>
            </div>
          );
        })}
      </div>
    ),
  } : null;

  const evalItem = (() => {
    const eh = focusWindow?.evalHint;
    if (!eh) return null;
    const iouMin = eh.iouMin ?? 0.3;
    const calcIou = (a0: number, a1: number, b0: number, b1: number) => {
      const inter = Math.min(a1, b1) - Math.max(a0, b0);
      if (inter <= 0) return 0;
      const u = Math.max(0, a1 - a0) + Math.max(0, b1 - b0) - inter;
      return u > 0 ? inter / u : 0;
    };
    const candPairs: [number, number, number][] = [];
    eh.predSegs.forEach(([ps, pe], pi) => {
      eh.truthSegs.forEach(([ts, te], ti) => {
        const v = calcIou(ps, pe, ts, te);
        if (v >= iouMin) candPairs.push([v, pi, ti]);
      });
    });
    candPairs.sort((a, b) => b[0] - a[0]);
    const usedP = new Set<number>();
    const usedT = new Set<number>();
    const pairs: [number, number, number][] = [];
    for (const [v, pi, ti] of candPairs) {
      if (usedP.has(pi) || usedT.has(ti)) continue;
      usedP.add(pi);
      usedT.add(ti);
      pairs.push([pi, ti, v]);
    }
    type EvalCmpRow = {
      key: string;
      kind: "fp" | "fn" | "edge" | "tp";
      sortMs: number;
      ps: number | null;
      pe: number | null;
      conf: number | null;
      ts: number | null;
      te: number | null;
      iou: number | null;
    };
    const allEvalRows: EvalCmpRow[] = [];
    eh.predSegs.forEach(([ps, pe, conf], pi) => {
      if (!usedP.has(pi)) allEvalRows.push({ key: `fp-${pi}`, kind: "fp", sortMs: ps, ps, pe, conf, ts: null, te: null, iou: null });
    });
    eh.truthSegs.forEach(([ts, te], ti) => {
      if (!usedT.has(ti)) allEvalRows.push({ key: `fn-${ti}`, kind: "fn", sortMs: ts, ps: null, pe: null, conf: null, ts, te, iou: null });
    });
    for (const [pi, ti, v] of pairs) {
      const [ps, pe, conf] = eh.predSegs[pi];
      const [ts, te] = eh.truthSegs[ti];
      const edgeBad = Math.abs(ps - ts) > 2000 || Math.abs(pe - te) > 2000;
      allEvalRows.push({ key: `pr-${pi}-${ti}`, kind: edgeBad ? "edge" : "tp", sortMs: Math.min(ps, ts), ps, pe, conf, ts, te, iou: v });
    }
    allEvalRows.sort((a, b) => a.sortMs - b.sortMs);
    const errRows = allEvalRows.filter((r) => r.kind !== "tp");
    const shownEvalRows = evalOnlyErr && errRows.length > 0 ? errRows : allEvalRows;
    const vLabel = eh.verdict === "fp" ? "误报窗口" : eh.verdict === "fn" ? "漏报窗口" : eh.verdict === "tp" ? "命中窗口" : "正常通过";
    const vColor = eh.verdict === "fp" ? "orange" : eh.verdict === "fn" ? "red" : eh.verdict === "tp" ? "green" : "default";
    const targetDef = labels.find((l) => l.display_name === eh.label) ?? labels.find((l) => l.display_name.startsWith(eh.label));
    const isLoopAt = (s: number, e: number) => !!(loopRange && Math.abs(loopRange.startMs - s) <= 20 && Math.abs(loopRange.endMs - e) <= 20);
    const toggleSegLoop = (s: number, e: number) => {
      if (isLoopAt(s, e)) setLoop(null);
      else setLoop({ startMs: s, endMs: e });
    };

    return {
      key: "eval",
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>识别错误对照</span>
          <Tag color={vColor} style={{ marginInlineEnd: 0 }}>【{eh.label}】{vLabel}</Tag>
          <span style={{ fontSize: 12, color: "#888" }}>{eh.version}</span>
          {allEvalRows.length > 0 && (
            <span onClick={(e) => e.stopPropagation()}>
              <Segmented
                size="small"
                value={evalOnlyErr && errRows.length > 0 ? "err" : "all"}
                onChange={(v) => setEvalOnlyErr(v === "err")}
                options={[
                  { value: "err", label: `识别错误 (${errRows.length})`, disabled: errRows.length === 0 },
                  { value: "all", label: `全部对照 (${allEvalRows.length})` },
                ]}
              />
            </span>
          )}
          {win && (
            <Space size={4} onClick={(e) => e.stopPropagation()}>
              <Button size="small" onClick={() => { bus.seek(win.s / 1000); setLoop({ startMs: win.s, endMs: win.e }); }}>
                循环整段窗口 ({formatMs(win.s)}~{formatMs(win.e)})
              </Button>
              {loopRange && <Button size="small" onClick={() => setLoop(null)}>停止循环</Button>}
            </Space>
          )}
        </span>
      ),
      children: shownEvalRows.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          当前窗口内人工与模型均无「{eh.label}」事件记录。
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={shownEvalRows}
          columns={[
            {
              title: "错误类型",
              width: 125,
              render: (_: unknown, r: EvalCmpRow) => (
                r.kind === "fp" ? <Tag color="orange">误报（模型多报）</Tag>
                  : r.kind === "fn" ? <Tag color="red">漏报（模型未报）</Tag>
                  : r.kind === "edge" ? <Tag color="purple">起止偏差 &gt;2s</Tag>
                  : <Tag color="green">命中</Tag>
              ),
            },
            {
              title: "模型预测时段",
              width: 220,
              render: (_: unknown, r: EvalCmpRow) => r.ps != null && r.pe != null ? (
                <span>
                  <b>{formatMs(r.ps)} ~ {formatMs(r.pe)}</b>
                  <span style={{ color: "#888", fontSize: 12, marginLeft: 6 }}>
                    {((r.pe - r.ps) / 1000).toFixed(2)}s{r.conf != null ? ` · 置信度 ${r.conf}` : ""}
                  </span>
                </span>
              ) : <span style={{ color: "#888" }}>—（未报出）</span>,
            },
            {
              title: "人工标注时段",
              width: 210,
              render: (_: unknown, r: EvalCmpRow) => r.ts != null && r.te != null ? (
                <span>
                  <b>{formatMs(r.ts)} ~ {formatMs(r.te)}</b>
                  <span style={{ color: "#888", fontSize: 12, marginLeft: 6 }}>
                    {((r.te - r.ts) / 1000).toFixed(2)}s
                  </span>
                  {r.iou != null && (
                    <span style={{ color: r.kind === "edge" ? "#b37feb" : "#52c41a", fontSize: 12, marginLeft: 6 }}>
                      IoU {Math.round(r.iou * 100)}%
                    </span>
                  )}
                </span>
              ) : <span style={{ color: "#888" }}>—（无「{eh.label}」）</span>,
            },
            {
              title: "该时段当前标注（排查原因）",
              render: (_: unknown, r: EvalCmpRow) => {
                const lo = r.ps ?? r.ts ?? 0;
                const hi = r.pe ?? r.te ?? 0;
                const ov = items.filter((x) => x.start_time_ms < hi && x.end_time_ms > lo);
                return ov.length ? (
                  <Space size={4} wrap>
                    {ov.map((x) => (
                      <Tag key={x.id} color={colorOf(x.label_id)} style={{ marginInlineEnd: 0 }}>
                        {nameOf(x.label_id)}
                      </Tag>
                    ))}
                  </Space>
                ) : <span style={{ color: "#ff4d4f", fontSize: 12 }}>未标任何动作</span>;
              },
            },
            {
              title: "操作",
              width: 240,
              render: (_: unknown, r: EvalCmpRow) => {
                const matchIt = r.ts != null && r.te != null
                  ? items.find((x) => Math.abs(x.start_time_ms - r.ts!) <= 500 && Math.abs(x.end_time_ms - r.te!) <= 500)
                  : undefined;
                const s0 = r.kind === "fp" ? r.ps! : (matchIt?.start_time_ms ?? r.ts ?? r.ps ?? 0);
                const e0 = r.kind === "fp" ? r.pe! : (matchIt?.end_time_ms ?? r.te ?? r.pe ?? 0);
                const looping = isLoopAt(s0, e0);
                const adopted = r.kind === "fp" && targetDef != null && items.some(
                  (x) => (x.label_id === targetDef.id || nameOf(x.label_id).startsWith(eh.label))
                    && x.start_time_ms < r.pe! && x.end_time_ms > r.ps!,
                );
                return (
                  <Space size={8} wrap>
                    <a onClick={() => bus.seek(s0 / 1000)}>跳转</a>
                    <a style={{ color: looping ? "#ff4d4f" : undefined }} onClick={() => toggleSegLoop(s0, e0)}>
                      {looping ? "停止播放" : "循环播放"}
                    </a>
                    {(r.kind === "edge" || r.kind === "tp") && r.ps != null && r.pe != null && (
                      <a style={{ color: isLoopAt(r.ps, r.pe) ? "#ff4d4f" : "#faad14" }}
                        onClick={() => toggleSegLoop(r.ps!, r.pe!)}>
                        {isLoopAt(r.ps, r.pe) ? "停止预测段" : "循环预测段"}
                      </a>
                    )}
                    {r.kind === "fp" && targetDef != null && (canCreate || roCreateAllowed) && (
                      adopted
                        ? <Tag color="green" style={{ marginInlineEnd: 0 }}>已补标</Tag>
                        : <a style={{ color: "#52c41a" }} onClick={() => appendItem(r.ps!, r.pe!, targetDef.id)}>+ 补标为{eh.label}</a>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      ),
    };
  })();

  const segsItem = {
    key: "segs",
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        已标注片段（{items.length}）
        <span ref={setSegControlsHost} style={{ display: "inline-flex" }} />
      </span>
    ),
    children: (
      <SegmentPanel
        onFilterChange={setChartFilter}
        manualMode={manualMode}
        persistKey={taskId != null && !segReview ? `seg-panel:${taskId}` : null}
        controlsPortalTarget={segControlsHost}
        projectKey={task?.project_id ?? null}
        focusMs={initialSeekMs}
        focusWin={win}
        items={win ? items.filter((i) => inWin(i.start_time_ms, i.end_time_ms)) : items}
        labels={labels}
        readOnly={readOnly}
        durationMs={durationMs}
        colorOf={colorOf}
        nameOf={nameOf}
        onSeek={(ms) => bus.seek(ms / 1000)}
        onLoop={setLoop}
        loopRange={loopRange}
        dupIds={dupIds}
        onUpdate={updateItems}
        onDelete={(id) => {
          if (!readOnly) setItems((prev) => prev.filter((x) => x.id !== id));
          else {
            const it = items.find((x) => x.id === id);
            if (it) void deleteItemRemote(it);
          }
        }}
        canDeleteReadOnly={canFlag && !segReview}
        onDedupe={taskId != null && !segReview && (!readOnly || canFlag) ? handleDedupe : undefined}
        onSplit={(id) => {
          const idx = items.findIndex((x) => x.id === id);
          const it = items[idx];
          if (!it) return;
          const at = curSecRef.current * 1000;
          splitItem(idx, at > it.start_time_ms && at < it.end_time_ms ? at : (it.start_time_ms + it.end_time_ms) / 2);
        }}
        onReturnToCandidate={async (i) => {
          if (i.from_candidate_id == null || taskId == null) return;
          // 先把候选放回「待确认」，再把这条片段从草稿里去掉并落库——
          // 只删片段不动候选的话，那条候选还挂着"已确认"，再也不会出现
          await decideCandidate(i.from_candidate_id, "pending");
          const next = items.filter((x) => x.id !== i.id);
          loadItems(next);
          await saveDraft(taskId, toDraftPayload(next));
          setCandidates(await listCandidates(taskId));
          message.success("已退回候选，可以重新判断");
        }}
        onCreate={canCreate ? appendItem : undefined}
        // 夜视默认关着，见 config/features.ts：不传这个回调，按钮就不渲染
        onLowlight={NIGHT_VISION ? (a, b) => setLowlightAt([a, b]) : undefined}
        initialFilterLabels={initialSegmentFilter}
        onReviewNote={canFlag || !readOnly ? handleReviewNote : undefined}
        onSegApprove={canFlag ? handleSegApprove : undefined}
        onSendBackReviewer={role === "admin" || role === "super_admin" ? handleSendBackReviewer : undefined}
        // 只看模式也能改类别（审核员 / 管理员，直接落库）、打标记（任务的标注员也行，后端会拦别人的）
        onRelabelRemote={readOnly && canFlag && !segReview ? relabelItem : undefined}
        onMarksRemote={readOnly && taskId != null ? marksRemote : undefined}
        reviewNoteClearOnly={!canFlag}
        initialFlaggedOnly={flagFocus}
      />
    ),
  };

  const candsItem = {
    key: "cands",
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        疑似片段（{candidates.filter((c) => c.status === "pending").length} 待确认 / {candidates.length}）
        {/* 里面混着好几类（抓挠 / 舔 / 进食 / 饮水 / 吠叫…），标题上就按类别报还剩几条没判 */}
        {candKindSummary(candidates)}
        <span ref={setCandControlsHost} style={{ display: "inline-flex" }} />
      </span>
    ),
    children: (
      <CandidatePanel
        controlsPortalTarget={candControlsHost}
        candidates={win ? candidates.filter((c) => inWin(c.start_time_ms, c.end_time_ms)) : candidates}
        labels={labels}
        focusMs={initialSeekMs}
        initialLabelFilter={focusCandLabels}
        onReviewNote={canFlag || !readOnly ? handleCandReviewNote : undefined}
        reviewNoteClearOnly={!canFlag}
        initialFlaggedOnly={candFlagFocus}
        initialFilter={initialCandFilter ?? undefined}
        onFindSimilar={
          readOnly
            ? undefined
            : (atSec?: number, labelName?: string) => {
                // 某一条候选点过来的：样例取那一条自己的中点，别用"视频当前播到哪"——
                // 人得先跳转、等它播到对的地方、再点，中间任何一步错了样例就取错了
                setSimilarAtSec(atSec ?? Math.round(curSecRef.current * 10) / 10);
                if (labelName) setSimilarLabel(labelName);
                setSimilarOpen(true);
              }
        }
        onTogglePlay={() => bus.play("toggle")}
        getCurrentMs={() => curSecRef.current * 1000}
        onSplit={async () => { if (taskId != null) setCandidates(await listCandidates(taskId)); }}
        onClearSimilar={
          readOnly || taskId == null
            ? undefined
            : async () => {
                const r = await clearSimilarCandidates(taskId);
                setCandidates(await listCandidates(taskId));
                return r.deleted;
              }
        }
        scratchLabelIds={focusIds.length ? focusIds : scratchIds}
        readOnly={readOnly}
        onSeek={(ms) => bus.seek(ms / 1000)}
        onLoop={setLoop}
        loopRange={loopRange}
        // 判断之前先落库，判断之后再拉。顺序反了会丢东西：
        //   先判断再存 → 存的是本地这份（还不知道后端刚写的那条），
        //               那条会被当成"删掉的条目"清掉；
        //   先拉再存   → 把还没保存的本地改动整个盖掉。
        onBeforeDecide={async () => {
          if (!readOnly && taskId != null) await persist();
        }}
        onDecided={async (c, decision) => {
          if (taskId == null) return;
          const [draft, cs] = await Promise.all([getDraft(taskId), listCandidates(taskId)]);
          loadItems(draft.items);
          setCandidates(cs);
          if (decision === "confirmed" && !readOnly) checkOverlapAfterConfirm(draft.items, c.id);
        }}
        onUndo={async (c) => {
          if (taskId == null) return;
          // 跟确认时同一个顺序：先把本地改动落库，再动服务器上的东西，
          // 不然下面重新拉草稿会把还没保存的改动整个盖掉
          if (!readOnly) await persist();
          await decideCandidate(c.id, "pending");
          // 「确认」时后端往草稿里写了一条，撤回要把它一起收回；
          // 「排除」「待定」没写过条目，这里自然什么都不会删
          const draft = await getDraft(taskId);
          const next = draft.items.filter((x) => x.from_candidate_id !== c.id);
          if (!readOnly && next.length !== draft.items.length) {
            await saveDraft(taskId, toDraftPayload(next));
          }
          loadItems(next);
          setCandidates(await listCandidates(taskId));
        }}
      />
    ),
  };

  const renderPanel = (k: PanelKey) => {
    const item = k === "imu" ? imuItem : k === "eval" ? evalItem : k === "cross" ? crossItem : k === "segs" ? segsItem : candsItem;
    if (!item) return null;
    const el = (
      <Collapse
        size="small"
        className={k === "imu" ? "ws-imu" : "ws-panel"}
        activeKey={isPanelOpen(k) ? [k] : []}
        onChange={(keys) => setPanelOpen(k, (Array.isArray(keys) ? keys : [keys]).includes(k))}
        items={[{ ...item, extra: panelTools(k) }]}
      />
    );
    if (k !== "imu") return <div key={k} style={{ flex: "0 0 auto" }}>{el}</div>;
    // 波形区自己是固定高度（可拖），这一块永远按内容高度、不可压缩：跟视频区
    // 都是 flex:1 的话，片段列表一展开两者一起被压，波形区会被压到比内容还矮
    return (
      <div key={k} style={{ marginTop: 4, flex: "0 0 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {el}
      </div>
    );
  };

  return (
    <>
    {segMenuEl}
    {/* 循环播放时弹出这一段的波形：已标注、疑似片段都一样 */}
    {taskId != null && hasCsv && sampleId != null && (
      <LoopWaveform sampleId={sampleId} bus={bus} info={loopInfo}
        onStop={() => { setLoop(null); setStickyRange(null); }}
        keepOpen={keepPopup} onKeepOpenChange={setKeepPopup}
        onAdjust={readOnly && !segReview && !canFlag ? undefined : adjustFromWave}
        // 片段审核时只有正在审的那一条能改；审核员 / 管理员看只读任务时片段都能改，
        // 疑似片段只有管理员能改（跟后端一致）
        canAdjust={
          readOnly && segReview
            ? (t) => t.kind === "item" && inGroup(t.id)
            : readOnly && canFlag
              ? (t) => t.kind === "item" || role === "admin" || role === "super_admin"
              : undefined
        }
        readOnlyHint={readOnly && !canFlag ? readOnlyHint : undefined}
        forceOpen={!!segReview}
        extra={
          segReview && inGroup(loopInfo?.itemId)
            ? (
              <div style={{ width: "100%" }}>
                {segReview.actions}
                {splitPanel}
              </div>
            )
            : loopItem && (!readOnly || canFlag)
              ? (
                <div style={{ width: "100%" }}>
                  {canFlag ? (
                    <>
                      {waveReviewBar(loopItem, true)}
                      {splitPiecesList}
                    </>
                  ) : splitPanel}
                </div>
              )
              : canFlag && loopItem ? waveReviewBar(loopItem) : undefined
        } />
    )}
    <Modal
      title="找相似的画面 → 候选"
      open={similarOpen}
      onCancel={() => setSimilarOpen(false)}
      // 满屏、左右分栏：左边样例 + 参数 + 循环播放器，右边命中一屏浏览。之前上下排着，
      // 看命中要往下滚、看播放器又往上滚，来回折腾
      width="100vw"
      style={{ top: 0, maxWidth: "100vw", paddingBottom: 0 }}
      styles={{ body: { height: "calc(100vh - 110px)", overflow: "hidden", padding: "8px 12px" }, content: { borderRadius: 0 } }}
      destroyOnClose
      afterClose={() => { setSimilarPeek(null); setSimilarClip(null); setSimilarPicked(new Map()); }}
      footer={
        <Space>
          <Button onClick={() => setSimilarOpen(false)}>取消</Button>
          <Tooltip title="只搜不写：把命中的画面（狗框那一块）跟样例并排摆出来，看着对再写候选；不对就换一帧 / 调参数再看">
            <Button loading={similarPeeking} disabled={similarUseText && !similarText.trim()} onClick={peekSimilar}>
              先看命中
            </Button>
          </Tooltip>
          {/* 勾掉了几帧就写在按钮上：点下去写的是哪一批，不该还要人回去数格子。
              一张都不要了就别让他点——那一下什么也不会发生，最费解 */}
          <Button
            type="primary"
            loading={similarRunning}
            disabled={!similarLabel || (similarUseText && !similarText.trim())
              || (!!similarPeek && similarPicked.size === 0 && similarPeek.hits.length > 0)}
            onClick={runSimilar}
          >
            {similarPeek
              ? `写入候选（要 ${similarPicked.size} / ${similarPeek.hits.length} 帧）`
              : "找"}
          </Button>
        </Space>
      }
    >
      <div style={{ display: "flex", gap: 12, height: "100%" }}>
      {/* 左栏：一屏放得下，不用滚——说明全收进问号；大图限高，播放器占剩下的 */}
      <div style={{ flex: "0 0 38%", minWidth: 360, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
          <Typography.Text style={{ whiteSpace: "nowrap" }}>标成：</Typography.Text>
          <Select
            size="small"
            style={{ flex: 1, minWidth: 0 }}
            mode="tags"
            maxCount={1}
            showSearch
            // 选项按层级缩进、带颜色（跟候选面板「改成别的」一样）；搜索按名字匹配
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            listHeight={380}
            placeholder="找到的段打什么标签；没有的打字回车，会新建"
            value={similarLabel ? [similarLabel] : []}
            onChange={(v: string[]) => setSimilarLabel(v.length ? v[v.length - 1].trim() : null)}
            tagRender={({ value, closable, onClose }) => {
              const l = labels.find((x) => x.display_name === value);
              return (
                <Tag color={l?.color || undefined} closable={closable} onClose={onClose} style={{ marginRight: 3 }}>
                  {value}
                </Tag>
              );
            }}
            options={flattenLabels(labels).map(({ label: l, depth }) => ({
              value: l.display_name,
              label: (
                <span style={{ paddingLeft: depth * 12 }}>
                  {depth > 0 && <span style={{ color: "#bbb", marginRight: 4 }}>└</span>}
                  <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.display_name}</Tag>
                </span>
              ),
            }))}
          />
          <Tooltip
            title={
              <div>
                拿当前画面（狗框出来那一块）的向量，在已建索引的视频里找长得像的几秒，写成候选。不问大模型、不花钱、几秒出结果；粗，"长得像"不等于同一个动作，人再确认。
                <br />命中是按秒的，一次舔往往持续几十秒、命中断断续续，所以相邻命中会按「隔 N 秒以内算同一段」合成一段。
                <br />先在项目页「建画面索引」，没建的视频搜不到。狗场只搜每只狗自己房间那一路（公共区对不上是哪只狗）；影棚三路都是公共的，命中要看清是哪只。
                <br />标签没有的（比如「舔后抓」）直接打字回车，找到就顺手建进项目。
              </div>
            }
          >
            <QuestionCircleOutlined style={{ color: "#999" }} />
          </Tooltip>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Checkbox checked={similarUseText} onChange={(e) => setSimilarUseText(e.target.checked)}>
            用一句英文描述搜
          </Checkbox>
          {similarUseText ? (
            <>
              {/* 现成的一句：SigLIP 文本端是英文训练的，中文标签名直接送进去命中会差
                  一大截，而且差得不明显——它照样给你 60 个命中，只是那些命中不对。
                  这张表是人写一次全项目复用的，选完还能接着改（措辞对检索影响很大） */}
              <Select
                size="small"
                showSearch
                allowClear
                placeholder="选个现成的描述"
                style={{ width: 190 }}
                optionFilterProp="label"
                onChange={(v?: string) => v && setSimilarText(v)}
                options={ACTION_QUERIES.map((q) => ({ value: q.query, label: q.label }))}
              />
              <Input size="small" value={similarText} onChange={(e) => setSimilarText(e.target.value)} placeholder="dog licking its tail" style={{ flex: 1, minWidth: 160 }} />
              {/* 按「标成」那个类别自动填一句：中文标签 → 英文描述那张表。
                  分不到那么细的（左右、更细的部位）会退到上一级，按钮上写明用的是哪一条 */}
              {similarLabel && queryFor(similarLabel) && (
                <Tooltip title={queryFor(similarLabel)!.exact
                  ? `按「${similarLabel}」填一句英文描述`
                  : `检索分不到这么细，会用「${queryFor(similarLabel)!.from}」那一句——命中里左右和更细的部位要人自己看`}>
                  <Button size="small" onClick={() => setSimilarText(queryFor(similarLabel)!.query)}>
                    按「{queryFor(similarLabel)!.from}」填
                  </Button>
                </Tooltip>
              )}
            </>
          ) : (
            <>
              <Typography.Text>样例：视角1 第</Typography.Text>
              <InputNumber
                size="small"
                min={0}
                step={0.5}
                value={similarAtSec}
                onChange={(v) => setSimilarAtSec(Math.max(0, Math.round((v ?? 0) * 10) / 10))}
                style={{ width: 84 }}
              />
              <Typography.Text>秒</Typography.Text>
              <Tooltip title="先在视频里停到最像的那一帧再点；下面是这一帧框到的狗">
                <Button size="small" onClick={() => setSimilarAtSec(Math.round(curSecRef.current * 10) / 10)}>
                  用视频当前时刻
                </Button>
              </Tooltip>
            </>
          )}
        </div>
        {!similarUseText && taskId != null && (
          <div style={{ flex: "0 0 auto" }}>
            <SimilarFramePreview taskId={taskId} tSec={similarAtSec} view={similarView} onViewChange={setSimilarView} compact />
          </div>
        )}
        <Space size={[8, 4]} wrap>
          <span>
            范围
            <Select size="small" value={similarScope} onChange={(v) => setSimilarScope(v)} style={{ width: 110, marginLeft: 4 }}
              options={[
                { value: "project", label: "整个项目" },
                { value: "task", label: "只在本任务" },
                { value: "all", label: "所有项目" },
              ]} />
            {similarScope === "all" && (
              <Tooltip title="跨项目搜所有待认领 / 标注中任务的视频。别的项目没建画面索引的路搜不到（结果里会报几路没建）；命中落到别的项目时，那个项目要有同名标签才能确认">
                <QuestionCircleOutlined style={{ color: "#999", marginLeft: 4 }} />
              </Tooltip>
            )}
          </span>
          <Tooltip title="最多取多少个命中">
            <span>
              取 <InputNumber size="small" min={1} max={2000} value={similarTopK} onChange={(v) => setSimilarTopK(v ?? 60)} style={{ width: 70 }} /> 个
            </span>
          </Tooltip>
          <Tooltip title="同一路视频里相邻命中隔多少秒以内合成一段">
            <span>
              隔 <InputNumber size="small" min={0} max={120} value={similarGap} onChange={(v) => setSimilarGap(v ?? 15)} style={{ width: 60 }} /> 秒合段
            </span>
          </Tooltip>
          <Tooltip title="同一只狗、同一间房、同一块地板，每一帧的向量里都带着这坨共同背景，原始相似度全在 0.95 以上分不开。勾上之后每一帧减掉**它自己那一路**的平均向量（样例帧也减它自己那一路的），狗的身份、毛色、房间、机位在两边同时抵消，剩下的才是动作——这是「搜出来全是同一只狗」的解药。不勾就按原始相似度">
            <Checkbox checked={similarCenter} onChange={(e) => setSimilarCenter(e.target.checked)}>
              去背景
            </Checkbox>
          </Tooltip>
          <Tooltip title={similarUseText
            ? "一句话查询没有姿态向量可比（姿态是从样例那一帧的关键点算出来的），所以用一句话搜时这一项不起作用，只看画面"
            : "第二路信号：狗的姿态关键点（鼻子、脖子、尾根、四爪…）算出来的「鼻子够到了哪只爪」。0 只看画面，1 只看姿态。算法机上没装姿态模型时自动只看画面（先看命中的说明里会写）"}>
            <span style={{ opacity: similarUseText ? 0.45 : 1 }}>
              姿态占 <InputNumber size="small" min={0} max={1} step={0.1} disabled={similarUseText} value={similarPoseW} onChange={(v) => setSimilarPoseW(Math.max(0, Math.min(1, v ?? 0.5)))} style={{ width: 60 }} />
            </span>
          </Tooltip>
          <Tooltip title="几何硬条件，不是相似度：只留「鼻子够到了这个部位」的帧。画面向量看的是整体长相，分不清左前爪和右前爪；这一条直接按关键点距离卡，而且天然跨狗（按体长归一化过，跟毛色体型无关）。腰、腹股沟这类判不了的填了也不筛，结果说明里会写清楚">
            <span>
              部位
              <Select size="small" allowClear value={similarPart || undefined} onChange={(v) => setSimilarPart(v ?? "")}
                placeholder="不限" style={{ width: 96, marginLeft: 4 }}
                options={["前爪", "后爪", "前左爪", "前右爪", "后左爪", "后右爪", "尾根", "颈部"].map((v) => ({ value: v, label: v }))} />
            </span>
          </Tooltip>
        </Space>
        {taskId != null && (
          <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
            <SimilarClipPlayer
              taskId={taskId}
              clip={similarClip}
              onClose={() => setSimilarClip(null)}
              onOpenTask={(h) => openSimilarHit(h)}
            />
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", borderLeft: "1px solid var(--sl-border)", paddingLeft: 12 }}>
        {similarPeek && taskId != null ? (
          <SimilarHitsGrid
            taskId={taskId}
            projectId={task?.project_id ?? null}
            refPath={similarPeek.refPath}
            refT={similarPeek.refT}
            refSampleId={sampleId}
            refCam="cam1"
            hits={similarPeek.hits}
            centered={similarPeek.centered}
            poseUsed={similarPeek.poseUsed}
            view={similarView}
            onViewChange={setSimilarView}
            playing={similarClip}
            onPlay={setSimilarClip}
            onJump={openSimilarHit}
            picked={similarPicked}
            onPicked={setSimilarPicked}
            defaultLabel={similarLabel || null}
            labelNames={labels.map((l) => ({ name: l.display_name, color: l.color }))}
          />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 13 }}>
            {similarPeeking ? <Spin tip="在索引里找…" /> : "左边选好样例和参数，点下面「先看命中」，命中的画面在这里一屏浏览"}
          </div>
        )}
      </div>
      </div>
    </Modal>
    <Modal
      title="找相似的结果：落到了哪些任务"
      open={similarResult != null}
      onCancel={() => setSimilarResult(null)}
      onOk={() => setSimilarResult(null)}
      cancelButtonProps={{ style: { display: "none" } }}
      okText="知道了"
      width={760}
    >
      {similarResult && (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            找到 {similarResult.segments} 段（{similarResult.hits} 个命中，搜了 {similarResult.searched} 路视频
            {similarResult.missing ? `，${similarResult.missing} 路还没建索引` : ""}），新写入 <b>{similarResult.written}</b> 条候选。
            跟已有同标签重叠的没重复写。
            {/* 勾掉的那几帧要在结果里留痕：过两天回头看"怎么比上次少"，答案得能找得回来 */}
            {similarResult.dropped ? `你手动勾掉了 ${similarResult.dropped} 帧，这几帧没参与合段。` : ""}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            候选写在下面这些任务的「疑似片段」里，线索标着「画面相似」，面板上多了个「画面相似」筛选。
            点时间：本任务直接跳过去循环播放；别的任务在新标签页打开并停在那一段。
          </Typography.Text>
          <Table
            size="small"
            rowKey="task_id"
            pagination={false}
            dataSource={similarResult.per_task.filter((p) => p.candidates > 0)}
            columns={[
              { title: "任务", width: 80, render: (_, p) => `#${p.task_id}` },
              { title: "项目", width: 70, render: (_, p) => (p.project_id === task?.project_id ? "本项目" : `#${p.project_id}`) },
              { title: "样本", dataIndex: "sample_code", render: (v: string | null) => v ?? "-" },
              { title: "新写入", width: 70, dataIndex: "candidates" },
              {
                title: "时间（分数）",
                render: (_, p) => (
                  <Space size={4} wrap>
                    {p.items.slice(0, 6).map((it, i) =>
                      p.task_id === taskId ? (
                        // 本任务：点一下直接跳过去并循环播放这一段
                        <Tag
                          key={i}
                          color="blue"
                          style={{ cursor: "pointer" }}
                          onClick={() => {
                            setLoop({ startMs: Math.round(it.start_s * 1000), endMs: Math.round(it.end_s * 1000) });
                            setSimilarResult(null);
                          }}
                        >
                          {formatMs(it.start_s * 1000)}{it.score != null ? ` ${it.score.toFixed(2)}` : ""}
                        </Tag>
                      ) : (
                        // 别的任务：链接直接带上时刻，打开就停在这一段、只看「画面相似」
                        <a key={i} href={`/tasks?task=${p.task_id}&seek=${Math.round(it.start_s * 1000)}&cand=similar`} target="_blank" rel="noreferrer">
                          <Tag style={{ cursor: "pointer" }}>{formatMs(it.start_s * 1000)}{it.score != null ? ` ${it.score.toFixed(2)}` : ""}</Tag>
                        </a>
                      )
                    )}
                    {p.items.length > 6 && <span>…</span>}
                  </Space>
                ),
              },
              { title: "", width: 60, render: (_, p) => p.multi_dog ? <Tag color="orange">多狗</Tag> : null },
              {
                title: "",
                width: 70,
                render: (_, p) =>
                  p.task_id === taskId ? (
                    <Typography.Text type="secondary">本任务</Typography.Text>
                  ) : (
                    <a href={`/tasks?task=${p.task_id}${p.items[0] ? `&seek=${Math.round(p.items[0].start_s * 1000)}` : ""}&cand=similar`} target="_blank" rel="noreferrer">打开</a>
                  ),
              },
            ]}
          />
        </Space>
      )}
    </Modal>
    <Modal
      title={
        // 左边是"这是什么"（任务/狗/样本 + 播放控件），右边是"我能干什么"
        // （只读 / 认领并修改）。夹在中间的话，播放控件的位置会跟着只读与否
        // 左右跳，而且那个按钮混在一串说明性标签里也不显眼
        <div style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 8, paddingRight: 28, flexWrap: "wrap" }}>
        <Space wrap size={[6, 4]} style={{ flex: "1 1 360px", minWidth: 0 }}>
          <span>{readOnly ? "查看标注" : "标注"} - 任务 #{taskId}</span>
          {flaggedCount > 0 && (
            <Tooltip title="审核时标出来的有问题的片段（含疑似片段）。已标注片段的来源筛选选「被标有问题」、疑似片段选「有问题」只看这几条">
              <Tag color="red">{flaggedCount} 段标了有问题</Tag>
            </Tooltip>
          )}
          {readOnly && canFlag && flaggedCount > 0 && (task?.status === "APPROVED" || task?.status === "REJECTED") && (
            <Popconfirm
              title={`退回这 ${flaggedCount} 段重标？`}
              description="任务轮次 +1，片段原样带到新一轮；标注员打开时会先只看到这几段，每段写着问题"
              onConfirm={reopenFlagged}
            >
              <Button size="small" danger>退回这 {flaggedCount} 段重标</Button>
            </Popconfirm>
          )}
          {/* 一个画面里同时有四只狗，这条 IMU 是谁身上的必须一眼看见，
              不然逐条确认时很容易确认成别的狗的动作 */}
          {task && (
            <>
              {/* 档案头像：点开看这只狗的照片，对着画面确认 IMU/机位没有挂错狗 */}
              <DogAvatar
                dogId={dogIdOverride !== undefined ? dogIdOverride : task.dog_id}
                name={(dogLabelOverride !== undefined ? dogLabelOverride : task.dog_label)?.replace(/（.*）$/, "")}
              />
              {/* 管理员点开能换狗：老数据当时这个 IMU 戴在哪只狗身上，要对着画面才知道 */}
              <DogPicker
                sampleId={task.sample_id}
                label={dogLabelOverride !== undefined ? dogLabelOverride : task.dog_label}
                canEdit={role === "admin" || role === "super_admin"}
                onChanged={(label, dogId) => {
                  setDogLabelOverride(label);
                  setDogIdOverride(dogId);
                }}
              />
            </>
          )}
          {/* 画面里那只跟这一间对不上时，就地核对机位：循环看这一段，把这一间换到对的那一路 */}
          {task && mediaSite !== "yingpeng" && (role === "admin" || role === "super_admin") && (
            <Tooltip title="画面不是这一间（或这只狗不在画面里）时用：循环看这一段，把放这只狗的那一路选成它实际的房间。改的是这一场录制，同时段的所有样本一起换">
              <Button size="small" onClick={openCamFix}>机位纠正</Button>
            </Tooltip>
          )}
          {win && (
            <Popover
              open={winHintOpen}
              onOpenChange={(v) => { if (!v) dismissWinHint(); else setWinHintOpen(true); }}
              trigger="click"
              placement="bottomLeft"
              zIndex={1200}
              content={
                <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <Typography.Text strong style={{ color: "#faad14" }}>
                      标注窗口范围（{Math.round((win.e - win.s) / 1000)} 秒）
                    </Typography.Text>
                    <Button
                      size="small"
                      type="text"
                      style={{ padding: "0 4px", lineHeight: 1 }}
                      onClick={dismissWinHint}
                      aria-label="收起提示"
                    >
                      ✕
                    </Button>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                    这个任务只标 <b>{formatMs(win.s)} ~ {formatMs(win.e)}</b>：窗口外不用标、下面也不显示；
                    窗口里<b>从头到尾都要标</b>（休息、活动也标）。
                    {(() => {
                      const n = candidates.filter((c) => c.status === "pending"
                        && c.start_time_ms < win.e && c.end_time_ms > win.s).length;
                      return n
                        ? <div style={{ marginTop: 4 }}>窗口里有 <b>{n}</b> 条疑似片段，往下滚到「疑似片段」面板判（确认 / 排除 / 调起止），其余时间自己补标。</div>
                        : null;
                    })()}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Space size={6}>
                      <Button size="small" onClick={() => bus.seek(win.s / 1000)}>跳到窗口</Button>
                      <Button size="small" onClick={() => { bus.seek(win.s / 1000); setLoop({ startMs: win.s, endMs: win.e }); }}>循环窗口</Button>
                      {loopRange && <Button size="small" onClick={() => setLoop(null)}>停止循环</Button>}
                    </Space>
                    <Button size="small" type="primary" onClick={dismissWinHint}>知道了</Button>
                  </div>
                </div>
              }
            >
              <Tag color="orange" style={{ cursor: "pointer", fontWeight: 600, marginInlineEnd: 0 }}>
                只标 {formatMs(win.s)} ~ {formatMs(win.e)} {winHintOpen ? "▴" : "▾"}
              </Tag>
            </Popover>
          )}
          <Tooltip title={`样本 ${task?.sample_code ? sampleDisplayName(task.sample_code, task.video_duration_sec, role, true) : sampleId}${task?.video_duration_sec ? ` · ${formatDuration(task.video_duration_sec)}` : ""}`}>
            <Tag style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginInlineEnd: 0 }}>
              {/* 带上日期：这个标题栏里没有项目名，不写日期就不知道是哪天的数据 */}
              样本 {task?.sample_code ? sampleDisplayName(task.sample_code, task.video_duration_sec, role, true) : sampleId}
              {task?.video_duration_sec ? ` · ${formatDuration(task.video_duration_sec)}` : ""}
            </Tag>
          </Tooltip>
        </Space>
        {/* 播放速度/帧号控件从视频区上方 portal 到标题栏右上角，跟标题拼一行，省出来的高度给视频用 */}
        <span ref={setControlsHost} style={{ display: "inline-flex", flexShrink: 0, marginLeft: "auto" }} />
        </div>
      }
      open={taskId != null}
      onCancel={handleClose}
      // 标注要看细节，占满整个屏幕，别把空间浪费在弹窗留白上
      width="100vw"
      // 弹窗本身已经占满一屏并且 body 自己滚，外层 antd 的 wrap 层再出一根滚动条
      // 就是两根挤在一起；wrap 的滚动禁掉（见 .ws-modal-wrap）
      wrapClassName="ws-modal-wrap"
      style={{ top: 0, paddingBottom: 0, maxWidth: "100vw" }}
      // body 高度 = 一屏减去标题栏和底栏（见 .ws-modal-wrap 的 flex），视频/波形按这个分配；
      // 片段列表展开后超出的部分让 body 自己滚（overflow:auto），不再裁掉——外层页面
      // 滚动条是 antd 弹窗容器的，被视频/波形区域的滚轮事件拦住滚不动，靠它没用。
      // 原来写死 calc(100vh - 108px)（按有底栏算的），只读又没按钮时没有底栏，
      // 弹窗底下就空出一条，透出后面页面的任务行
      styles={{ body: { overflowY: "auto", overflowX: "hidden", paddingTop: 8 } }}
      destroyOnClose
      footer={
        readOnly ? (
          // 注意：这里必须给 null 而不是 undefined。footer 传 undefined 时
          // antd 会当成"没设置"，渲染它默认的 取消/确定 两个按钮。
          onApprove || onReject || onClaim || onReopen || onEditAgain ? (
            <Space>
              {/* 提交之后自己再检查一遍：不开新一轮，片段原样，改完再提交 */}
              {onEditAgain && (
                <Tooltip title="回到「标注中」接着改（轮次不变、片段原样），改完再提交">
                  <Button type="primary" onClick={onEditAgain}>继续编辑</Button>
                </Tooltip>
              )}
              {/* 只读标志挪到这里跟按钮放一起：它说的就是"要动手先点右边那个"，
                  以前在标题栏右上角，跟底部这排是同一件事说了两遍 */}
              {onClaim && (
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  只读
                </Tag>
              )}
              {onReject && (
                <Button danger onClick={onReject}>
                  驳回
                </Button>
              )}
              {/* 只认这一类标得对——比「整份通过」窄得多，所以是单独一个按钮 */}
              {/* 看着看着发现有几段是错的，就地认领改掉，不用退回任务页 */}
              {/* 没认领之前只有这一件事能做，所以它是主按钮，右边两个结论置灰 */}
              {onClaim && (
                <Tooltip title="要逐条确认、改类别（比如其实是甩身体）、或标成待定，先认领">
                  <Button type="primary" onClick={onClaim}>
                    认领并修改
                  </Button>
                </Tooltip>
              )}
              {/* 已通过的任务是锁死的，要改只能退回重标：轮次+1，这一轮的片段
                  原样带到新一轮，不用从头标 */}
              {onReopen && (
                <Popconfirm
                  title="退回重标？"
                  description="任务轮次 +1，现在这一轮的片段会原样带到新一轮，可以接着改；改完再走一次通过"
                  onConfirm={onReopen}
                >
                  <Button>退回重标</Button>
                </Popconfirm>
              )}
              {/* 从皮肤评估进来时只看抓挠，这时该高亮的是「抓挠确认无误」，
                  「整份通过」退成次要——它认的是全部类别，在这个场景下高亮会误导 */}
              {onApprove && (
                <Popconfirm
                  title={approveConfirmTitle ?? "确认通过这份标注？（连活动/睡觉等全部类别一起认）"}
                  onConfirm={onApprove}
                  disabled={!!onClaim}
                >
                  <Button
                    // 能认领却还没认领时置灰：这时候唯一该点的是「认领并修改」。
                    // 审核页那种"只审不改"的场景没有 onClaim，不受影响
                    disabled={!!onClaim}
                    type={onConfirmScratch ? "default" : "primary"}
                  >
                    {approveText ?? "通过"}
                  </Button>
                </Popconfirm>
              )}
              {onConfirmScratch && (
                <Tooltip title="只把这一类的 AI 片段标成已确认；别的类别、「疑似片段」候选和任务状态都不动">
                  <Button
                    disabled={!!onClaim}
                    type={onClaim ? "default" : "primary"}
                    loading={saving}
                    onClick={handleConfirmScratch}
                  >
                    {confirmScratchText ?? "只认这一类"}
                  </Button>
                </Tooltip>
              )}
            </Space>
          ) : null
        ) : (
          <Space>
            <Button onClick={handleSaveDraft} loading={saving}>
              存草稿
            </Button>
            {!hideSubmit && (
              <Popconfirm title="确认提交？提交后进入审核队列，不能再改" onConfirm={handleSubmit}>
                <Button type={onApprove ? "default" : "primary"} loading={saving}>
                  提交
                </Button>
              </Popconfirm>
            )}
            {/* 自己标自己过（管理员的常规操作）：存草稿 + 提交 + 通过一步到位。
                先落草稿再交给外面走审核链，不然刚改的几段不算数 */}
            {onApprove && (
              <Popconfirm
                title={approveConfirmTitle ?? "存草稿并直接通过？（连活动/睡觉等全部类别一起认，不再进审核队列）"}
                onConfirm={handleSubmitAndApprove}
              >
                <Button type={onConfirmScratch ? "default" : "primary"} loading={saving}>
                  {approveText ?? "提交并通过"}
                </Button>
              </Popconfirm>
            )}
            {/* 不做二次确认：这一步只把这一类的 AI 片段标成已确认，改错了随时能
                再改回来，不是不可逆的操作。而复看是一段接一段地做，每段多点一次
                「确定」纯属白花力气 */}
            {onConfirmScratch && (
              <Tooltip title="先存草稿（刚改的类别/待定都会存下），再把这一类的 AI 片段标成已确认；别的类别和任务状态不动">
                <Button type="primary" loading={saving} onClick={handleConfirmScratch}>
                  {confirmScratchText ?? "只认这一类"}
                </Button>
              </Tooltip>
            )}
          </Space>
        )
      }
    >
      {/* 弹窗里的内容按任务重建：上一个 / 下一个换任务时弹窗不关，视频、波形、片段面板
          从新任务开始，不带上一个任务的状态（筛选、循环区间、刚判过的候选…） */}
      <Fragment key={taskId ?? "none"}>
      <div className={`ws-body${chartExpanded && imuOpen ? " ws-body--charts-expanded" : ""}`}>
      <Spin spinning={loading}>
        {/* 循环状态不用单开一条提示占一整行；「只标窗口」提示已收进标题栏橙色胶囊的顶层气泡里（zIndex 1200），
            既不会被波形/视频浮窗遮挡，也不占正文高度 */}
        {initialSeekMs != null && initialCandFilter != null && (
          // 从找相似跳来的：说清楚定位到了哪一刻、正在循环哪几秒——不然人不知道该看哪一条
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 6 }}
            message={
              <span>
                从「找相似」跳来：命中在 <b>{formatMs(initialSeekMs)}</b>
                {loopRange ? `，正在循环播放 ${formatMs(loopRange.startMs)} ~ ${formatMs(loopRange.endMs)}` : "，已定位到这一刻"}
                {/* 「这一条置顶高亮」以前是写死的——列表里根本没有这一刻的候选时，
                    人会以为是置顶坏了，在几十条里来回找一条不存在的。有没有，说清楚 */}
                {candidates.some((c) => candFocus(c, initialSeekMs))
                  ? "；下面候选列表里这一条已置顶高亮"
                  : "；这一刻没有写成候选，所以下面列表里找不到（看画面就行）"}
              </span>
            }
            action={
              <Space size={4}>
                <Button size="small" onClick={() => { bus.seek(initialSeekMs / 1000); setLoop({ startMs: Math.max(0, initialSeekMs - 2000), endMs: initialSeekMs + 4000 }); }}>再定位</Button>
                {loopRange && <Button size="small" onClick={() => setLoop(null)}>停止循环</Button>}
              </Space>
            }
          />
        )}
        {/* 有画面、但比该场地应有的少：影棚该三路、狗场该两路。原来这里一声
            不吭，人对着一路画面只能猜是平台坏了 */}
        {videos.length > 0 && videoNote && (
          <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={videoNote} />
        )}
        {videos.length > 0 ? (
          <SyncedVideoGroup
            videos={videos}
            bus={bus}
            fps={fps}
            fill
            controlsPortalTarget={controlsHost}
          />
        ) : (
          !loading && (
            <Empty
              description={
                <div style={{ maxWidth: 560, margin: "0 auto" }}>
                  <div>没有找到可播放的视频</div>
                  {videoWhy && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {videoWhy}
                    </Typography.Text>
                  )}
                </div>
              }
            />
          )
        )}

        {roCreateAllowed && !roCreate && (
          <div style={{ margin: "8px 0", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Tooltip title="不用认领：选标签后用「标起点 / 标终点」或在波形上拖，标出来的直接存库、算你通过">
              <Button size="small" icon={<PlusOutlined />} onClick={() => setRoCreate(true)}>新建片段</Button>
            </Tooltip>
            {/* 「已隐藏」跟按钮并排：单独一行会把下面的面板区整体往下压一截 */}
            {hiddenPanelKeys.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>已隐藏：</Typography.Text>
                {hiddenPanelTags}
              </>
            )}
          </div>
        )}
        {/* 「已隐藏」放在面板区最上面（IMU 波形上面）：夹在波形和片段列表中间看着像哪个面板的一部分。
            查看模式里已经跟「新建片段」并排了，这里就不重复占一行 */}
        {hiddenPanelKeys.length > 0 && !(roCreateAllowed && !roCreate) && (
          <div style={{ marginTop: 6, marginBottom: 2, fontSize: 12, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <Typography.Text type="secondary">已隐藏：</Typography.Text>
            {hiddenPanelTags}
          </div>
        )}
        {pinnedImu && renderPanel("imu")}


        {/* 占满视频下面剩余的高度，面板在这个框里滚——想看列表最后几条不用把视频滚出屏幕。
            面板全收起来时不再占着剩余高度（写死 flex:1 的话折叠了照样撑着一大片空白）。
            每个面板的标题行在这个框里吸顶：滚到候选列表下面时，「待确认 / 画面相似 / 找相似」
            那排按钮还在最上面，不用滚回去找 */}
        <div
          className="ws-segs"
          style={{
            marginTop: 8,
            flex: anyOpenInside ? "1 1 auto" : "0 0 auto",
            minHeight: anyOpenInside ? 140 : 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {shownPanels.filter((k) => !(pinnedImu && k === "imu")).map(renderPanel)}
        </div>
      </Spin>
      </div>
      </Fragment>
    </Modal>
    {/* 机位纠正：标着标着发现画面挂错了屋子，就地循环这一段换过来 */}
    <CamFixModal
      open={camFixOpen}
      sampleId={sampleId}
      startMs={camFixRange[0]}
      endMs={camFixRange[1]}
      onClose={() => setCamFixOpen(false)}
      onApplied={reloadAfterCamFix}
    />
    {/* 夜视增强：夜里那几路黑得看不出狗在干嘛时，把那一刻捞出来看清楚。
        放在工作台这一层而不是片段面板里——它要用 sampleId，而且弹窗不该
        嵌在表格行里 */}
    <LowlightModal
      sampleId={NIGHT_VISION && lowlightAt != null ? sampleId : null}
      cams={camList}
      startS={(lowlightAt?.[0] ?? 0) / 1000}
      endS={(lowlightAt?.[1] ?? 0) / 1000}
      label={task?.sample_code ?? undefined}
      onClose={() => setLowlightAt(null)}
    />
    </>
  );
}
