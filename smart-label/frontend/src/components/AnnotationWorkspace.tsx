import { useEffect, useMemo, useRef, useState } from "react";
import InferModeHelp from "@/components/InferModeHelp";
import {
  Button,
  Empty,
  Modal,
  Popconfirm,
  Collapse,
  Segmented,
  Space,
  Spin,
  Tag,
  Radio,
  Tooltip,
  Typography,
  message, Select, Input, InputNumber, Checkbox, Table
} from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, EyeInvisibleOutlined, LockOutlined, ThunderboltOutlined, UnlockOutlined } from "@ant-design/icons";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { aiPrelabel, getAiLabelInfo, getSampleMedia, scratchCrosscheck, type AiLabelInfo, type ScratchCross } from "@/api/samples";
import { getImuMeta } from "@/api/imu";
import SegmentPanel, { formatMs } from "@/components/SegmentPanel";
import CandidatePanel from "@/components/CandidatePanel";
import SimilarFramePreview from "@/components/SimilarFramePreview";
import SimilarHitsGrid from "@/components/SimilarHitsGrid";
import { clearSimilarCandidates, findSimilarCandidates, repairCandidateItems, decideCandidate, listCandidates, type AiCandidate, type SimilarHit } from "@/api/candidates";
import { getDraft, heartbeat, saveDraft, submitTask } from "@/api/tasks";
import ImuChart, { ImuChartHint, type ChartSegment } from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import { hintOf, modeLabelOf, type InferMode } from "@/utils/inferMode";
import { INFER_SELECT_PROPS, useInferModes } from "@/hooks/useInferModes";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { getSavedBool, getSavedHeight, getSavedKeys, saveBool, saveHeight, saveKeys } from "@/utils/persistedSize";
import { chainOf, childrenMap, descendantIds, flatten as flattenLabels, related as labelsRelated, shortName } from "@/utils/labelTree";
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
  labels: LabelDefinition[];
  /** 只读模式：审核/已提交的任务只能看不能改 */
  readOnly?: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  /** 审核员看完可以直接在这里下结论，省得关掉再回列表点 */
  onApprove?: () => void | Promise<void>;
  onReject?: () => void;
  /** 「通过」按钮上写什么（皮肤复看那边叫「确认无误」，语义更贴那个场景） */
  approveText?: string;
  /** 打开就跳到这个时刻（相对 CSV 起点的毫秒）。从别处点「去修」进来时用 */
  initialSeekMs?: number | null;
  /** 从找相似的链接进来：候选面板默认只看「画面相似」，并把 initialSeekMs 那条排最前 */
  initialCandFilter?: "similar" | null;
  /** 只读状态下想动手改：认领这个任务，转成可编辑。给了才显示这个按钮 */
  onClaim?: () => void | Promise<void>;
  /** 已通过的任务想再改：退回重标（轮次+1，上一轮内容原样带过去） */
  onReopen?: () => void | Promise<void>;
  /** 只认某一类（皮肤复看那边是「抓挠」）标得对，不动别的类别和任务状态 */
  onConfirmScratch?: () => void | Promise<void>;
  /** 上面那个按钮写什么 */
  confirmScratchText?: string;
}

interface VideoSrc {
  label: string;
  url: string;
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
const CHART_MODE_KEY = "smart-label:chart-expanded";
const CHART_HEIGHT_KEY = "smart-label:chart-area-height";
const CHART_EXPANDED_HEIGHT_KEY = "smart-label:chart-area-height-expanded";
const CHART_SCROLL_LOCK_KEY = "smart-label:chart-scroll-locked";
// IMU 波形整块的展开/折叠，和下面两个面板的展开状态：都记成用户的习惯
const IMU_OPEN_KEY = "smart-label:imu-open";
const PANELS_KEY = "smart-label:ws-panels";

// 标注工作台：视频 + IMU 波形 + 打标签。选个标签直接在波形上拖出一段即可，
// 时间点不用手填毫秒，所见即所得。
export default function AnnotationWorkspace({
  task,
  focusLabelName,
  focusLabelIds,
  labels,
  readOnly,
  onClose,
  onSubmitted,
  onApprove,
  onReject,
  approveText,
  onClaim,
  initialSeekMs,
  initialCandFilter,
  onReopen,
  onConfirmScratch,
  confirmScratchText,
}: Props) {
  const taskId = task?.id ?? null;
  const sampleId = task?.sample_id ?? null;
  const role = useAuthStore((s) => s.userInfo?.role);

  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  // 没视频时用来解释是缺哪一步：样本上就没登记，还是登记了但媒体库里找不到
  const [videoWhy, setVideoWhy] = useState<string | null>(null);
  // 播放速度/帧号控件 portal 的目标节点：挂在弹窗标题里的一个空 span 上
  const [controlsHost, setControlsHost] = useState<HTMLSpanElement | null>(null);
  // 「疑似抓挠」那排筛选/翻页 portal 到它的折叠标题行上，省两行高度
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
  // 展开时要"一屏看全六轴"，所以行高不能写死，得按波形区实际拿到多少高度算
  const chartBoxRef = useRef<HTMLDivElement | null>(null);
  const [chartBoxH, setChartBoxH] = useState(0);
  // 单条波形模式下这块区域的高度，可以拖底边把手调整；跟视频区一样记到
  // localStorage，下次打开别的任务不用重新拖
  const [singleHeight, setSingleHeight] = useState(() => getSavedHeight(CHART_HEIGHT_KEY) ?? CHART_VIEWPORT_PX);
  const [expandedHeight, setExpandedHeight] = useState(
    () => getSavedHeight(CHART_EXPANDED_HEIGHT_KEY) ?? CHART_EXPANDED_PX
  );
  // 单条波形模式下滚轮很容易不小心把波形区滚到别的通道去，锁住之后波形区不响应
  // 滚动，想看别的通道再解锁。是否锁定记住成用户的习惯，下次打开别的任务沿用。
  const [chartScrollLocked, setChartScrollLocked] = useState(() => getSavedBool(CHART_SCROLL_LOCK_KEY, false));
  // 当前模式用哪一份高度。切模式 = 换一份记忆，互不影响
  const chartHeight = chartExpanded ? expandedHeight : singleHeight;
  const setChartHeight = chartExpanded ? setExpandedHeight : setSingleHeight;
  const chartHeightKey = chartExpanded ? CHART_EXPANDED_HEIGHT_KEY : CHART_HEIGHT_KEY;
  const chartHeightDefault = chartExpanded ? CHART_EXPANDED_PX : CHART_VIEWPORT_PX;
  // 复看抓挠时波形其实用得不多（主要看视频），可以整块折起来把地方让给视频；
  // 想看再展开。跟下面两个面板一样，记住各人自己的习惯
  const [imuOpen, setImuOpen] = useState(() => getSavedBool(IMU_OPEN_KEY, true));
  const [panelKeys, setPanelKeys] = useState<string[]>(() => getSavedKeys(PANELS_KEY, ["segs"]));
  // 四个面板的先后顺序和哪些被藏起来了：也是用户习惯，记住
  const [panelOrder, setPanelOrder] = useState<PanelKey[]>(loadOrder);
  const [panelHidden, setPanelHidden] = useState<PanelKey[]>(loadHidden);

  const [items, setItems] = useState<LabelItem[]>([]);
  // 疑似抓挠候选：不在草稿里，单独一张表，人工逐条确认/排除
  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
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
  // 「找相似」：视频当前在第几秒（高频更新，放 ref 不放 state）
  const curSecRef = useRef(0);
  useEffect(() => bus.onTime((sec) => { curSecRef.current = sec; }), [bus]);
  const [similarOpen, setSimilarOpen] = useState(false);
  const [similarLabel, setSimilarLabel] = useState<string | null>(null);
  const [similarText, setSimilarText] = useState("");
  const [similarUseText, setSimilarUseText] = useState(false);
  const [similarScope, setSimilarScope] = useState<"project" | "task">("project");
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
  // 「先看命中」：只搜不写，把命中的画面摆出来看
  const [similarPeek, setSimilarPeek] = useState<{ hits: SimilarHit[]; refPath: string | null; refT: number | null; centered: boolean; poseUsed: boolean } | null>(null);
  const [similarPeeking, setSimilarPeeking] = useState(false);
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
        dry_run: true,
      });
      setSimilarPeek({ hits: r.hit_list, refPath: r.ref_path, refT: similarUseText ? null : similarAtSec, centered: r.centered, poseUsed: r.pose_used });
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
  // 点 X 关掉就当作「不看这一段了」，顺手停掉循环；同一个任务再进来是同一个 bus，
  // 不清的话循环会跟着带回来
  const handleClose = () => {
    bus.setLoop(null);
    onClose();
  };

  useEffect(() => {
    if (taskId == null || sampleId == null) {
      setVideos([]);
      setVideoWhy(null);
      setHasCsv(false);
      setFps(null);
      setItems([]);
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
      const entries: [string, number | null][] = [
        ["视角1", media.video1_id],
        ["视角2", media.video2_id],
        ["视角3", media.video3_id],
      ];
      const vids: VideoSrc[] = [];
      for (const [label, id] of entries) {
        if (id == null) continue;
        const { token } = await getMediaToken(id);
        vids.push({ label, url: mediaStreamUrl(id, token) });
      }
      setVideos(vids);
      setVideoWhy(
        vids.length > 0
          ? null
          : media.video_missing_in_library.length > 0
            ? `样本上登记了 ${media.video_missing_in_library.length} 路视频，但媒体库里没有这些文件：${media.video_missing_in_library.join("、")}。多半是没传上 NAS，或者传了还没被扫到——去「样本」页点一次「立即扫描」再看。`
            : "这个样本上就没有登记视频文件。采集/归档时这一路只上传了 IMU 数据（比如 imu4 那种只传 csv 的），或者视频还没归档过来。IMU 波形和片段列表照常能用，只是没法对着画面核对。"
      );
      setHasCsv(media.csv_id != null);
      setFps(media.video_fps);
      // 从别处点「去修」进来的：直接停在出问题的那一刻，不用自己拖进度条找
      if (initialSeekMs != null) bus.seek(initialSeekMs / 1000);
      if (media.csv_id != null) {
        getImuMeta(sampleId)
          .then((m) => setDurationMs(m.duration_ms))
          .catch(() => setDurationMs(null));
      } else {
        setDurationMs(null);
      }

      const draft = await getDraft(taskId);
      setItems(draft.items);
      listCandidates(taskId)
        .then((cs) => {
          setCandidates(cs);
          // 从找相似的链接进来（?seek=&cand=similar）：直接把那一段设成循环播放，不用人再去找
          if (initialSeekMs != null && initialCandFilter === "similar") {
            const hit = cs.find((c) => c.reason === "similar" && Math.abs(c.start_time_ms - initialSeekMs) < 1500);
            if (hit) setLoop({ startMs: hit.start_time_ms, endMs: hit.end_time_ms });
          }
        })
        .catch(() => setCandidates([]));
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
  // 层级标签：第一行只摆大类（没有上级的），选了哪个大类下面才展开它的子类，再下一层同理
  const labelChildren = useMemo(() => childrenMap(labels), [labels]);
  const labelRows = useMemo(() => {
    const rows: { parent: LabelDefinition | null; items: LabelDefinition[] }[] = [{ parent: null, items: labelChildren.get(null) ?? [] }];
    if (labelId != null) {
      for (const node of chainOf(labelById, labelId)) {
        const kids = labelChildren.get(node.id) ?? [];
        if (kids.length) rows.push({ parent: node, items: kids });
      }
    }
    return rows.slice(0, ROW_KEYS.length);
  }, [labels, labelId, labelChildren, labelById]);
  const selectedChain = useMemo(() => new Set(labelId != null ? chainOf(labelById, labelId).map((l) => l.id) : []), [labelId, labelById]);
  const colorOf = (id: number) =>
    labelById.get(id)?.color || FALLBACK_COLORS[id % FALLBACK_COLORS.length];
  const nameOf = (id: number) => labelById.get(id)?.display_name ?? `#${id}`;

  const segments: ChartSegment[] = useMemo(
    () =>
      items.map((i) => ({
        start_time_ms: i.start_time_ms,
        end_time_ms: i.end_time_ms,
        color: colorOf(i.label_id),
        label: nameOf(i.label_id),
      })),
    [items, labels]
  );

  const appendItem = (startMs: number, endMs: number, forLabel: number) => {
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
    return next;
  };

  const updateItems = (ids: number[], patch: Partial<LabelItem>) => {
    const set = new Set(ids);
    setItems((prev) => prev.map((it) => (set.has(it.id) ? touchItem(it, patch) : it)));
  };

  // 在波形上直接拖出来一段（参考工具的主要标注方式）
  const handleCreateFromChart = (startMs: number, endMs: number) => {
    if (labelId == null) return;
    appendItem(startMs, endMs, labelId);
  };

  // 拖已有色块的左右边缘改时间
  const handleResizeFromChart = (index: number, startMs: number, endMs: number) => {
    setItems((prev) =>
      prev.map((it, i) =>
        i === index
          ? touchItem(it, { start_time_ms: Math.round(Math.max(0, startMs)), end_time_ms: Math.round(Math.max(0, endMs)) })
          : it
      )
    );
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
      }));

  const persist = async () => {
    if (taskId == null) return;
    await saveDraft(taskId, toDraftPayload(items));
  };

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
        .then((d) => setItems(d.items))
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
    if (!el || !chartExpanded) return;
    const ro = new ResizeObserver(() => setChartBoxH(el.clientHeight));
    ro.observe(el);
    setChartBoxH(el.clientHeight);
    return () => ro.disconnect();
  }, [chartExpanded, imuView, videos]);

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
    if (taskId == null || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // 取消选中 -> 回到拖动平移模式
        setLabelId(null);
        return;
      }
      const k = e.key.toLowerCase();
      for (let r = 0; r < labelRows.length; r++) {
        const idx = ROW_KEYS[r].indexOf(k);
        if (idx < 0 || idx >= labelRows[r].items.length) continue;
        e.preventDefault();
        const id = labelRows[r].items[idx].id;
        // 再按一次同一个键就取消选中，跟点按钮的行为一致
        setLabelId((prev) => (prev === id ? null : id));
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, readOnly, labelRows]);

  // ── 下面四个面板 ─────────────────────────────────────────────────────
  // 每个面板一个 Collapse，按 panelOrder 的顺序摆，panelHidden 里的不摆。
  // 面板标题右边有「上移 / 下移 / 隐藏」三个小按钮；隐藏了的在面板区上方留一个
  // 「已隐藏」标签，点一下恢复。顺序、隐藏、展开状态都记在 localStorage 里。
  const hasCross = !!(cross && (cross.items.length || cross.note));
  // 当前任务里实际存在的面板（没跑过画面对照就没有那一块），按用户顺序
  const presentPanels: PanelKey[] = panelOrder.filter((k) => k !== "cross" || hasCross);
  const shownPanels = presentPanels.filter((k) => !panelHidden.includes(k));
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
                options={["单条波形", "展开全部"]}
                value={chartExpanded ? "展开全部" : "单条波形"}
                onChange={(v) => {
                  const next = v === "展开全部";
                  setChartExpanded(next);
                  saveBool(CHART_MODE_KEY, next);
                }}
              />
            </>
          )}
          {imuView === "曲线图" && <ImuChartHint />}
          {imuView === "曲线图" && !chartExpanded && (
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
            <ImuChart
              sampleId={sampleId}
              bus={bus}
              rowHeight={chartExpanded && chartBoxH > 0 ? expandedRowHeight : undefined}
              // 展开全部时六条共用最下面那一条时间轴：六条各画一条，
              // 光轴就吃掉一百多像素，而横轴本来就是同一条时间线
              timeAxisOnlyLast={chartExpanded}
              key={chartExpanded ? "expanded" : "single"}
              segments={segments}
              activeColor={readOnly || labelId == null ? null : colorOf(labelId)}
              onCreateSegment={readOnly ? undefined : handleCreateFromChart}
              onResizeSegment={readOnly ? undefined : handleResizeFromChart}
            />
          </div>
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
        controlsPortalTarget={segControlsHost}
        focusMs={initialSeekMs}
        items={items}
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
        onDelete={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
        onReturnToCandidate={async (i) => {
          if (i.from_candidate_id == null || taskId == null) return;
          // 先把候选放回「待确认」，再把这条片段从草稿里去掉并落库——
          // 只删片段不动候选的话，那条候选还挂着"已确认"，再也不会出现
          await decideCandidate(i.from_candidate_id, "pending");
          const next = items.filter((x) => x.id !== i.id);
          setItems(next);
          await saveDraft(taskId, toDraftPayload(next));
          setCandidates(await listCandidates(taskId));
          message.success("已退回候选，可以重新判断");
        }}
        onCreate={readOnly ? undefined : appendItem}
        initialFilterLabels={initialSegmentFilter}
      />
    ),
  };

  const candsItem = {
    key: "cands",
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {candidates.some((c) => c.reason === "vision")
          ? "疑似片段"
          : candidates.some((c) => c.reason === "grooming")
            ? "疑似抓挠 / 舔啃"
            : "疑似抓挠"}（
        {candidates.filter((c) => c.status === "pending").length} 待确认 / {candidates.length}）
        <span ref={setCandControlsHost} style={{ display: "inline-flex" }} />
      </span>
    ),
    children: (
      <CandidatePanel
        controlsPortalTarget={candControlsHost}
        candidates={candidates}
        labels={labels}
        focusMs={initialSeekMs}
        initialFilter={initialCandFilter ?? undefined}
        onFindSimilar={
          readOnly
            ? undefined
            : () => {
                setSimilarAtSec(Math.round(curSecRef.current * 10) / 10);
                setSimilarOpen(true);
              }
        }
        onTogglePlay={() => bus.play("toggle")}
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
        onDecided={async () => {
          if (taskId == null) return;
          const [draft, cs] = await Promise.all([getDraft(taskId), listCandidates(taskId)]);
          setItems(draft.items);
          setCandidates(cs);
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
          setItems(next);
          setCandidates(await listCandidates(taskId));
        }}
      />
    ),
  };

  const renderPanel = (k: PanelKey) => {
    const item = k === "imu" ? imuItem : k === "cross" ? crossItem : k === "segs" ? segsItem : candsItem;
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
    <Modal
      title="找相似的画面 → 候选"
      open={similarOpen}
      onCancel={() => setSimilarOpen(false)}
      width={similarPeek ? 1000 : 640}
      destroyOnClose
      afterClose={() => setSimilarPeek(null)}
      footer={
        <Space>
          <Button onClick={() => setSimilarOpen(false)}>取消</Button>
          <Tooltip title="只搜不写：把命中的画面（狗框那一块）跟样例并排摆出来，看着对再写候选；不对就换一帧 / 调参数再看">
            <Button loading={similarPeeking} disabled={similarUseText && !similarText.trim()} onClick={peekSimilar}>
              先看命中
            </Button>
          </Tooltip>
          <Button type="primary" loading={similarRunning} disabled={!similarLabel || (similarUseText && !similarText.trim())} onClick={runSimilar}>
            {similarPeek ? "写入候选" : "找"}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          拿当前画面（狗框出来那一块）的向量，在已建索引的视频里找长得像的几秒，写成候选。
          不问大模型、不花钱、几秒出结果；粗，"长得像"不等于同一个动作，人再确认。
          命中是按秒的，一次舔往往持续几十秒、命中断断续续，所以相邻命中会按下面的间隔合成一段。
          先在项目页「建画面索引」，没建的视频搜不到。狗场只搜每只狗自己房间那一路（公共区对不上是哪只狗）；影棚三路都是公共的，命中要看清是哪只。
        </Typography.Text>
        <div>
          <Typography.Text style={{ marginRight: 8 }}>标成：</Typography.Text>
          <Select
            size="small"
            style={{ minWidth: 300 }}
            mode="tags"
            maxCount={1}
            showSearch
            // 选项按层级缩进、带颜色（跟候选面板「改成别的」一样）；搜索按名字匹配
            filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
            listHeight={380}
            placeholder="找到的段打什么标签；没有的直接打字回车，会新建"
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
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            没有的标签（比如「舔后抓」）直接打字回车，找到就顺手建进项目
          </Typography.Text>
        </div>
        <Checkbox checked={similarUseText} onChange={(e) => setSimilarUseText(e.target.checked)}>
          不用当前画面，用一句英文描述搜（如 dog licking its tail）
        </Checkbox>
        {similarUseText ? (
          <Input size="small" value={similarText} onChange={(e) => setSimilarText(e.target.value)} placeholder="dog licking its tail" />
        ) : (
          <div>
            <Space size={6} style={{ marginBottom: 6 }} wrap>
              <Typography.Text>样例：视角1 第</Typography.Text>
              <InputNumber
                size="small"
                min={0}
                step={0.5}
                value={similarAtSec}
                onChange={(v) => setSimilarAtSec(Math.max(0, Math.round((v ?? 0) * 10) / 10))}
                style={{ width: 90 }}
              />
              <Typography.Text>秒那一帧</Typography.Text>
              <Button size="small" onClick={() => setSimilarAtSec(Math.round(curSecRef.current * 10) / 10)}>
                用视频当前时刻
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                先在视频里停到最像的那一帧再点「找相似」；下面是这一帧框到的狗
              </Typography.Text>
            </Space>
            {taskId != null && <SimilarFramePreview taskId={taskId} tSec={similarAtSec} />}
          </div>
        )}
        <Space wrap>
          <span>
            范围：
            <Select size="small" value={similarScope} onChange={(v) => setSimilarScope(v)} style={{ width: 130 }}
              options={[{ value: "project", label: "整个项目" }, { value: "task", label: "只在本任务" }]} />
          </span>
          <span>
            最多取：
            <InputNumber size="small" min={1} max={2000} value={similarTopK} onChange={(v) => setSimilarTopK(v ?? 60)} style={{ width: 90 }} /> 个命中
          </span>
          <span>
            隔
            <InputNumber size="small" min={0} max={120} value={similarGap} onChange={(v) => setSimilarGap(v ?? 15)} style={{ width: 70 }} /> 秒以内算同一段
          </span>
          <Tooltip title="同一只狗、同一间房、同一块地板，每一帧的向量里都带着这坨共同背景，原始相似度全在 0.95 以上分不开。减掉所有帧的平均向量再比，剩下的才是姿态和部位的差别。不勾就按原始相似度">
            <Checkbox checked={similarCenter} onChange={(e) => setSimilarCenter(e.target.checked)}>
              去共同背景
            </Checkbox>
          </Tooltip>
          <Tooltip title="第二路信号：狗的姿态关键点（鼻子、脖子、尾根、四爪…）算出来的「鼻子够到了哪只爪」。0 只看画面，1 只看姿态。算法机上没装姿态模型时自动只看画面（先看命中的说明里会写）">
            <span>
              姿态占
              <InputNumber size="small" min={0} max={1} step={0.1} value={similarPoseW} onChange={(v) => setSimilarPoseW(Math.max(0, Math.min(1, v ?? 0.5)))} style={{ width: 70, margin: "0 4px" }} />
            </span>
          </Tooltip>
        </Space>
        {similarPeek && taskId != null && (
          <SimilarHitsGrid
            taskId={taskId}
            refPath={similarPeek.refPath}
            refT={similarPeek.refT}
            hits={similarPeek.hits}
            centered={similarPeek.centered}
            poseUsed={similarPeek.poseUsed}
            onJump={(h) => {
              if (h.task_id === taskId) {
                const ms = Math.round(h.t * 1000);
                setLoop({ startMs: Math.max(0, ms - 2000), endMs: ms + 4000 });
                bus.seek(Math.max(0, h.t - 2));
              } else if (h.task_id != null) {
                window.open(`/tasks?task=${h.task_id}&seek=${Math.round(h.t * 1000)}`, "_blank");
              }
            }}
          />
        )}
      </Space>
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
        <div style={{ display: "flex", width: "100%", alignItems: "center", gap: 8 }}>
        <Space wrap style={{ flex: 1, minWidth: 0 }}>
          <span>{readOnly ? "查看标注" : "标注"} - 任务 #{taskId}</span>
          {/* 一个画面里同时有四只狗，这条 IMU 是谁身上的必须一眼看见，
              不然逐条确认时很容易确认成别的狗的动作 */}
          {task?.dog_label && (
            <Tag color="purple" style={{ fontSize: 14, padding: "2px 10px", fontWeight: 600 }}>
              🐕 {task.dog_label}
            </Tag>
          )}
          <Tag>
            {/* 带上日期：这个标题栏里没有项目名，不写日期就不知道是哪天的数据 */}
            样本 {task?.sample_code ? sampleDisplayName(task.sample_code, task.video_duration_sec, role, true) : sampleId}
            {task?.video_duration_sec ? ` · ${formatDuration(task.video_duration_sec)}` : ""}
          </Tag>
          {/* 播放速度/帧号控件从视频区上方 portal 到这里，跟标题拼一行，省出来的高度给视频用 */}
          <span ref={setControlsHost} style={{ display: "inline-flex" }} />
        </Space>
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
      // body 高度卡死在一屏，视频/波形按这一屏分配；片段列表展开后超出的部分
      // 让 body 自己滚（overflow:auto），不再裁掉——外层页面滚动条是 antd 弹窗
      // 容器的，被视频/波形区域的滚轮事件拦住滚不动，靠它没用。
      styles={{ body: { height: "calc(100vh - 108px)", overflowY: "auto", overflowX: "hidden", paddingTop: 8 } }}
      destroyOnClose
      footer={
        readOnly ? (
          // 注意：这里必须给 null 而不是 undefined。footer 传 undefined 时
          // antd 会当成"没设置"，渲染它默认的 取消/确定 两个按钮。
          onApprove || onReject || onClaim || onReopen ? (
            <Space>
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
                  title="确认通过这份标注？（连活动/睡觉等全部类别一起认）"
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
                <Tooltip title="只把这一类的 AI 片段标成已确认；别的类别、「疑似抓挠」候选和任务状态都不动">
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
            <Popconfirm title="确认提交？提交后进入审核队列，不能再改" onConfirm={handleSubmit}>
              <Button type={onApprove ? "default" : "primary"} loading={saving}>
                提交
              </Button>
            </Popconfirm>
            {/* 自己标自己过（管理员的常规操作）：存草稿 + 提交 + 通过一步到位。
                先落草稿再交给外面走审核链，不然刚改的几段不算数 */}
            {onApprove && (
              <Popconfirm
                title="存草稿并直接通过？（连活动/睡觉等全部类别一起认，不再进审核队列）"
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
      <div className={`ws-body${chartExpanded && imuOpen ? " ws-body--charts-expanded" : ""}`}>
      <Spin spinning={loading}>
        {/* 循环状态不用单开一条提示占一整行：那一行的按钮跟片段行里的
            「停止播放」是同一件事，而正在循环哪一段，那一行自己就写着 */}
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

        {!readOnly && (
          <div style={{ margin: "12px 0", padding: 8, background: "#fafafa", borderRadius: 4 }}>
            <Space wrap size={6} style={{ marginBottom: 8 }}>
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
                    return (
                      <Button
                        key={l.id}
                        size="small"
                        onClick={() => setLabelId(selected ? null : l.id)}
                        style={{
                          borderColor: c,
                          color: selected ? "#fff" : c,
                          background: selected ? c : "#fff",
                          fontWeight: selected || onPath ? 600 : 400,
                          boxShadow: onPath ? `inset 0 0 0 1px ${c}` : undefined,
                        }}
                      >
                        {row.parent ? shortName(labelById, l) : l.display_name}
                        {kids > 0 && <span style={{ marginLeft: 3, opacity: 0.6, fontSize: 10 }}>▾</span>}
                        {i < ROW_KEYS[r].length && (
                          <span style={{ marginLeft: 6, opacity: 0.65, fontSize: 11 }}>{ROW_KEYS[r][i]}</span>
                        )}
                      </Button>
                    );
                  })}
                </span>
              ))}
              {labels.length === 0 && (
                <Typography.Text type="secondary">还没有标签，先去「标签管理」里建</Typography.Text>
              )}
              {hasCsv && sampleId != null && labels.length > 0 && (
                /* 误点一下就重跑一遍模型，代价不小：没人碰过的 AI 片段会被整批
                   换掉。所以问一句，并且把"会保留几段人工成果"写清楚 */
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
                  <Button size="small" icon={<ThunderboltOutlined />} loading={prelabeling} style={{ marginLeft: 8 }}>
                    AI预标注
                  </Button>
                </Popconfirm>
              )}
              {/* 原来是 Radio.Group（按钮条）。加上端侧模型之后它**不支持分组**，
                  线上和端侧会混在一排看不出区别；选项也从 3 个变成 5 个。换成 Select。 */}
              {hasCsv && sampleId != null && labels.length > 0 && (
                <Tooltip title={hintOf(prelabelMode)}>
                  <Select
                    size="small"
                    {...INFER_SELECT_PROPS}
                    value={prelabelMode}
                    onChange={(v) => setPrelabelMode(v as InferMode)}
                    options={inferOptions}
                  />
                </Tooltip>
              )}
              {hasCsv && sampleId != null && labels.length > 0 && <InferModeHelp />}
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
                  <Tag style={{ marginLeft: 4 }}>
                    当前：{aiInfo.mode ? modeLabelOf(aiInfo.mode) : "未知版本"}
                    {aiInfo.model_path ? ` · ${aiInfo.model_path.split("/").slice(-1)[0]}` : ""}
                  </Tag>
                </Tooltip>
              )}
            </Space>
          </div>
        )}
        {pinnedImu && renderPanel("imu")}

        {panelHidden.some((k) => presentPanels.includes(k)) && (
          <div style={{ marginTop: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <Typography.Text type="secondary">已隐藏：</Typography.Text>
            {panelHidden.filter((k) => presentPanels.includes(k)).map((k) => (
              <Tooltip key={k} title="点一下恢复显示">
                <Tag style={{ cursor: "pointer" }} onClick={() => showPanel(k)}>
                  {PANEL_TITLES[k]}
                </Tag>
              </Tooltip>
            ))}
          </div>
        )}

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
    </Modal>
    </>
  );
}
