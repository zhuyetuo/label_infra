import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Empty, Typography } from "antd";
import type { DailyStatsRow } from "@/api/dailyStats";
import "./TrackingCharts.css";

/**
 * 日常统计的趋势图：**一个类别一张图，一条线一只狗**。
 *
 * 为什么不是一张堆叠图：五个类别的量纲差一个数量级（睡觉十几小时、
 * 抓挠几分钟），堆在一起抓挠那条会被压成一条贴着 X 轴的线，
 * 而那恰好是最需要看的。跟皮肤评估那边「三个指标各画一张」同一个道理。
 *
 * 抓挠单独用**次数**，别的用**时长**——跟表格里那套一致。
 * 两处用不同口径的话，同一天的数看着对不上。
 */

const { Text } = Typography;

// 跟 TrackingCharts 同一套分类色。共用是为了让「同一只狗」在两个页面上
// 是同一个颜色——不同色的话人会以为是两只狗
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function isDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** 抓挠看次数，其余看时长（小时）。跟表格里那套口径一致。 */
const COUNT_LABELS = new Set(["抓挠", "甩身体"]);

const valueOf = (r: DailyStatsRow, label: string): number | null => {
  if (COUNT_LABELS.has(label)) return r.counts[label] ?? null;
  // 没有时长数据时给 null 而不是 0——uPlot 会断线，
  // 那正好表达"这天不知道"。给 0 的话画出来像"这天真的是 0"
  if (!r.has_seconds) return null;
  return (r.seconds[label] ?? 0) / 3600;
};

const unitOf = (label: string) => (COUNT_LABELS.has(label) ? "次" : "小时");

function OneChart({ rows, label, height }: { rows: DailyStatsRow[]; label: string; height: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [dark, setDark] = useState(isDark);
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
    // 标签页之间切换时组件不卸载，图可能是在「隐藏着」的时候建的——
    // 那会儿 clientWidth 是 0，uPlot 会按 0 宽画一张，切回来也不会长回去。
    // 所以盯着容器尺寸（跟 TrackingCharts 同一个处理）
    const ro = new ResizeObserver(() => setHostW(el.clientWidth));
    ro.observe(el);
    setHostW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { dogs, dates, series } = useMemo(() => {
    // 狗名排序固定，筛掉某只也不会让剩下的换颜色
    const dogSet = [...new Set(rows.map((r) => r.dog_name || r.imu))].sort();
    const dateSet = [...new Set(rows.map((r) => r.stat_date))].sort();
    const byKey = new Map(rows.map((r) => [`${r.stat_date}|${r.dog_name || r.imu}`, r]));
    const s = dogSet.map((d) =>
      dateSet.map((day) => {
        const r = byKey.get(`${day}|${d}`);
        return r ? valueOf(r, label) : null;
      })
    );
    return { dogs: dogSet, dates: dateSet, series: s };
  }, [rows, label]);

  const palette = dark ? SERIES_DARK : SERIES_LIGHT;

  useEffect(() => {
    if (!hostRef.current || dates.length === 0 || hostW <= 0) return;
    plotRef.current?.destroy();
    const xs = dates.map((d) => new Date(`${d}T00:00:00`).getTime() / 1000);
    const data = [xs, ...series] as unknown as uPlot.AlignedData;
    const axisStroke = dark ? "#c3c2b7" : "#52514e";
    const gridStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
    const unit = unitOf(label);

    const plot = new uPlot(
      {
        width: hostW,
        height,
        legend: { show: true, live: true },
        cursor: { points: { size: 8 }, focus: { prox: 24 } },
        scales: { x: { time: true } },
        axes: [
          { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke } },
          { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke } },
        ],
        series: [
          { label: "日期" },
          ...dogs.map((d, i) => ({
            label: d,
            stroke: palette[i % palette.length],
            width: 2,
            points: { show: true, size: 8, stroke: palette[i % palette.length], fill: palette[i % palette.length] },
            value: (_u: uPlot, v: number | null) =>
              v == null ? "—" : `${unit === "小时" ? v.toFixed(1) : v} ${unit}`,
          })),
        ],
      },
      data,
      hostRef.current
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [dogs, dates, series, palette, dark, height, hostW, label]);

  return (
    <div style={{ marginBottom: 18 }}>
      <Text strong>
        {label}
        <Text type="secondary" style={{ marginLeft: 6, fontWeight: 400 }}>
          （{unitOf(label)}）
        </Text>
      </Text>
      <div className="tracking-charts">
        <div ref={hostRef} />
      </div>
    </div>
  );
}

export default function DailyStatsCharts({
  rows,
  labels,
  height = 200,
}: {
  rows: DailyStatsRow[];
  labels: string[];
  height?: number;
}) {
  if (!rows.length || !labels.length) {
    return <Empty description="这个范围里没有数据" />;
  }
  return (
    <>
      {labels.map((l) => (
        <OneChart key={l} rows={rows} label={l} height={height} />
      ))}
      <Text type="secondary" style={{ fontSize: 12 }}>
        线断开 = 那天**没有时长数据**（不是 0）。补一下：
        <code style={{ marginLeft: 4 }}>
          docker compose exec api python -m app.scripts.backfill_label_seconds
        </code>
      </Text>
    </>
  );
}
