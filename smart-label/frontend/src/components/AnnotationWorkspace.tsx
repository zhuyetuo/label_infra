import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Empty,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import { getDraft, heartbeat, saveDraft, submitTask } from "@/api/tasks";
import ImuChart, { type ChartSegment } from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";
import type { LabelDefinition, LabelItem, Task } from "@/types";

interface Props {
  task: Task | null;
  labels: LabelDefinition[];
  /** 只读模式：审核/已提交的任务只能看不能改 */
  readOnly?: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}

interface VideoSrc {
  label: string;
  url: string;
}

const FALLBACK_COLORS = ["#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1", "#13c2c2"];
const HEARTBEAT_MS = 30_000;
// 快捷键顺序跟参考工具一致：1-9、0，然后 q w e r t y，再 a s d f g h
const HOTKEYS = "1234567890qwertyasdfgh".split("");

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

// 标注工作台：视频 + IMU 波形 + 打标签。时间点不再靠手填毫秒，而是把视频/波形
// 拖到位置后直接"设为开始/设为结束"，所见即所得。
export default function AnnotationWorkspace({ task, labels, readOnly, onClose, onSubmitted }: Props) {
  const taskId = task?.id ?? null;
  const sampleId = task?.sample_id ?? null;

  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  const [hasCsv, setHasCsv] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");

  const [items, setItems] = useState<LabelItem[]>([]);
  const [markStart, setMarkStart] = useState<number | null>(null);
  const [markEnd, setMarkEnd] = useState<number | null>(null);
  const [labelId, setLabelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const bus = useMemo(() => new TimeBus(), [taskId]);
  // 当前播放位置用 ref 存，避免每帧都 setState 触发整个工作台重渲染
  const currentMsRef = useRef(0);
  const [currentMsShown, setCurrentMsShown] = useState(0);

  useEffect(() => {
    const unsubscribe = bus.onTime((sec) => {
      currentMsRef.current = sec * 1000;
    });
    const timer = setInterval(() => setCurrentMsShown(currentMsRef.current), 200);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [bus]);

  useEffect(() => {
    if (taskId == null || sampleId == null) {
      setVideos([]);
      setHasCsv(false);
      setFps(null);
      setItems([]);
      setMarkStart(null);
      setMarkEnd(null);
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
        created_by: null,
      },
    ]);
  };

  const addItem = () => {
    if (labelId == null || markStart == null || markEnd == null) return;
    const start = Math.min(markStart, markEnd);
    const end = Math.max(markStart, markEnd);
    if (end - start < 1) {
      message.warning("时间段太短");
      return;
    }
    appendItem(start, end, labelId);
    setMarkStart(null);
    setMarkEnd(null);
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
          ? { ...it, start_time_ms: Math.round(Math.max(0, startMs)), end_time_ms: Math.round(Math.max(0, endMs)) }
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
      }))
    );
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

  const canAdd = !readOnly && labelId != null && markStart != null && markEnd != null;

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
        <Space>
          <span>{readOnly ? "查看标注" : "标注"} - 任务 #{taskId}</span>
          <Tag>样本 {sampleId}</Tag>
          {readOnly && <Tag color="orange">只读</Tag>}
        </Space>
      }
      open={taskId != null}
      onCancel={onClose}
      width="95vw"
      style={{ top: 16 }}
      destroyOnClose
      footer={
        readOnly ? null : (
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
      <Spin spinning={loading}>
        {videos.length > 0 ? (
          <SyncedVideoGroup videos={videos} bus={bus} fps={fps} />
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
            </Space>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
              选一个标签（或按快捷键），然后直接在下面的波形上按住左键拖出一段即可；已画出来的色块，
              拖它的左右边缘可以改时间。再按一次同一个快捷键（或按 Esc）取消选中，拖动就恢复成平移。
              也可以用下面的「设为开始/设为结束」按当前播放位置打点。
            </div>
            <Space wrap>
            <Typography.Text strong>当前位置 {formatMs(currentMsShown)}</Typography.Text>
            <Button size="small" onClick={() => setMarkStart(currentMsRef.current)}>
              设为开始
            </Button>
            <Typography.Text type={markStart == null ? "secondary" : undefined}>
              开始 {markStart == null ? "--" : formatMs(markStart)}
            </Typography.Text>
            <Button size="small" onClick={() => setMarkEnd(currentMsRef.current)}>
              设为结束
            </Button>
            <Typography.Text type={markEnd == null ? "secondary" : undefined}>
              结束 {markEnd == null ? "--" : formatMs(markEnd)}
            </Typography.Text>
            <Button type="primary" size="small" disabled={!canAdd} onClick={addItem}>
              添加这一段
            </Button>
            <Button
              size="small"
              onClick={() => {
                setMarkStart(null);
                setMarkEnd(null);
              }}
            >
              清除
            </Button>
            </Space>
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {hasCsv && sampleId != null ? (
            <>
              <Segmented
                options={["曲线图", "表格"]}
                value={imuView}
                onChange={(v) => setImuView(v as "曲线图" | "表格")}
                style={{ marginBottom: 8 }}
              />
              {imuView === "曲线图" ? (
                <ImuChart
                  sampleId={sampleId}
                  bus={bus}
                  segments={segments}
                  activeColor={readOnly || labelId == null ? null : colorOf(labelId)}
                  onCreateSegment={readOnly ? undefined : handleCreateFromChart}
                  onResizeSegment={readOnly ? undefined : handleResizeFromChart}
                />
              ) : (
                <ImuTable sampleId={sampleId} />
              )}
            </>
          ) : (
            !loading && <Typography.Text type="secondary">没有找到 IMU CSV</Typography.Text>
          )}
        </div>

        <Typography.Title level={5} style={{ marginTop: 16 }}>
          已标注片段（{items.length}）
        </Typography.Title>
        <Table
          size="small"
          rowKey="id"
          dataSource={items}
          pagination={false}
          scroll={{ y: 220 }}
          locale={{ emptyText: "还没有标注片段" }}
          columns={[
            {
              title: "标签",
              render: (_, i: LabelItem) => <Tag color={colorOf(i.label_id)}>{nameOf(i.label_id)}</Tag>,
            },
            { title: "开始", render: (_, i: LabelItem) => formatMs(i.start_time_ms) },
            { title: "结束", render: (_, i: LabelItem) => formatMs(i.end_time_ms) },
            {
              title: "时长",
              render: (_, i: LabelItem) => `${((i.end_time_ms - i.start_time_ms) / 1000).toFixed(2)}s`,
            },
            { title: "来源", dataIndex: "source_type", width: 110 },
            {
              title: "操作",
              width: 140,
              render: (_, i: LabelItem) => (
                <Space>
                  <Button size="small" type="link" onClick={() => bus.seek(i.start_time_ms / 1000)}>
                    跳转
                  </Button>
                  {!readOnly && (
                    <Button
                      size="small"
                      danger
                      type="link"
                      onClick={() => setItems((prev) => prev.filter((x) => x.id !== i.id))}
                    >
                      删除
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Spin>
    </Modal>
  );
}
