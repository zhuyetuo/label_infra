import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Space, Tag, Typography } from "antd";
import type { TrackingRow } from "@/api/skin";
import "./TrackingCharts.css";
import DogInfoPopover from "./DogInfoPopover";

/**
 * 「趋势图表」页用的两个图：一条线一只狗的折线图，和 C 档位时间线（一只狗一行、一天一格）。
 *
 * 三个指标（抓挠次数 / C 值 / S 总分）量纲完全不同，不做双轴——图表页把三张图
 * 上下排开（小倍数），各自一套 Y 轴，比两条 Y 轴叠在一张图上好读得多。
 * 「抓挠次数」那张额外画一条虚线基线（这只狗别的日子的中位数），C 值里的
 * 「变化幅度」就是拿当天跟它比出来的，看走势时得能看见这根线。
 */

// 分类色按固定顺序分配，不循环；浅色/深色各一套（同样八个色相为深色面重新取的步值）
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
// 档位是状态，不是分类，用固定的状态色，且始终带文字标签，不靠颜色单独表意
const TIER_COLOR: Record<string, string> = { C0: "#0ca30c", C1: "#fab219", C2: "#d03b3b" };

type Metric = "count" | "c" | "s" | "photo";
const METRICS: { label: string; value: Metric; unit: string }[] = [
  { label: "抓挠次数", value: "count", unit: "次" },
  { label: "C 值", value: "c", unit: "" },
  { label: "S 总分", value: "s", unit: "" },
  // 看皮肤照片评的档（兽医评过的以兽医为准，没有就取几个人的共识）：S0=0 / S1=1 / S2=2，看不清 / 没评的空着
  { label: "照片评级", value: "photo", unit: "" },
];
const PHOTO_NUM: Record<string, number> = { S0: 0, S1: 1, S2: 2 };

function isDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** 秒级时间戳 → 「11-03」 */
const dayLabel = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const valueOf = (r: TrackingRow, m: Metric): number | null => {
  if (m === "count") return (r.stats?.event_count as number | undefined) ?? null;
  if (m === "c") return r.c_value;
  if (m === "photo") {
    const g = r.photo_grade_vet ?? r.photo_grade;
    return g != null && g in PHOTO_NUM ? PHOTO_NUM[g] : null;
  }
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

  // 容器实际宽度。标签页之间来回切时组件并不卸载，图表可能是在「隐藏着」的时候
  // 建的——那会儿 clientWidth 是 0，uPlot 就按 0 宽画了一张，切回来也不会自己
  // 长回去（表现就是坐标轴文字竖着挤成一列、图整个是空的，非刷新不可）。所以
  // 盯着容器尺寸：宽度为 0 时干脆不建，变了就 setSize。
  const [hostW, setHostW] = useState(0);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHostW(el.clientWidth));
    ro.observe(el);
    setHostW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!hostRef.current || dates.length === 0 || hostW <= 0) return;
    plotRef.current?.destroy();
    const xs = dates.map((d) => new Date(`${d}T00:00:00`).getTime() / 1000);
    const data = [xs, ...series, ...(baseline ?? [])] as unknown as uPlot.AlignedData;
    const axisStroke = dark ? "#c3c2b7" : "#52514e";
    const gridStroke = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";

    const plot = new uPlot(
      {
        width: hostW,
        height,
        // 图例默认就在，>=2 条线时身份不能只靠颜色
        legend: { show: true, live: true },
        cursor: { points: { size: 8 }, focus: { prox: 24 } },
        scales: { x: { time: true } },
        axes: [
          // 一天一个点，横轴只写日期：刻度只取整天（1 / 2 / 7 / 14 / 30 天一格，按宽度挑），不出 12am / 12pm
          {
            stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke },
            space: 48,
            incrs: [1, 2, 7, 14, 30].map((d) => d * 86400),
            values: (_u: uPlot, splits: number[]) => splits.map(dayLabel),
          },
          metric === "photo"
            ? { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke },
                incrs: [1], values: (_u: uPlot, splits: number[]) => splits.map((v) => (Number.isInteger(v) && v >= 0 && v <= 2 ? `S${v}` : "")) }
            : { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke } },
        ],
        series: [
          { label: "日期", value: (_u: uPlot, v: number | null) => (v == null ? "--" : dayLabel(v)) },
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
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // hostW 变了就重建/重设尺寸，窗口缩放和"从隐藏变可见"走的是同一条路
  }, [dogs, dates, series, baseline, palette, dark, height, hostW]);

  if (!rows.length) return null;
  return <div className="tracking-charts"><div ref={hostRef} /></div>;
}

/** 一个日期区间里的每一天（YYYY-MM-DD），中间缺的天也列出来，好看出哪天没数据 */
function allDays(dates: string[]): string[] {
  if (!dates.length) return [];
  const sorted = [...dates].sort();
  const out: string[] = [];
  const d = new Date(sorted[0] + "T00:00:00");
  const end = new Date(sorted[sorted.length - 1] + "T00:00:00");
  while (d <= end && out.length < 400) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** C 档位时间线：一只狗一行，一天一格，按日期从左到右，格子颜色是那天的档位；右边是各档天数 */
export function TierDistribution({ rows }: { rows: TrackingRow[] }) {
  const { days, dogs } = useMemo(() => {
    const byDog = new Map<string, Map<string, TrackingRow>>();
    for (const r of rows) {
      if (!r.c_tier) continue;
      const m = byDog.get(r.dog_name) ?? new Map<string, TrackingRow>();
      m.set(r.date, r);
      byDog.set(r.dog_name, m);
    }
    const days = allDays(rows.filter((r) => r.c_tier).map((r) => r.date));
    const dogs = [...byDog.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { days, dogs };
  }, [rows]);
  if (!dogs.length) return null;
  // 天多的时候日期标签隔几天写一个，免得挤在一起
  const labelEvery = Math.max(1, Math.ceil(days.length / 20));
  const cellText = days.length <= 31; // 格子够宽才在格子里写档位
  const NAME_W = 150;
  const SUM_W = 150;
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        C 档位（按日期，一格一天；灰格 = 那天没数据）：
      </Typography.Text>
      {/* 日期刻度 */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 4 }}>
        <span style={{ width: NAME_W, flex: "0 0 auto" }} />
        <div style={{ flex: 1, display: "flex", gap: 2 }}>
          {days.map((d, i) => (
            <div key={d} style={{ flex: 1, minWidth: 0, fontSize: 10, color: "#999", textAlign: "center", whiteSpace: "nowrap", overflow: "visible" }}>
              {i % labelEvery === 0 ? d.slice(5) : ""}
            </div>
          ))}
        </div>
        <span style={{ width: SUM_W, flex: "0 0 auto" }} />
      </div>
      {dogs.map(([dog, byDate]) => {
        const counts: Record<string, number> = { C0: 0, C1: 0, C2: 0 };
        byDate.forEach((r) => { counts[r.c_tier!] = (counts[r.c_tier!] ?? 0) + 1; });
        return (
          <div key={dog} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <span style={{ width: NAME_W, fontSize: 12, flex: "0 0 auto" }}><DogInfoPopover name={dog} /></span>
            <div style={{ flex: 1, display: "flex", height: 20, gap: 2 }}>
              {days.map((d) => {
                const r = byDate.get(d);
                const t = r?.c_tier;
                return (
                  <div
                    key={d}
                    title={t ? `${d} ${dog}：${t}${r?.c_value != null ? `（C 值 ${r.c_value}）` : ""}` : `${d} ${dog}：没数据`}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      borderRadius: 3,
                      background: t ? TIER_COLOR[t] : "rgba(128,128,128,0.18)",
                      color: t === "C1" ? "#0b0b0b" : "#fff",
                      fontSize: 10,
                      lineHeight: "20px",
                      textAlign: "center",
                      overflow: "hidden",
                    }}
                  >
                    {cellText && t ? t : ""}
                  </div>
                );
              })}
            </div>
            <span style={{ fontSize: 12, width: SUM_W, flex: "0 0 auto", whiteSpace: "nowrap" }}>
              C0 {counts.C0} · C1 {counts.C1} · C2 {counts.C2}
            </span>
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
        <Tag>灰 没数据</Tag>
      </Space>
    </div>
  );
}

export { METRICS };
export type { Metric };
