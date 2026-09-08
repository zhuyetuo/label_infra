import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
  message,
} from "antd";
import { LockOutlined, ThunderboltOutlined, UnlockOutlined } from "@ant-design/icons";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { aiPrelabel, getSampleMedia } from "@/api/samples";
import { getImuMeta } from "@/api/imu";
import SegmentPanel, { formatMs } from "@/components/SegmentPanel";
import CandidatePanel from "@/components/CandidatePanel";
import { decideCandidate, listCandidates, type AiCandidate } from "@/api/candidates";
import { getDraft, heartbeat, saveDraft, submitTask } from "@/api/tasks";
import ImuChart, { type ChartSegment } from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";
import { useAuthStore } from "@/stores/authStore";
import { INFER_MODE_OPTIONS, type InferMode } from "@/utils/inferMode";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { getSavedBool, getSavedHeight, saveBool, saveHeight } from "@/utils/persistedSize";
import "./AnnotationWorkspace.css";
import type { LabelDefinition, LabelItem, Task } from "@/types";

interface Props {
  task: Task | null;
  /** 打开时片段列表默认只筛这个标签（皮肤跟踪表跳过来复看「抓挠」用） */
  focusLabelName?: string | null;
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
// 快捷键顺序跟参考工具一致：1-9、0，然后 q w e r t y，再 a s d f g h
const HOTKEYS = "1234567890qwertyasdfgh".split("");
// 波形区（单条波形模式）默认露出的高度：六条通道全都渲染在里面，这个盒子只
// 卡住"一条通道 + 顶部说明 + 底部日期行"的高度，刚好够，多出来的部分往下滚
// 才看得到，不占视频的地盘。
const CHART_VIEWPORT_PX = 185;
const CHART_HEIGHT_KEY = "smart-label:chart-area-height";
const CHART_SCROLL_LOCK_KEY = "smart-label:chart-scroll-locked";

// 标注工作台：视频 + IMU 波形 + 打标签。选个标签直接在波形上拖出一段即可，
// 时间点不用手填毫秒，所见即所得。
export default function AnnotationWorkspace({
  task,
  focusLabelName,
  labels,
  readOnly,
  onClose,
  onSubmitted,
  onApprove,
  onReject,
  approveText,
  onClaim,
  onReopen,
  onConfirmScratch,
  confirmScratchText,
}: Props) {
  const taskId = task?.id ?? null;
  const sampleId = task?.sample_id ?? null;
  const role = useAuthStore((s) => s.userInfo?.role);

  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  // 播放速度/帧号控件 portal 的目标节点：挂在弹窗标题里的一个空 span 上
  const [controlsHost, setControlsHost] = useState<HTMLSpanElement | null>(null);
  const [hasCsv, setHasCsv] = useState(false);
  const [prelabeling, setPrelabeling] = useState(false);
  // 稳定版（平滑合并）/ 调试版（逐窗口原始输出），默认稳定版
  const [prelabelMode, setPrelabelMode] = useState<InferMode>("stable");
  // IMU 总时长，片段列表算"预测覆盖了多少、哪里是空白"要用
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");
  // 默认只露一条波形把高度让给视频；想通盘看六轴时切到"展开全部"，
  // 波形区改为占满剩余高度，视频相应缩小
  const [chartExpanded, setChartExpanded] = useState(false);
  // 展开时要"一屏看全六轴"，所以行高不能写死，得按波形区实际拿到多少高度算
  const chartBoxRef = useRef<HTMLDivElement | null>(null);
  const [chartBoxH, setChartBoxH] = useState(0);
  // 单条波形模式下这块区域的高度，可以拖底边把手调整；跟视频区一样记到
  // localStorage，下次打开别的任务不用重新拖
  const [chartHeight, setChartHeight] = useState(() => getSavedHeight(CHART_HEIGHT_KEY) ?? CHART_VIEWPORT_PX);
  // 单条波形模式下滚轮很容易不小心把波形区滚到别的通道去，锁住之后波形区不响应
  // 滚动，想看别的通道再解锁。是否锁定记住成用户的习惯，下次打开别的任务沿用。
  const [chartScrollLocked, setChartScrollLocked] = useState(() => getSavedBool(CHART_SCROLL_LOCK_KEY, false));

  const [items, setItems] = useState<LabelItem[]>([]);
  // 疑似抓挠候选：不在草稿里，单独一张表，人工逐条确认/排除
  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  const [labelId, setLabelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const bus = useMemo(() => new TimeBus(), [taskId]);
  // 片段区间循环：真正的循环逻辑在 bus/视频组件里跑，这里只留一份给按钮高亮/顶部提示用
  const [loopRange, setLoopRange] = useState<{ startMs: number; endMs: number } | null>(null);
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
      setHasCsv(false);
      setFps(null);
      setItems([]);
      setDurationMs(null);
      return;
    }
    setLoading(true);
    setImuView("曲线图");
    (async () => {
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
      setHasCsv(media.csv_id != null);
      setFps(media.video_fps);
      if (media.csv_id != null) {
        getImuMeta(sampleId)
          .then((m) => setDurationMs(m.duration_ms))
          .catch(() => setDurationMs(null));
      } else {
        setDurationMs(null);
      }

      const draft = await getDraft(taskId);
      setItems(draft.items);
      listCandidates(taskId).then(setCandidates).catch(() => setCandidates([]));
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
  // 「抓挠」在这个项目里的标签 id：候选面板的「改成别的」要把它排掉
  const scratchIds = useMemo(
    () => labels.filter((l) => l.display_name === "抓挠" || l.code === "抓挠").map((l) => l.id),
    [labels]
  );
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

  const persist = async () => {
    if (taskId == null) return;
    await saveDraft(
      taskId,
      items.map((i) => ({
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
      }))
    );
  };

  // AI 预标注：后端转发到 imu_train/label_service 的 /infer，返回的类别名按
  // 标签的显示名（退一步按 code）匹配到项目标签，匹配不上的类别整体跳过并提示。
  const handleAiPrelabel = async () => {
    if (sampleId == null) return;
    setPrelabeling(true);
    try {
      const res = await aiPrelabel(sampleId, prelabelMode, taskId ?? undefined);
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
      // 已有的 AI 条目先清掉再填，避免重复点两次叠两层；人工画的保留
      setItems((prev) => [...prev.filter((i) => i.source_type !== "ai_generated" || i.origin_item_id != null), ...created]);
      const parts = [`AI 预标注完成：填入 ${created.length} 段`];
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
      setItems((await getDraft(taskId)).items);
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
  const expandedRowHeight = Math.max(
    40,
    Math.floor((chartBoxH - 24) / 6) - CHANNEL_CHROME_PX
  );

  // 拖波形区（单条波形模式）底边的把手改高度，跟视频区的把手一个用法；
  // 拖的过程只更新状态，松手才写 localStorage
  const handleChartResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = chartBoxRef.current?.getBoundingClientRect().height ?? chartHeight;
    const maxHeight = Math.max(240, window.innerHeight - 260);
    let latest = startHeight;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(maxHeight, Math.max(80, startHeight + (ev.clientY - startY)));
      setChartHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveHeight(CHART_HEIGHT_KEY, latest);
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
      const idx = HOTKEYS.indexOf(e.key.toLowerCase());
      if (idx >= 0 && idx < labels.length) {
        e.preventDefault();
        // 再按一次同一个键就取消选中，跟点按钮的行为一致
        setLabelId((prev) => (prev === labels[idx].id ? null : labels[idx].id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, readOnly, labels]);

  return (
    <Modal
      title={
        <Space wrap style={{ width: "100%" }}>
          <span>{readOnly ? "查看标注" : "标注"} - 任务 #{taskId}</span>
          {/* 一个画面里同时有四只狗，这条 IMU 是谁身上的必须一眼看见，
              不然逐条确认时很容易确认成别的狗的动作 */}
          {task?.dog_label && (
            <Tag color="purple" style={{ fontSize: 14, padding: "2px 10px", fontWeight: 600 }}>
              🐕 {task.dog_label}
            </Tag>
          )}
          <Tag>
            样本 {task?.sample_code ? sampleDisplayName(task.sample_code, task.video_duration_sec, role) : sampleId}
            {task?.video_duration_sec ? ` · ${formatDuration(task.video_duration_sec)}` : ""}
          </Tag>
          {readOnly && <Tag color="orange">只读</Tag>}
          {/* 播放速度/帧号控件从视频区上方 portal 到这里，跟标题拼一行，省出来的高度给视频用 */}
          <span ref={setControlsHost} style={{ display: "inline-flex" }} />
        </Space>
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
              {onReject && (
                <Button danger onClick={onReject}>
                  驳回
                </Button>
              )}
              {/* 只认这一类标得对——比「整份通过」窄得多，所以是单独一个按钮 */}
              {/* 看着看着发现有几段是错的，就地认领改掉，不用退回任务页 */}
              {onClaim && <Button onClick={onClaim}>认领并修改</Button>}
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
                <Popconfirm title="确认通过这份标注？（连活动/睡觉等全部类别一起认）" onConfirm={onApprove}>
                  <Button type={onConfirmScratch ? "default" : "primary"}>{approveText ?? "通过"}</Button>
                </Popconfirm>
              )}
              {onConfirmScratch && (
                <Popconfirm
                  title={`${confirmScratchText ?? "只认这一类"}？`}
                  description="只把这一类的 AI 片段标成已确认；别的类别、「疑似抓挠」候选和任务状态都不动"
                  onConfirm={handleConfirmScratch}
                >
                  <Button type="primary" loading={saving}>
                    {confirmScratchText ?? "只认这一类"}
                  </Button>
                </Popconfirm>
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
            {onConfirmScratch && (
              <Popconfirm
                title={`${confirmScratchText ?? "只认这一类"}？`}
                description="先存草稿（刚改的类别/待定都会存下），再把这一类的 AI 片段标成已确认；别的类别和任务状态不动"
                onConfirm={handleConfirmScratch}
              >
                <Button type="primary" loading={saving}>
                  {confirmScratchText ?? "只认这一类"}
                </Button>
              </Popconfirm>
            )}
          </Space>
        )
      }
    >
      <div className={`ws-body${chartExpanded ? " ws-body--charts-expanded" : ""}`}>
      <Spin spinning={loading}>
        {readOnly && onClaim && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 6 }}
            message="只读：要逐条确认、改类别（比如其实是甩身体）、或标成待定，先点右下角「认领并修改」"
            action={
              <Button size="small" type="primary" onClick={onClaim}>
                认领并修改
              </Button>
            }
          />
        )}
        {loopRange && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 6 }}
            message={`正在循环播放 ${formatMs(loopRange.startMs)} ~ ${formatMs(loopRange.endMs)}（严格按标注起止，停止后视频暂停）`}
            action={
              <Button size="small" onClick={() => setLoop(null)}>
                停止循环
              </Button>
            }
          />
        )}
        {videos.length > 0 ? (
          <SyncedVideoGroup
            videos={videos}
            bus={bus}
            fps={fps}
            fill
            controlsPortalTarget={controlsHost}
            shrinkToFit={chartExpanded}
          />
        ) : (
          !loading && <Empty description="没有找到可播放的视频" />
        )}

        {!readOnly && (
          <div style={{ margin: "12px 0", padding: 8, background: "#fafafa", borderRadius: 4 }}>
            <Space wrap size={6} style={{ marginBottom: 8 }}>
              {labels.map((l, i) => {
                const selected = labelId === l.id;
                const c = l.color || FALLBACK_COLORS[l.id % FALLBACK_COLORS.length];
                return (
                  <Button
                    key={l.id}
                    size="small"
                    onClick={() => setLabelId(selected ? null : l.id)}
                    style={{
                      borderColor: c,
                      color: selected ? "#fff" : c,
                      background: selected ? c : "#fff",
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    {l.display_name}
                    {i < HOTKEYS.length && (
                      <span style={{ marginLeft: 6, opacity: 0.65, fontSize: 11 }}>{HOTKEYS[i]}</span>
                    )}
                  </Button>
                );
              })}
              {labels.length === 0 && (
                <Typography.Text type="secondary">还没有标签，先去「标签管理」里建</Typography.Text>
              )}
              {hasCsv && sampleId != null && labels.length > 0 && (
                <Tooltip title="调用 AI 模型对这条 IMU 数据做行为识别，结果作为预填的标注框，可以再手动修改">
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    loading={prelabeling}
                    onClick={handleAiPrelabel}
                    style={{ marginLeft: 8 }}
                  >
                    AI预标注
                  </Button>
                </Tooltip>
              )}
              {hasCsv && sampleId != null && labels.length > 0 && (
                <Tooltip title="稳定版：滞回+合并+过滤；稳定版 v2：Viterbi 解码；调试版：模型逐窗口原始输出">
                  <Radio.Group
                    size="small"
                    optionType="button"
                    value={prelabelMode}
                    onChange={(e) => setPrelabelMode(e.target.value)}
                    options={INFER_MODE_OPTIONS}
                  />
                </Tooltip>
              )}
            </Space>
          </div>
        )}

        <div
          // 单条波形模式下波形区本身是固定高度，这个外层不能再 flex:1——它和视频区
          // 都是 flex:1 的话，下面片段列表一展开，两者一起被压，波形区被压到比内容
          // 还矮，内容就溢出来跟片段列表叠在一起。改成按内容撑开、不可压缩，
          // 让会自适应量尺寸的视频区独自让出高度。
          style={{
            marginTop: 4,
            flex: chartExpanded ? 1 : "0 0 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {hasCsv && sampleId != null ? (
            <>
              <Space style={{ marginBottom: 8 }}>
                <Segmented
                  options={["曲线图", "表格"]}
                  value={imuView}
                  onChange={(v) => setImuView(v as "曲线图" | "表格")}
                />
                {imuView === "曲线图" && (
                  <Segmented
                    options={["单条波形", "展开全部"]}
                    value={chartExpanded ? "展开全部" : "单条波形"}
                    onChange={(v) => setChartExpanded(v === "展开全部")}
                  />
                )}
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
              </Space>
              {imuView === "曲线图" ? (
                // 单条波形模式：盒子固定卡在刚好一条波形的高度（flex:"0 0 auto"，
                // 不是 flex:1——写 flex:1 会跟视频抢剩余高度，波形区平白占大半屏），
                // 六条通道全部渲染在里面，往下滚就能看到其余五条。
                // 展开全部模式：盒子改成 flex:1 占满剩余高度，六条一次性铺开不用滚。
                <>
                  <div
                    ref={chartBoxRef}
                    className="ws-charts"
                    style={
                      chartExpanded
                        ? { flex: 1, minHeight: 0 }
                        : {
                            flex: "0 0 auto",
                            height: chartHeight,
                            // 锁定时不响应滚动，停在当前看到的通道，不会被无意的滚轮带走
                            overflowY: chartScrollLocked ? "hidden" : "auto",
                          }
                    }
                  >
                    <ImuChart
                      sampleId={sampleId}
                      bus={bus}
                      rowHeight={chartExpanded && chartBoxH > 0 ? expandedRowHeight : undefined}
                      compact={chartExpanded}
                      segments={segments}
                      activeColor={readOnly || labelId == null ? null : colorOf(labelId)}
                      onCreateSegment={readOnly ? undefined : handleCreateFromChart}
                      onResizeSegment={readOnly ? undefined : handleResizeFromChart}
                    />
                  </div>
                  {!chartExpanded && (
                    // 单条波形模式才有这个把手：展开全部时波形区本来就占满剩余高度，
                    // 没有"再拖大"的空间
                    <div
                      onMouseDown={handleChartResizeStart}
                      onDoubleClick={() => {
                        setChartHeight(CHART_VIEWPORT_PX);
                        saveHeight(CHART_HEIGHT_KEY, null);
                      }}
                      title="拖拽调整波形区域高度，双击恢复默认"
                      style={{
                        flex: "0 0 auto",
                        height: 8,
                        margin: "2px 0",
                        cursor: "row-resize",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <div style={{ width: 40, height: 3, borderRadius: 2, background: "#d9d9d9" }} />
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
          )}
        </div>

        <Collapse
          size="small"
          className="ws-segs"
          // 按内容撑开、不压缩：一屏放不下就整体往下溢出，由弹窗 body 滚动查看
          style={{ marginTop: 8, flex: "0 0 auto" }}
          // 标注时优先把高度让给视频，列表默认收起（波形上的色块已经是主要反馈）；
          // 审核就是来看这些片段的，默认展开
          defaultActiveKey={readOnly ? ["segs"] : []}
          items={[
            {
              key: "segs",
              label: `已标注片段（${items.length}）`,
              children: (
                <SegmentPanel
                  items={items}
                  labels={labels}
                  readOnly={readOnly}
                  durationMs={durationMs}
                  colorOf={colorOf}
                  nameOf={nameOf}
                  onSeek={(ms) => bus.seek(ms / 1000)}
                  onLoop={setLoop}
                  loopRange={loopRange}
                  onUpdate={updateItems}
                  onDelete={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
                  onReturnToCandidate={async (i) => {
                    if (i.from_candidate_id == null || taskId == null) return;
                    // 先把候选放回「待确认」，再把这条片段从草稿里去掉并落库——
                    // 只删片段不动候选的话，那条候选还挂着"已确认"，再也不会出现
                    await decideCandidate(i.from_candidate_id, "pending");
                    const next = items.filter((x) => x.id !== i.id);
                    setItems(next);
                    await saveDraft(
                      taskId,
                      next.map((x) => ({
                        label_id: x.label_id,
                        start_time_ms: x.start_time_ms,
                        end_time_ms: x.end_time_ms,
                        origin_item_id: x.origin_item_id ?? undefined,
                        source_type: x.origin_item_id == null ? x.source_type : undefined,
                        ai_confidence: x.origin_item_id == null ? x.ai_confidence : undefined,
                        ai_confirmed: x.ai_confirmed,
                        uncertain: x.uncertain,
                        uncertain_reason: x.uncertain_reason,
                      }))
                    );
                    setCandidates(await listCandidates(taskId));
                    message.success("已退回候选，可以重新判断");
                  }}
                  onCreate={readOnly ? undefined : appendItem}
                  initialFilterLabels={focusIds}
                />
              ),
            },
            {
              key: "cands",
              label: `疑似抓挠（${candidates.filter((c) => c.status === "pending").length} 待确认 / ${candidates.length}）`,
              children: (
                <CandidatePanel
                  candidates={candidates}
                  labels={labels}
                  scratchLabelIds={focusIds.length ? focusIds : scratchIds}
                  readOnly={readOnly}
                  onSeek={(ms) => bus.seek(ms / 1000)}
                  onLoop={setLoop}
                  loopRange={loopRange}
                  onDecided={async () => {
                    if (taskId == null) return;
                    // 确认会往当前轮草稿里写一条人工片段，重新拉一次草稿和候选
                    const [draft, cs] = await Promise.all([getDraft(taskId), listCandidates(taskId)]);
                    setItems(draft.items);
                    setCandidates(cs);
                  }}
                />
              ),
            },
          ]}
        />
      </Spin>
      </div>
    </Modal>
  );
}
