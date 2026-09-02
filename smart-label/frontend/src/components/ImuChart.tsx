import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./ImuChart.css";
import request from "@/utils/request";
import type { TimeBus } from "@/utils/timeBus";

interface ImuMeta {
  duration_ms: number;
  row_count: number;
  sample_rate_hz: number | null;
  start_timestamp: string | null;
}

interface ImuSeries {
  t: number[];
  acc_x: number[];
  acc_y: number[];
  acc_z: number[];
  gyro_x: number[];
  gyro_y: number[];
  gyro_z: number[];
}

const CHANNELS: { key: keyof Omit<ImuSeries, "t">; label: string; color: string }[] = [
  { key: "acc_x", label: "Acc X", color: "#e74c3c" },
  { key: "acc_y", label: "Acc Y", color: "#2ecc71" },
  { key: "acc_z", label: "Acc Z", color: "#3498db" },
  { key: "gyro_x", label: "Gyro X", color: "#e67e22" },
  { key: "gyro_y", label: "Gyro Y", color: "#1abc9c" },
  { key: "gyro_z", label: "Gyro Z", color: "#9b59b6" },
];

const getMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
const getSeries = (sampleId: number, startMs: number, endMs: number, maxPoints = 1500) =>
  request.get<never, ImuSeries>(`/imu/${sampleId}/series`, {
    params: { start_ms: startMs, end_ms: endMs, max_points: maxPoints },
  });

function formatTimestamp(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface ChartSegment {
  start_time_ms: number;
  end_time_ms: number;
  color: string;
  label: string;
}

interface Props {
  sampleId: number;
  bus: TimeBus;
  rowHeight?: number;
  /** 已标注的时间段，会以半透明色块画在曲线上（标注工作台用） */
  segments?: ChartSegment[];
  /** 选中的标签颜色。传了就进入"在波形上拖拽划区间"模式，不传则拖拽=平移 */
  activeColor?: string | null;
  onCreateSegment?: (startMs: number, endMs: number) => void;
  /** 拖已有色块的左右边缘改时间 */
  onResizeSegment?: (index: number, startMs: number, endMs: number) => void;
}

// 拖拽划区间/改边缘要在 uPlot 插件里读到最新的回调和选中颜色，但插件只在图表
// 初始化时创建一次，所以统一放在一个 ref 对象里，由 effect 保持更新。
interface AnnotateCtx {
  activeColor: string | null;
  onCreate: ((startMs: number, endMs: number) => void) | null;
  onResize: ((index: number, startMs: number, endMs: number) => void) | null;
  pending: { startMs: number; endMs: number; color: string } | null;
  redrawAll: () => void;
}

// 每个通道独立一行、各自Y轴、共享X轴（跟公司原来用的 Label Studio TimeSeries
// 面板风格一致），X轴用绝对时间戳（年月日时分秒毫秒），6张图通过手动同步
// setScale + uPlot cursor.sync 联动缩放/平移/十字线。
// 另外通过 bus 跟视频双向联动：视频播放时在6张图上画一条跟随的红色竖线
// （playheadPlugin，区别于鼠标悬停的十字线），点击曲线任意位置能让视频跳转过去。
export default function ImuChart({
  sampleId,
  bus,
  rowHeight = 110,
  segments,
  activeColor,
  onCreateSegment,
  onResizeSegment,
}: Props) {
  const containerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const plotRefs = useRef<(uPlot | null)[]>([]);
  const durationRef = useRef<number>(0);
  const startEpochRef = useRef<number>(0);
  const fetchSeqRef = useRef(0);
  const syncingRef = useRef(false);
  const draggingRef = useRef(false);
  // 标注色块走 ref 而不是进 effect 依赖，否则每加一条标注就要把6张图全部重建
  const segmentsRef = useRef<ChartSegment[]>(segments ?? []);
  const annotateRef = useRef<AnnotateCtx>({
    activeColor: null,
    onCreate: null,
    onResize: null,
    pending: null,
    redrawAll: () => {},
  });
  annotateRef.current.activeColor = activeColor ?? null;
  annotateRef.current.onCreate = onCreateSegment ?? null;
  annotateRef.current.onResize = onResizeSegment ?? null;
  annotateRef.current.redrawAll = () => plotRefs.current.forEach((p) => p?.redraw());

  useEffect(() => {
    segmentsRef.current = segments ?? [];
    plotRefs.current.forEach((p) => p?.redraw());
  }, [segments]);

  useEffect(() => {
    let disposed = false;
    const playheadState: { current: number | null } = { current: null };

    (async () => {
      const meta = await getMeta(sampleId);
      if (disposed || containerRefs.current.some((el) => !el)) return;
      durationRef.current = meta.duration_ms;
      startEpochRef.current = meta.start_timestamp ? new Date(meta.start_timestamp).getTime() / 1000 : 0;

      const series = await getSeries(sampleId, 0, meta.duration_ms);
      if (disposed) return;

      const toEpoch = (msArr: number[]) => msArr.map((ms) => startEpochRef.current + ms / 1000);

      // 多取一屏宽度的余量（左右各50%），这样平移/拖播放头时窗口稍微移动一点
      // 还落在已经取回来的数据里，曲线不会先变空白再补上。
      const RANGE_PADDING = 0.5;

      const refetchForRange = async (minEpoch: number, maxEpoch: number) => {
        const seq = ++fetchSeqRef.current;
        const pad = (maxEpoch - minEpoch) * RANGE_PADDING;
        const startMs = Math.round(Math.max(0, (minEpoch - pad - startEpochRef.current) * 1000));
        const endMs = Math.round(
          Math.min(durationRef.current, (maxEpoch + pad - startEpochRef.current) * 1000)
        );
        const s = await getSeries(sampleId, startMs, endMs);
        if (seq !== fetchSeqRef.current || plotRefs.current.some((p) => !p)) return;
        const t = toEpoch(s.t);

        // 注意：setData 的第二个参数不能传 false。传 false 时 uPlot 会跳过整个
        // commit，X轴对应的数据下标区间（u.idxs）还停留在旧数组上，换成新数组后
        // 画出来的点就整段跑到视窗外面去了，表现就是"曲线一片空白"。
        // 所以这里让它正常重置（顺带把Y轴重新自适应），再把视窗恢复回去。
        const first = plotRefs.current[0]!;
        const viewMin = first.scales.x.min!;
        const viewMax = first.scales.x.max!;

        syncingRef.current = true;
        CHANNELS.forEach((c, i) => {
          const plot = plotRefs.current[i];
          if (!plot) return;
          plot.setData([t, s[c.key]]);
          plot.setScale("x", { min: viewMin, max: viewMax });
        });
        syncingRef.current = false;

        // 请求发出去之后视窗可能又被拖走了，这一批数据不一定盖得住当前视窗，
        // 那就再补一次（只在还没顶到整段数据边界时补，避免来回空跑）。
        const reqStart = startEpochRef.current + startMs / 1000;
        const reqEnd = startEpochRef.current + endMs / 1000;
        if ((viewMin < reqStart && startMs > 0) || (viewMax > reqEnd && endMs < durationRef.current)) {
          scheduleRefetch(viewMin, viewMax);
        }
      };

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefetch = (min: number, max: number) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refetchForRange(min, max), 120);
      };

      const onScaleChange = (originIdx: number) => (u: uPlot, key: string) => {
        if (key !== "x" || syncingRef.current) return;
        const { min, max } = u.scales.x;
        if (min == null || max == null) return;

        syncingRef.current = true;
        plotRefs.current.forEach((p, i) => {
          if (i !== originIdx) p?.setScale("x", { min, max });
        });
        syncingRef.current = false;

        scheduleRefetch(min, max);
      };

      const onClickSeek = (epochVal: number) => {
        bus.seek(epochVal - startEpochRef.current);
      };

      // 整段数据的时间范围，拖到边缘自动滚动时用它做边界，不能滚出数据之外
      const getFullRange = () => ({
        min: startEpochRef.current,
        max: startEpochRef.current + durationRef.current / 1000,
      });

      const syncKey = `imu-sync-${sampleId}`;
      const t0 = toEpoch(series.t);

      CHANNELS.forEach((c, i) => {
        const container = containerRefs.current[i];
        if (!container) return;
        const isLast = i === CHANNELS.length - 1;

        const opts: uPlot.Options = {
          title: c.label,
          width: container.clientWidth,
          height: rowHeight,
          cursor: {
            drag: { x: false, y: false, setScale: false },
            sync: { key: syncKey, setSeries: false },
          },
          legend: { show: false },
          scales: { x: { time: true } },
          axes: [{ show: isLast }, {}],
          series: [
            { value: (_u, v) => (v == null ? "" : formatTimestamp(v)) },
            { label: c.label, stroke: c.color, width: 1.5 },
          ],
          hooks: { setScale: [onScaleChange(i)] },
          plugins: [
            segmentBandPlugin(segmentsRef, annotateRef, () => startEpochRef.current, i === 0),
            dragPanPlugin(
              onClickSeek,
              playheadState,
              draggingRef,
              getFullRange,
              annotateRef,
              segmentsRef,
              () => startEpochRef.current
            ),
            wheelZoomPlugin(),
            playheadPlugin(playheadState, i === 0),
          ],
        };

        plotRefs.current[i] = new uPlot(opts, [t0, series[c.key]], container);
      });

      // 如果当前是放大状态（不是整体视图），播放头走到可视范围右边缘时，
      // 自动把可视窗口往前挪，让播放头始终留在视野里（回退到窗口左侧10%处）；
      // 走到左边缘同理（比如用户手动往回拖了一段）。完全缩小到整体视图时不用跟。
      const followPlayhead = (epoch: number) => {
        if (draggingRef.current) return;
        const first = plotRefs.current[0];
        if (!first) return;
        const { min, max } = first.scales.x;
        if (min == null || max == null) return;
        const width = max - min;
        if (width >= durationRef.current / 1000 - 0.01) return; // 整体视图不用跟
        const rightMargin = width * 0.02;
        const leftMargin = width * 0.02;
        if (epoch <= max - rightMargin && epoch >= min + leftMargin) return;
        const newMin = epoch - width * 0.1;
        const newMax = newMin + width;
        syncingRef.current = true;
        plotRefs.current.forEach((p) => p?.setScale("x", { min: newMin, max: newMax }));
        syncingRef.current = false;
        scheduleRefetch(newMin, newMax);
      };

      const unsubscribe = bus.onTime((sec) => {
        playheadState.current = startEpochRef.current + sec;
        followPlayhead(playheadState.current);
        plotRefs.current.forEach((p) => p?.redraw());
      });

      return unsubscribe;
    })().then((unsub) => {
      cleanupBusRef.current = unsub;
    });

    const cleanupBusRef: { current: (() => void) | null | undefined } = { current: null };

    return () => {
      disposed = true;
      cleanupBusRef.current?.();
      plotRefs.current.forEach((p) => p?.destroy());
      plotRefs.current = [];
    };
  }, [sampleId, rowHeight, bus]);

  return (
    <div>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
        Shift+滚轮缩放 / 放大后按住拖动左右平移（整体视图下全部数据已在视野内，无需拖动）/
        单击或拖动黑色播放头跳转视频到该时刻（放大后拖到边缘会自动继续滚动）/ 双击恢复整体视图
      </div>
      {CHANNELS.map((c, i) => (
        <div
          key={c.key}
          ref={(el) => {
            containerRefs.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}

// 把已标注的时间段画成半透明色块垫在曲线下面，第一张图上再标上标签名，
// 这样一眼能看出哪段已经标了什么行为。
function segmentBandPlugin(
  segmentsRef: { current: ChartSegment[] },
  annotateRef: { current: AnnotateCtx },
  getStartEpoch: () => number,
  showLabel: boolean
) {
  return {
    hooks: {
      // drawClear 在清空画布之后、画曲线之前触发，所以色块会垫在曲线底下
      drawClear: (u: uPlot) => {
        const pending = annotateRef.current.pending;
        const segs: ChartSegment[] = pending
          ? [
              ...segmentsRef.current,
              {
                start_time_ms: pending.startMs,
                end_time_ms: pending.endMs,
                color: pending.color,
                label: "",
              },
            ]
          : segmentsRef.current;
        if (!segs.length) return;
        const startEpoch = getStartEpoch();
        const ctx = u.ctx;
        const left = u.bbox.left;
        const right = u.bbox.left + u.bbox.width;

        ctx.save();
        ctx.beginPath();
        ctx.rect(left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        for (const seg of segs) {
          const x0 = u.valToPos(startEpoch + seg.start_time_ms / 1000, "x", true);
          const x1 = u.valToPos(startEpoch + seg.end_time_ms / 1000, "x", true);
          if (x1 < left || x0 > right) continue;
          ctx.fillStyle = seg.color;
          ctx.globalAlpha = 0.22;
          ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = seg.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, u.bbox.top);
          ctx.lineTo(x0, u.bbox.top + u.bbox.height);
          ctx.moveTo(x1, u.bbox.top);
          ctx.lineTo(x1, u.bbox.top + u.bbox.height);
          ctx.stroke();

          if (showLabel && x1 - x0 > 24) {
            ctx.fillStyle = seg.color;
            ctx.font = "11px sans-serif";
            ctx.textBaseline = "top";
            ctx.fillText(seg.label, x0 + 3, u.bbox.top + 2);
          }
        }
        ctx.restore();
      },
    },
  };
}

// 画一条跟随视频播放位置的竖线，跟鼠标悬停的十字线是两码事（互不干扰）；
// 不再用 uPlot 默认的居中图例展示当前时间/数值，改成直接标注在竖线旁边，
// 只在第一张图（showLabel）画文字，避免6张图都重复显示同样的时间。
function playheadPlugin(stateRef: { current: number | null }, showLabel: boolean) {
  return {
    hooks: {
      draw: (u: uPlot) => {
        if (stateRef.current == null) return;
        const x = u.valToPos(stateRef.current, "x", true);
        if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();

        if (showLabel) {
          const label = formatTimestamp(stateRef.current);
          ctx.font = "12px sans-serif";
          const textWidth = ctx.measureText(label).width;
          const nearRightEdge = x + 6 + textWidth > u.bbox.left + u.bbox.width;
          const labelX = nearRightEdge ? x - 6 - textWidth : x + 6;
          ctx.fillStyle = "#000000";
          ctx.textBaseline = "top";
          ctx.fillText(label, labelX, u.bbox.top + 2);
        }
        ctx.restore();
      },
    },
  };
}

// 滚轮缩放：以光标位置为中心，不能超出数据整体范围
function wheelZoomPlugin() {
  const factor = 0.9;
  let xMin: number, xMax: number;

  return {
    hooks: {
      ready: (u: uPlot) => {
        xMin = u.scales.x.min!;
        xMax = u.scales.x.max!;
        const over = u.over;

        over.addEventListener("dblclick", () => {
          u.setScale("x", { min: xMin, max: xMax });
        });

        over.addEventListener(
          "wheel",
          (e: WheelEvent) => {
            if (!e.shiftKey) return; // 不按shift就是正常滚动页面，不缩放
            e.preventDefault();
            const { left } = u.cursor;
            if (left == null) return;
            const leftPct = left / u.bbox.width;
            const xRange = u.scales.x.max! - u.scales.x.min!;
            const nxRange = e.deltaY < 0 ? xRange * factor : xRange / factor;
            const xVal = u.posToVal(left, "x");
            const nxMin = xVal - leftPct * nxRange;
            const nxMax = nxMin + nxRange;
            u.setScale("x", {
              min: Math.max(xMin, nxMin),
              max: Math.min(xMax, nxMax),
            });
          },
          { passive: false }
        );
      },
    },
  };
}

const PLAYHEAD_GRAB_PX = 8;
const SEGMENT_EDGE_GRAB_PX = 5; // 色块边缘多少像素内按下算"拖边缘改时间"
const PAN_EPSILON = 1e-6; // 判断"是否已经是整体视图"的浮点容差
const MIN_SEGMENT_MS = 50; // 拖出来太短的当误点丢弃
const EDGE_SCROLL_PX = 40; // 距离左右边缘多少像素内开始自动滚动
const EDGE_SCROLL_RATIO = 0.012; // 每帧滚动可视宽度的比例

// 按住拖动左右平移（不是框选放大）；如果几乎没移动就当作一次单击，触发跳转视频。
// 如果按下的位置刚好在播放头竖线附近，则改成直接拖拽播放头来跳转视频播放位置
// （拖拽期间暂停自动跟随，见 followPlayhead）。
function dragPanPlugin(
  onClickSeek: (epochVal: number) => void,
  playheadState: { current: number | null },
  draggingPlayheadRef: { current: boolean },
  getFullRange: () => { min: number; max: number },
  annotateRef: { current: AnnotateCtx },
  segmentsRef: { current: ChartSegment[] },
  getStartEpoch: () => number
) {
  let dragging = false;
  let seekDragging = false;
  // 划新区间 / 拖已有区间边缘
  let bandDragging = false;
  let bandAnchorMs = 0;
  let resizeIdx = -1;
  let resizeFixedMs = 0;
  let startMin = 0;
  let startMax = 0;
  let startRelX = 0;
  let overRectLeft = 0;
  let maxMoveDistance = 0;
  let lastClientX = 0;
  let autoScrollRaf: number | null = null;
  let panEnabled = false;

  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;

        const fullRangeWidth = () => {
          const full = getFullRange();
          return full.max - full.min;
        };
        // 只有放大之后才是"可以抓着拖"的状态，光标也跟着变，让人一眼知道能不能拖
        const refreshCursor = () => {
          const min = u.scales.x.min;
          const max = u.scales.x.max;
          const zoomed = min != null && max != null && max - min < fullRangeWidth() - PAN_EPSILON;
          over.style.cursor = zoomed ? "grab" : "default";
        };
        refreshCursor();

        const stopAutoScroll = () => {
          if (autoScrollRaf != null) {
            cancelAnimationFrame(autoScrollRaf);
            autoScrollRaf = null;
          }
        };

        // 拖播放头拖到可视区左右边缘时，持续把窗口往那个方向滚，
        // 这样放大之后也能一直往前/往后刷，不会拖到边就卡住不动了。
        // 越靠边滚得越快，滚到整段数据的头尾为止。
        const autoScrollStep = () => {
          autoScrollRaf = null;
          if (!seekDragging) return;

          const w = over.clientWidth;
          const relX = lastClientX - overRectLeft;
          let dir = 0;
          let strength = 0;
          if (relX > w - EDGE_SCROLL_PX) {
            dir = 1;
            strength = Math.min(1, (relX - (w - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX);
          } else if (relX < EDGE_SCROLL_PX) {
            dir = -1;
            strength = Math.min(1, (EDGE_SCROLL_PX - relX) / EDGE_SCROLL_PX);
          }

          if (dir !== 0) {
            const min = u.scales.x.min!;
            const max = u.scales.x.max!;
            const width = max - min;
            const full = getFullRange();
            const step = width * EDGE_SCROLL_RATIO * (0.25 + strength) * dir;
            let nMin = min + step;
            let nMax = max + step;
            if (nMin < full.min) {
              nMin = full.min;
              nMax = nMin + width;
            }
            if (nMax > full.max) {
              nMax = full.max;
              nMin = nMax - width;
            }
            if (nMin !== min) {
              u.setScale("x", { min: nMin, max: nMax });
              // 播放头钉在光标所在的边缘上，跟着窗口一起走
              onClickSeek(u.posToVal(Math.max(0, Math.min(w, relX)), "x"));
            }
          }

          autoScrollRaf = requestAnimationFrame(autoScrollStep);
        };

        const toMs = (relX: number) => (u.posToVal(relX, "x") - getStartEpoch()) * 1000;

        const onMouseDown = (e: MouseEvent) => {
          if (e.button !== 0) return;
          maxMoveDistance = 0;
          overRectLeft = over.getBoundingClientRect().left;
          startRelX = e.clientX - overRectLeft;
          lastClientX = e.clientX;

          // 优先级：拖已有色块边缘 > 拖播放头 > 选中标签时划新区间 > 平移
          if (annotateRef.current.onResize) {
            const startEpoch = getStartEpoch();
            for (let idx = 0; idx < segmentsRef.current.length; idx++) {
              const seg = segmentsRef.current[idx];
              const xs = u.valToPos(startEpoch + seg.start_time_ms / 1000, "x", false);
              const xe = u.valToPos(startEpoch + seg.end_time_ms / 1000, "x", false);
              if (Math.abs(xs - startRelX) <= SEGMENT_EDGE_GRAB_PX) {
                bandDragging = true;
                resizeIdx = idx;
                resizeFixedMs = seg.end_time_ms;
                over.style.cursor = "ew-resize";
                e.preventDefault();
                return;
              }
              if (Math.abs(xe - startRelX) <= SEGMENT_EDGE_GRAB_PX) {
                bandDragging = true;
                resizeIdx = idx;
                resizeFixedMs = seg.start_time_ms;
                over.style.cursor = "ew-resize";
                e.preventDefault();
                return;
              }
            }
          }

          if (playheadState.current != null) {
            // 注意：valToPos 第三个参数是"是否返回canvas设备像素坐标"，这里要跟
            // e.clientX 一样是 CSS 像素坐标（DOM鼠标坐标），所以不能传 true，
            // 否则在 devicePixelRatio != 1 的屏幕上，附近判定会完全偏掉。
            const playheadX = u.valToPos(playheadState.current, "x", false);
            if (Math.abs(playheadX - startRelX) <= PLAYHEAD_GRAB_PX) {
              seekDragging = true;
              draggingPlayheadRef.current = true;
              over.style.cursor = "ew-resize";
              onClickSeek(u.posToVal(startRelX, "x"));
              stopAutoScroll();
              autoScrollRaf = requestAnimationFrame(autoScrollStep);
              e.preventDefault();
              return;
            }
          }

          // 选中了标签就是"划区间"模式，跟参考工具一致：选标签 -> 在波形上拖
          if (annotateRef.current.activeColor && annotateRef.current.onCreate) {
            bandDragging = true;
            resizeIdx = -1;
            bandAnchorMs = toMs(startRelX);
            annotateRef.current.pending = {
              startMs: bandAnchorMs,
              endMs: bandAnchorMs,
              color: annotateRef.current.activeColor,
            };
            over.style.cursor = "crosshair";
            e.preventDefault();
            return;
          }

          dragging = true;
          startMin = u.scales.x.min!;
          startMax = u.scales.x.max!;
          // 没放大的时候整段数据本来就全在视野里，左右拖没有任何意义，
          // 还会把波形拖到空白区去，所以这种情况只认单击跳转，不做平移。
          panEnabled = startMax - startMin < fullRangeWidth() - PAN_EPSILON;
          if (panEnabled) over.style.cursor = "grabbing";
          e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
          lastClientX = e.clientX;
          const relX = e.clientX - overRectLeft;
          if (!dragging && !seekDragging && !bandDragging) refreshCursor();

          if (bandDragging) {
            const cur = toMs(relX);
            if (resizeIdx >= 0) {
              const seg = segmentsRef.current[resizeIdx];
              if (seg) {
                annotateRef.current.pending = {
                  startMs: Math.min(resizeFixedMs, cur),
                  endMs: Math.max(resizeFixedMs, cur),
                  color: seg.color,
                };
              }
            } else {
              annotateRef.current.pending = {
                startMs: Math.min(bandAnchorMs, cur),
                endMs: Math.max(bandAnchorMs, cur),
                color: annotateRef.current.activeColor ?? "#1677ff",
              };
            }
            annotateRef.current.redrawAll();
            return;
          }

          if (seekDragging) {
            const w = over.clientWidth;
            // 边缘区域交给 autoScrollStep 处理，这里只管窗口内的常规跟随
            if (relX >= EDGE_SCROLL_PX && relX <= w - EDGE_SCROLL_PX) {
              onClickSeek(u.posToVal(relX, "x"));
            }
            return;
          }
          if (!dragging) return;
          maxMoveDistance = Math.max(maxMoveDistance, Math.abs(relX - startRelX));
          if (!panEnabled) return; // 没放大就只是按住不动，不平移
          const v0 = u.posToVal(startRelX, "x");
          const v1 = u.posToVal(relX, "x");
          const dv = v1 - v0;

          // 平移不能超出整段数据的范围，否则会拖出一大片空白
          const width = startMax - startMin;
          const full = getFullRange();
          let nMin = startMin - dv;
          if (nMin < full.min) nMin = full.min;
          if (nMin + width > full.max) nMin = full.max - width;
          u.setScale("x", { min: nMin, max: nMin + width });
        };

        const onMouseUp = (e: MouseEvent) => {
          if (bandDragging) {
            bandDragging = false;
            refreshCursor();
            const pending = annotateRef.current.pending;
            annotateRef.current.pending = null;
            const idx = resizeIdx;
            resizeIdx = -1;
            // 太短的当成误点，不生成区间
            if (pending && pending.endMs - pending.startMs >= MIN_SEGMENT_MS) {
              if (idx >= 0) {
                annotateRef.current.onResize?.(idx, Math.round(pending.startMs), Math.round(pending.endMs));
              } else {
                annotateRef.current.onCreate?.(Math.round(pending.startMs), Math.round(pending.endMs));
              }
            }
            annotateRef.current.redrawAll();
            return;
          }

          if (seekDragging) {
            seekDragging = false;
            draggingPlayheadRef.current = false;
            stopAutoScroll();
            refreshCursor();
            return;
          }
          if (!dragging) return;
          dragging = false;
          panEnabled = false;
          refreshCursor();
          if (maxMoveDistance < 5) {
            const relX = e.clientX - overRectLeft;
            onClickSeek(u.posToVal(relX, "x"));
          }
        };

        over.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      },
    },
  };
}
