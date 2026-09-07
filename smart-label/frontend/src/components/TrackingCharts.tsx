import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Radio, Space, Tag, Typography } from "antd";
import type { TrackingRow } from "@/api/skin";
import "./TrackingCharts.css";

/**
 * 每日跟踪的可视化：一条线一只狗，按天看走势。
 *
 * 三个指标（抓挠次数 / C 值 / S 总分）量纲完全不同，不做双轴——一次只画一个指标，
 * 用上面的按钮切；要对比就来回切，比两条 Y 轴叠在一张图上好读得多。
 * 「抓挠次数」这个指标额外画一条虚线基线（这只狗别的日子的中位数），C 值里的
 * 「变化幅度」就是拿当天跟它比出来的，看走势时得能看见这根线。
 */

// 分类色按固定顺序分配，不循环；浅色/深色各一套（同样八个色相为深色面重新取的步值）
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
// 档位是状态，不是分类，用固定的状态色，且始终带文字标签，不靠颜色单独表意
const TIER_COLOR: Record<string, string> = { C0: "#0ca30c", C1: "#fab219", C2: "#d03b3b" };

type Metric = "count" | "c" | "s";
const METRICS: { label: string; value: Metric; unit: string }[] = [
  { label: "抓挠次数", value: "count", unit: "次" },
  { label: "C 值", value: "c", unit: "" },
  { label: "S 总分", value: "s", unit: "" },
];

function isDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

const valueOf = (r: TrackingRow, m: Metric): number | null => {
  if (m === "count") return (r.stats?.event_count as number | undefined) ?? null;
  if (m === "c") return r.c_value;
  return r.s_with_q?.total ?? r.s_no_q?.total ?? null;
};

/** 单个指标的折线图：一条线一只狗。图表页把三个指标各画一张（小倍数），
 *  跟踪表里只画一张、用按钮切——两处共用这一个组件。 */
export function TrendChart({ rows, metric, height = 260 }: { rows: TrackingRow[]; metric: Metric; height?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [dark, setDark] = useState(isDark);

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

  const palette = dark ? SERIES_DARK : SERIES_LIGHT;

  // 一条线一只狗；狗名排序固定，筛选掉某只狗也不会让剩下的换颜色
  const { dogs, dates, series, baseline } = useMemo(() => {
    const dogSet = [...new Set(rows.map((r) => r.dog_name))].sort();
    const dateSet = [...new Set(rows.map((r) => r.date))].sort();
    const byKey = new Map(rows.map((r) => [`${r.date}|${r.dog_name}`, r]));
    const s = dogSet.map((d) =>
      dateSet.map((day) => {
        const r = byKey.get(`${day}|${d}`);
        return r ? valueOf(r, metric) : null;
      })
    );
    // 基线只有「抓挠次数」这个指标有可比性，其它指标不画
    const b =
      metric === "count"
        ? dogSet.map((d) =>
            dateSet.map((day) => {
              const r = byKey.get(`${day}|${d}`);
              return r?.baseline_count ?? null;
            })
          )
        : null;
    return { dogs: dogSet, dates: dateSet, series: s, baseline: b };
  }, [rows, metric]);

  useEffect(() => {
    if (!hostRef.current || dates.length === 0) return;
    plotRef.current?.destroy();
    const xs = dates.map((d) => new Date(`${d}T00:00:00`).getTime() / 1000);
    const data = [xs, ...series, ...(baseline ?? [])] as unknown as uPlot.AlignedData;
    const axisStroke = dark ? "#c3c2b7" : "#52514e";
    const gridStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";

    const plot = new uPlot(
      {
        width: hostRef.current.clientWidth,
        height,
        // 图例默认就在，>=2 条线时身份不能只靠颜色
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
          })),
          ...(baseline
            ? dogs.map((d, i) => ({
                label: `${d}·基线`,
                stroke: palette[i % palette.length],
                width: 1,
                dash: [4, 4],
                points: { show: false },
              }))
            : []),
        ],
      },
      data,
      hostRef.current
    );
    plotRef.current = plot;
    const onResize = () => plot.setSize({ width: hostRef.current!.clientWidth, height });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plot.destroy();
      plotRef.current = null;
    };
  }, [dogs, dates, series, baseline, palette, dark, height]);

  if (!rows.length) return null;
  return <div className="tracking-charts"><div ref={hostRef} /></div>;
}

/** C 档位分布：每只狗 C0/C1/C2 各多少天 */
export function TierDistribution({ rows }: { rows: TrackingRow[] }) {
  const tierDist = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    for (const r of rows) {
      if (!r.c_tier) continue;
      const rec = m.get(r.dog_name) ?? { C0: 0, C1: 0, C2: 0 };
      rec[r.c_tier] = (rec[r.c_tier] ?? 0) + 1;
      m.set(r.dog_name, rec);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  if (!tierDist.length) return null;
  return (
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            C 档位分布（天数）：
          </Typography.Text>
          {tierDist.map(([dog, counts]) => {
            const total = counts.C0 + counts.C1 + counts.C2;
            return (
              <div key={dog} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ width: 150, fontSize: 12, flex: "0 0 auto" }}>{dog}</span>
                <div style={{ flex: 1, display: "flex", height: 18, borderRadius: 4, overflow: "hidden", gap: 2 }}>
                  {(["C0", "C1", "C2"] as const).map((t) =>
                    counts[t] ? (
                      <div
                        key={t}
                        title={`${t}：${counts[t]} 天`}
                        style={{
                          width: `${(counts[t] / total) * 100}%`,
                          background: TIER_COLOR[t],
                          color: t === "C1" ? "#0b0b0b" : "#fff",
                          fontSize: 11,
                          lineHeight: "18px",
                          textAlign: "center",
                          borderRadius: 3,
                        }}
                      >
                        {t} {counts[t]}
                      </div>
                    ) : null
                  )}
                </div>
                <span style={{ fontSize: 12, width: 50, flex: "0 0 auto" }}>共 {total} 天</span>
              </div>
            );
          })}
          <Space size={4} style={{ marginTop: 6 }}>
            {(["C0", "C1", "C2"] as const).map((t) => (
              <Tag key={t} color={TIER_COLOR[t]}>
                {t}
                {t === "C0" ? " 正常" : t === "C1" ? " 偏高" : " 严重"}
              </Tag>
            ))}
          </Space>
        </div>
  );
}

/** 跟踪表上方的紧凑版：一次一个指标，用按钮切 */
export default function TrackingCharts({ rows }: { rows: TrackingRow[] }) {
  const [metric, setMetric] = useState<Metric>("count");
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Radio.Group
          size="small"
          optionType="button"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          options={METRICS.map((m) => ({ label: m.label, value: m.value }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          一条线一只狗，鼠标移上去看当天数值。
          {metric === "count" && "虚线是基线（这只狗别的日子的中位数）。"}
          {metric === "s" && "有问答记录的用含问答的 S，没有的用不填问答的下限值。"}
          {" 三个指标量纲不同，只能一次看一个，不做双轴。"}
        </Typography.Text>
      </Space>
      <TrendChart rows={rows} metric={metric} />
      <TierDistribution rows={rows} />
    </div>
  );
}

export { METRICS };
export type { Metric };
