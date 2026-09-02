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

const CHANNEL_COLORS: Record<string, string> = {
  acc_x: "#e74c3c",
  acc_y: "#2ecc71",
  acc_z: "#3498db",
  gyro_x: "#e67e22",
  gyro_y: "#1abc9c",
  gyro_z: "#9b59b6",
};

const getMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
const getSeries = (sampleId: number, startMs: number, endMs: number, maxPoints = 1500) =>
  request.get<never, ImuSeries>(`/imu/${sampleId}/series`, {
    params: { start_ms: startMs, end_ms: endMs, max_points: maxPoints },
  });

interface Props {
  sampleId: number;
  height?: number;
}

export default function ImuChart({ sampleId, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const durationRef = useRef<number>(0);
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    let disposed = false;

    (async () => {
      const meta = await getMeta(sampleId);
      if (disposed || !containerRef.current) return;
      durationRef.current = meta.duration_ms;

      const series = await getSeries(sampleId, 0, meta.duration_ms);
      if (disposed || !containerRef.current) return;

      const data: uPlot.AlignedData = [
        series.t.map((ms) => ms / 1000),
        series.acc_x,
        series.acc_y,
        series.acc_z,
        series.gyro_x,
        series.gyro_y,
        series.gyro_z,
      ];

      const refetchForRange = async (minSec: number, maxSec: number) => {
        const seq = ++fetchSeqRef.current;
        const s = await getSeries(
          sampleId,
          Math.round(Math.max(0, minSec * 1000)),
          Math.round(Math.min(durationRef.current, maxSec * 1000))
        );
        if (seq !== fetchSeqRef.current || !plotRef.current) return; // 有更新的请求已经发出，丢弃这次结果
        plotRef.current.setData([
          s.t.map((ms) => ms / 1000),
          s.acc_x,
          s.acc_y,
          s.acc_z,
          s.gyro_x,
          s.gyro_y,
          s.gyro_z,
        ]);
      };

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleRefetch = (minSec: number, maxSec: number) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => refetchForRange(minSec, maxSec), 250);
      };

      const opts: uPlot.Options = {
        width: containerRef.current.clientWidth,
        height,
        cursor: {
          drag: { x: true, y: false, setScale: true },
        },
        scales: { x: { time: false } },
        series: [
          { label: "t(s)" },
          ...(["acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z"] as const).map((c) => ({
            label: c,
            stroke: CHANNEL_COLORS[c],
            width: 1.5,
          })),
        ],
        hooks: {
          setScale: [
            (u, key) => {
              if (key !== "x") return;
              const { min, max } = u.scales.x;
              if (min == null || max == null) return;
              scheduleRefetch(min, max);
            },
          ],
        },
        plugins: [wheelZoomPlugin()],
      };

      plotRef.current = new uPlot(opts, data, containerRef.current);
    })();

    return () => {
      disposed = true;
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [sampleId, height]);

  return (
    <div>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
        滚轮缩放 / 拖动框选放大 / 双击恢复整体视图
      </div>
      <div ref={containerRef} />
    </div>
  );
}

// uPlot 官方推荐的 wheel 缩放 + 拖拽平移写法，双击恢复初始范围
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
