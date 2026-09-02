import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import request from "@/utils/request";

interface ImuMeta {
  duration_ms: number;
  row_count: number;
  sample_rate_hz: number | null;
  channels: string[];
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

const ACC_COLORS = { acc_x: "#e74c3c", acc_y: "#2ecc71", acc_z: "#3498db" };
const GYRO_COLORS = { gyro_x: "#e67e22", gyro_y: "#1abc9c", gyro_z: "#9b59b6" };

const getMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
const getSeries = (sampleId: number, startMs: number, endMs: number, maxPoints = 1500) =>
  request.get<never, ImuSeries>(`/imu/${sampleId}/series`, {
    params: { start_ms: startMs, end_ms: endMs, max_points: maxPoints },
  });

interface Props {
  sampleId: number;
  height?: number;
}

// 加速度/角速度单位量级差很大（比如 acc 是 ±2g, gyro 是 ±250deg/s），共用一个Y轴会
// 把小量级的通道压成直线看不清，所以拆成两张图各自独立Y轴，共享X轴+联动缩放平移。
export default function ImuChart({ sampleId, height = 180 }: Props) {
  const accRef = useRef<HTMLDivElement>(null);
  const gyroRef = useRef<HTMLDivElement>(null);
  const accPlotRef = useRef<uPlot | null>(null);
  const gyroPlotRef = useRef<uPlot | null>(null);
  const durationRef = useRef<number>(0);
  const fetchSeqRef = useRef(0);
  const syncingRef = useRef(false); // 防止两张图互相触发setScale死循环

  useEffect(() => {
    let disposed = false;

    (async () => {
      const meta = await getMeta(sampleId);
      if (disposed || !accRef.current || !gyroRef.current) return;
      durationRef.current = meta.duration_ms;

      const series = await getSeries(sampleId, 0, meta.duration_ms);
      if (disposed || !accRef.current || !gyroRef.current) return;

      const tSec = series.t.map((ms) => ms / 1000);
      const accData: uPlot.AlignedData = [tSec, series.acc_x, series.acc_y, series.acc_z];
      const gyroData: uPlot.AlignedData = [tSec, series.gyro_x, series.gyro_y, series.gyro_z];

      const refetchForRange = async (minSec: number, maxSec: number) => {
        const seq = ++fetchSeqRef.current;
        const s = await getSeries(
          sampleId,
          Math.round(Math.max(0, minSec * 1000)),
          Math.round(Math.min(durationRef.current, maxSec * 1000))
        );
        if (seq !== fetchSeqRef.current || !accPlotRef.current || !gyroPlotRef.current) return;
        const t = s.t.map((ms) => ms / 1000);
        accPlotRef.current.setData([t, s.acc_x, s.acc_y, s.acc_z]);
        gyroPlotRef.current.setData([t, s.gyro_x, s.gyro_y, s.gyro_z]);
      };

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefetch = (minSec: number, maxSec: number) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refetchForRange(minSec, maxSec), 250);
      };

      // 一张图缩放/平移后，把同样的x范围同步到另一张图，并统一触发一次数据刷新
      const onScaleChange = (source: "acc" | "gyro") => (u: uPlot, key: string) => {
        if (key !== "x" || syncingRef.current) return;
        const { min, max } = u.scales.x;
        if (min == null || max == null) return;

        syncingRef.current = true;
        const other = source === "acc" ? gyroPlotRef.current : accPlotRef.current;
        other?.setScale("x", { min, max });
        syncingRef.current = false;

        scheduleRefetch(min, max);
      };

      const syncKey = `imu-sync-${sampleId}`;

      const makeOpts = (
        title: string,
        colors: Record<string, string>,
        source: "acc" | "gyro",
        showXAxis: boolean
      ): uPlot.Options => ({
        title,
        width: (source === "acc" ? accRef.current! : gyroRef.current!).clientWidth,
        height,
        cursor: {
          drag: { x: false, y: false, setScale: false },
          sync: { key: syncKey, setSeries: false },
        },
        scales: { x: { time: false } },
        axes: [{ show: showXAxis }, {}],
        series: [
          { label: "t(s)" },
          ...Object.entries(colors).map(([label, stroke]) => ({ label, stroke, width: 1.5 })),
        ],
        hooks: { setScale: [onScaleChange(source)] },
        plugins: [dragPanPlugin(), wheelZoomPlugin()],
      });

      accPlotRef.current = new uPlot(makeOpts("加速度 Acc (g)", ACC_COLORS, "acc", false), accData, accRef.current);
      gyroPlotRef.current = new uPlot(
        makeOpts("角速度 Gyro (deg/s)", GYRO_COLORS, "gyro", true),
        gyroData,
        gyroRef.current
      );
    })();

    return () => {
      disposed = true;
      accPlotRef.current?.destroy();
      gyroPlotRef.current?.destroy();
      accPlotRef.current = null;
      gyroPlotRef.current = null;
    };
  }, [sampleId, height]);

  return (
    <div>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
        滚轮缩放 / 按住拖动左右平移 / 双击恢复整体视图（两张图联动）
      </div>
      <div ref={accRef} />
      <div ref={gyroRef} style={{ marginTop: 4 }} />
    </div>
  );
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

// 按住拖动左右平移（不是框选放大）：记录起点时刻的值，跟随鼠标位移量整体平移可视窗口
function dragPanPlugin() {
  let dragging = false;
  let startMin = 0;
  let startMax = 0;
  let startRelX = 0;
  let overRectLeft = 0;

  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;
        over.style.cursor = "grab";

        const onMouseDown = (e: MouseEvent) => {
          if (e.button !== 0) return;
          dragging = true;
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
          const v0 = u.posToVal(startRelX, "x");
          const v1 = u.posToVal(relX, "x");
          const dv = v1 - v0;
          u.setScale("x", { min: startMin - dv, max: startMax - dv });
        };

        const onMouseUp = () => {
          if (!dragging) return;
          dragging = false;
          over.style.cursor = "grab";
        };

        over.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      },
    },
  };
}
