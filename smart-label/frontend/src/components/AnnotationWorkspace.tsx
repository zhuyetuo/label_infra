import { useEffect, useMemo, useRef, useState } from "react";
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
  Tooltip,
  Typography,
  message,
} from "antd";
import { LockOutlined, ThunderboltOutlined, UnlockOutlined } from "@ant-design/icons";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { aiPrelabel, getSampleMedia } from "@/api/samples";
import { getImuMeta } from "@/api/imu";
import SegmentPanel from "@/components/SegmentPanel";
import { getDraft, heartbeat, saveDraft, submitTask } from "@/api/tasks";
import ImuChart, { type ChartSegment } from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";
import { getSavedBool, getSavedHeight, saveBool, saveHeight } from "@/utils/persistedSize";
import "./AnnotationWorkspace.css";
import type { LabelDefinition, LabelItem, Task } from "@/types";

interface Props {
  task: Task | null;
  labels: LabelDefinition[];
  /** 只读模式：审核/已提交的任务只能看不能改 */
  readOnly?: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  /** 审核员看完可以直接在这里下结论，省得关掉再回列表点 */
  onApprove?: () => void | Promise<void>;
  onReject?: () => void;
}

interface VideoSrc {
  label: string;
  url: string;
}

const FALLBACK_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2"];
const HEARTBEAT_MS = 30_000;
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
  labels,
  readOnly,
  onClose,
  onSubmitted,
  onApprove,
  onReject,
}: Props) {
  const taskId = task?.id ?? null;
  const sampleId = task?.sample_id ?? null;

  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  // 播放速度/帧号控件 portal 的目标节点：挂在弹窗标题里的一个空 span 上
  const [controlsHost, setControlsHost] = useState<HTMLSpanElement | null>(null);
  const [hasCsv, setHasCsv] = useState(false);
  const [prelabeling, setPrelabeling] = useState(false);
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
  const [labelId, setLabelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const bus = useMemo(() => new TimeBus(), [taskId]);

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
      }))
    );
  };

  // AI 预标注：后端转发到 imu_train/label_service 的 /infer，返回的类别名按
  // 标签的显示名（退一步按 code）匹配到项目标签，匹配不上的类别整体跳过并提示。
  const handleAiPrelabel = async () => {
    if (sampleId == null) return;
    setPrelabeling(true);
    try {
      const res = await aiPrelabel(sampleId);
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
      onClose();
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
          <Tag>样本 {sampleId}</Tag>
          {readOnly && <Tag color="orange">只读</Tag>}
          {/* 播放速度/帧号控件从视频区上方 portal 到这里，跟标题拼一行，省出来的高度给视频用 */}
          <span ref={setControlsHost} style={{ display: "inline-flex" }} />
        </Space>
      }
      open={taskId != null}
      onCancel={onClose}
      // 标注要看细节，占满整个屏幕，别把空间浪费在弹窗留白上
      width="100vw"
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
          onApprove || onReject ? (
            <Space>
              {onReject && (
                <Button danger onClick={onReject}>
                  驳回
                </Button>
              )}
              {onApprove && (
                <Popconfirm title="确认通过这份标注？" onConfirm={onApprove}>
                  <Button type="primary">通过</Button>
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
              <Button type="primary" loading={saving}>
                提交
              </Button>
            </Popconfirm>
          </Space>
        )
      }
    >
      <div className={`ws-body${chartExpanded ? " ws-body--charts-expanded" : ""}`}>
      <Spin spinning={loading}>
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
                  onUpdate={updateItems}
                  onDelete={(id) => setItems((prev) => prev.filter((x) => x.id !== id))}
                  onCreate={readOnly ? undefined : appendItem}
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
