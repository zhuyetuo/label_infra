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

interface Props {
  sampleId: number;
  bus: TimeBus;
  rowHeight?: number;
}

// 每个通道独立一行、各自Y轴、共享X轴（跟公司原来用的 Label Studio TimeSeries
// 面板风格一致），X轴用绝对时间戳（年月日时分秒毫秒），6张图通过手动同步
// setScale + uPlot cursor.sync 联动缩放/平移/十字线。
// 另外通过 bus 跟视频双向联动：视频播放时在6张图上画一条跟随的红色竖线
// （playheadPlugin，区别于鼠标悬停的十字线），点击曲线任意位置能让视频跳转过去。
export default function ImuChart({ sampleId, bus, rowHeight = 110 }: Props) {
  const containerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const plotRefs = useRef<(uPlot | null)[]>([]);
  const durationRef = useRef<number>(0);
  const startEpochRef = useRef<number>(0);
  const fetchSeqRef = useRef(0);
  const syncingRef = useRef(false);

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

      const refetchForRange = async (minEpoch: number, maxEpoch: number) => {
        const seq = ++fetchSeqRef.current;
        const startMs = Math.round(Math.max(0, (minEpoch - startEpochRef.current) * 1000));
        const endMs = Math.round(Math.min(durationRef.current, (maxEpoch - startEpochRef.current) * 1000));
        const s = await getSeries(sampleId, startMs, endMs);
        if (seq !== fetchSeqRef.current || plotRefs.current.some((p) => !p)) return;
        const t = toEpoch(s.t);
        CHANNELS.forEach((c, i) => {
          plotRefs.current[i]?.setData([t, s[c.key]]);
        });
      };

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefetch = (min: number, max: number) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refetchForRange(min, max), 250);
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
          scales: { x: { time: true } },
          axes: [{ show: isLast }, {}],
          series: [
            { value: (_u, v) => (v == null ? "" : formatTimestamp(v)) },
            { label: c.label, stroke: c.color, width: 1.5 },
          ],
          hooks: { setScale: [onScaleChange(i)] },
          plugins: [dragPanPlugin(onClickSeek), wheelZoomPlugin(), playheadPlugin(playheadState)],
        };

        plotRefs.current[i] = new uPlot(opts, [t0, series[c.key]], container);
      });

      const unsubscribe = bus.onTime((sec) => {
        playheadState.current = startEpochRef.current + sec;
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
        滚轮缩放 / 按住拖动左右平移 / 单击跳转视频到该时刻 / 双击恢复整体视图（红色竖线=视频当前播放位置）
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

// 画一条跟随视频播放位置的竖线，跟鼠标悬停的十字线是两码事（互不干扰）
function playheadPlugin(stateRef: { current: number | null }) {
  return {
    hooks: {
      draw: (u: uPlot) => {
        if (stateRef.current == null) return;
        const x = u.valToPos(stateRef.current, "x", true);
        if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "#ff0000";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
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

// 按住拖动左右平移（不是框选放大）；如果几乎没移动就当作一次单击，触发跳转视频
function dragPanPlugin(onClickSeek: (epochVal: number) => void) {
  let dragging = false;
  let startMin = 0;
  let startMax = 0;
  let startRelX = 0;
  let overRectLeft = 0;
  let maxMoveDistance = 0;

  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;
        over.style.cursor = "grab";

        const onMouseDown = (e: MouseEvent) => {
          if (e.button !== 0) return;
          dragging = true;
          maxMoveDistance = 0;
          over.style.cursor = "grabbing";
          overRectLeft = over.getBoundingClientRect().left;
          startRelX = e.clientX - overRectLeft;
          startMin = u.scales.x.min!;
          startMax = u.scales.x.max!;
          e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
          if (!dragging) return;
          const relX = e.clientX - overRectLeft;
          maxMoveDistance = Math.max(maxMoveDistance, Math.abs(relX - startRelX));
          const v0 = u.posToVal(startRelX, "x");
          const v1 = u.posToVal(relX, "x");
          const dv = v1 - v0;
          u.setScale("x", { min: startMin - dv, max: startMax - dv });
        };

        const onMouseUp = (e: MouseEvent) => {
          if (!dragging) return;
          dragging = false;
          over.style.cursor = "grab";
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
