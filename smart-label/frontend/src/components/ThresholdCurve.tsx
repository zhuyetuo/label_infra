import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Space, Tag } from "antd";
import type { VersionResult } from "@/api/modelEval";
import { INFER_MODE_LABEL } from "@/utils/inferMode";

/**
 * 阈值曲线：横轴置信度阈值，纵轴精确率/召回率，每个版本两条线。
 *
 * 「换了模型之后旧阈值还能用吗」这个问题就靠它回答——两版曲线一叠，交叉点
 * 往哪边移了一目了然，不用凭感觉试。
 *
 * 精确率实线、召回率虚线，同一个版本同色；不做双轴（两个指标都是 0~1，本来
 * 就该共用一根 Y 轴）。
 */

const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];

function isDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export default function ThresholdCurve({ versions }: { versions: VersionResult[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [dark, setDark] = useState(isDark);
  // 标签页里建图时容器可能还是 0 宽，那样画出来是坏的且不会自愈——盯着尺寸来
  const [hostW, setHostW] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => setDark(isDark());
    mq?.addEventListener("change", onChange);
    const obs = new MutationObserver(onChange);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener("change", onChange);
      obs.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHostW(el.clientWidth));
    ro.observe(el);
    setHostW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const palette = dark ? SERIES_DARK : SERIES_LIGHT;

  const { xs, series } = useMemo(() => {
    const x = versions[0]?.curve.map((p) => p.threshold) ?? [];
    const s: number[][] = [];
    for (const v of versions) {
      s.push(v.curve.map((p) => p.precision));
      s.push(v.curve.map((p) => p.recall));
    }
    return { xs: x, series: s };
  }, [versions]);

  useEffect(() => {
    if (!hostRef.current || xs.length === 0 || hostW <= 0) return;
    plotRef.current?.destroy();
    const axisStroke = dark ? "#c3c2b7" : "#52514e";
    const gridStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
    const plot = new uPlot(
      {
        width: hostW,
        height: 280,
        legend: { show: true, live: true },
        cursor: { points: { size: 7 }, focus: { prox: 24 } },
        scales: { x: { time: false }, y: { range: [0, 1] } },
        axes: [
          { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, label: "置信度阈值" },
          { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 } },
        ],
        series: [
          { label: "阈值" },
          ...versions.flatMap((v, i) => [
            {
              label: `${v.model_tag}·${INFER_MODE_LABEL[v.mode] ?? v.mode} 精确率`,
              stroke: palette[i % palette.length],
              width: 2,
            },
            {
              label: `${v.model_tag}·${INFER_MODE_LABEL[v.mode] ?? v.mode} 召回率`,
              stroke: palette[i % palette.length],
              width: 2,
              dash: [5, 4],
            },
          ]),
        ],
      },
      [xs, ...series] as unknown as uPlot.AlignedData,
      hostRef.current
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [xs, series, versions, palette, dark, hostW]);

  if (!versions.length) return null;
  return (
    <div>
      <div ref={hostRef} />
      <Space size={4} style={{ marginTop: 4 }}>
        <Tag>实线 = 精确率（标出来的里面有多少是对的）</Tag>
        <Tag>虚线 = 召回率（该找出来的找到了多少）</Tag>
      </Space>
    </div>
  );
}
