import { Button, Checkbox, ConfigProvider, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { AimOutlined, CaretRightOutlined, LockOutlined, CloseOutlined, LineChartOutlined, MinusOutlined, PauseOutlined, PlusOutlined, PushpinOutlined, QuestionCircleOutlined, UnlockOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import request from "@/utils/request";
import type { TimeBus } from "@/utils/timeBus";

/**
 * 循环播放时的「这一段的波形」浮窗：已标注片段、疑似片段点「循环播放」都会弹。
 *
 * 为什么要它：画面有时看不清（狗背对镜头、被栏杆挡住），但同一种动作的加速度波形
 * 长得很像——舔是规整的小幅往复，抓挠是又快又密的大幅振荡，饮水是很规整的 3–5 Hz。
 * 下面那张整段的大波形图要自己缩放到这几秒才看得清，这里只画这一段（前后各留一点），
 * 播放头跟着视频走。
 *
 * 「钉住」：把当前这段的波形留在下面，再去循环别的段，两个并排比——
 * 拿一段确定是舔的当参照，看这段疑似的长得像不像。横轴都从片段起点算，纵横轴共用范围，
 * 形状和快慢才能直接比。
 *
 * 位置、大小、要不要自动弹、平滑 / 跟随这些都记在 localStorage 里，下次打开还是那样。
 */

interface Series {
  t: number[];
  acc_x: number[];
  acc_y: number[];
  acc_z: number[];
  gyro_x: number[];
  gyro_y: number[];
  gyro_z: number[];
}

type ChKey = Exclude<keyof Series, "t">;
const ACC: { key: ChKey; label: string; color: string }[] = [
  { key: "acc_x", label: "X", color: "#e74c3c" },
  { key: "acc_y", label: "Y", color: "#27ae60" },
  { key: "acc_z", label: "Z", color: "#2980b9" },
];
const GYRO: { key: ChKey; label: string; color: string }[] = [
  { key: "gyro_x", label: "GX", color: "#e67e22" },
  { key: "gyro_y", label: "GY", color: "#16a085" },
  { key: "gyro_z", label: "GZ", color: "#8e44ad" },
];

export interface LoopInfo {
  startMs: number;
  endMs: number;
  /** 「已标注 · 饮水」「疑似 · 舔」 */
  title: string;
  color?: string;
  /** 已标注片段 / 疑似片段的 id：有它（且给了 onAdjust）才能在波形上拖起止、保存 */
  itemId?: number;
  candId?: number;
  /** 附近的别的片段：图顶上画一条细色带 + 名字，看得出这一段前后挨着的是什么 */
  neighbors?: { s: number; e: number; color: string; label: string }[];
}

export type AdjustTarget = { kind: "item" | "cand"; id: number };

interface Snap {
  id: number;
  info: LoopInfo;
  /** 一打开时片段前后各多看多少（初始视图） */
  padMs: number;
  /** 实际拉回来的数据前后各多少：Shift+滚轮缩小时能看到更多上下文 */
  ctxMs: number;
  series: Series;
}

// ── 记住的设置 ──────────────────────────────────────────────────────────
interface Cfg {
  left: number;
  top: number;
  /** 图区宽 / 主图高（像素） */
  w: number;
  h: number;
  /** 循环时自动弹出；关掉的话只在角上留一个「波形」小按钮，点了才开 */
  auto: boolean;
  gyro: boolean;
  /** 平滑：样条连线 + 轻微滑动平均。原始数据 25Hz，直接连折线锯齿很多 */
  smooth: boolean;
  /** 长片段只看播放头附近 winSec 秒，跟着播放滚动；关掉 = 整段压在一张图里 */
  follow: boolean;
  winSec: number;
  /** 锁住位置和大小：标题栏拖不动、边角不能改大小，免得点按钮时误拖 */
  locked?: boolean;
}
const CFG_KEY = "loop-waveform-cfg";
const defaultCfg = (): Cfg => ({
  left: Math.max(0, window.innerWidth - 520),
  top: Math.max(0, window.innerHeight - 330),
  w: 460,
  h: 170,
  auto: true,
  gyro: false,
  smooth: true,
  follow: true,
  winSec: 10,
});
function loadCfg(): Cfg {
  const d = defaultCfg();
  try {
    const v = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
    if (v && typeof v === "object") {
      const c = { ...d, ...v } as Cfg;
      // 换了个小屏幕打开：别让它整个跑到屏幕外面去
      c.w = Math.min(Math.max(300, c.w), window.innerWidth - 40);
      c.h = Math.min(Math.max(90, c.h), window.innerHeight - 160);
      c.left = Math.min(Math.max(0, c.left), Math.max(0, window.innerWidth - c.w - 24));
      c.top = Math.min(Math.max(0, c.top), Math.max(0, window.innerHeight - 120));
      return c;
    }
  } catch {
    // 存的东西坏了就用默认
  }
  return d;
}

/** 前后各留多少：短段多留一点，不然看不出起止前后是什么样 */
const padOf = (durMs: number) => Math.min(3000, Math.max(800, durMs * 0.3));
/** 前后各拉多少数据：至少 30 秒、最多 1 分钟。起止拖到这截数据的头上松手，会再往外多拉一截 */
const ctxOf = (durMs: number) => Math.min(60000, Math.max(30000, durMs));

const fetchSeries = (sampleId: number, startMs: number, endMs: number) =>
  request.get<never, Series>(`/imu/${sampleId}/series`, {
    // 点数给足：长片段（一分多钟）按 1200 点抽稀的话峰会被抽掉，看着更碎
    params: { start_ms: Math.max(0, Math.round(startMs)), end_ms: Math.round(endMs), max_points: 6000 },
  });

/** 居中滑动平均。窗口很小（3 点 ≈ 25Hz 下 0.12 秒）：去掉逐点的毛刺，不吃掉动作本身的起伏 */
function movingAvg(v: number[], k = 3): number[] {
  if (k <= 1 || v.length < k) return v;
  const h = Math.floor(k / 2);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) {
      const x = v[j];
      if (j >= 0 && j < v.length && x != null && !Number.isNaN(x)) { s += x; n++; }
    }
    out[i] = n ? s / n : v[i];
  }
  return out;
}

const spline = uPlot.paths.spline?.();

/** 纵轴自适应：只看当前横轴范围里的点，按 0.5% ~ 99.5% 分位定上下限，留 12% 余量。
 *  seg（相对秒）= 片段本身：这一截**完整**放进来，不按分位裁——片段两边平稳的数据一多，
 *  分位就会落在平稳那一档，把片段里真正要看的动作（抓挠的大幅抖动）切掉 */
function fitVisible(u: uPlot, seg?: [number, number]): [number, number] {
  const xs = u.data[0] as number[];
  const mn = u.scales.x.min ?? -Infinity, mx = u.scales.x.max ?? Infinity;
  const vals: number[] = [];
  let segLo = Infinity, segHi = -Infinity;
  for (let s = 1; s < u.data.length; s++) {
    const ys = u.data[s] as (number | null)[];
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < mn || xs[i] > mx) continue;
      const v = ys[i];
      if (v != null && Number.isFinite(v)) {
        vals.push(v);
        if (seg && xs[i] >= seg[0] && xs[i] <= seg[1]) {
          if (v < segLo) segLo = v;
          if (v > segHi) segHi = v;
        }
      }
    }
  }
  if (!vals.length) return [-1, 1];
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  let lo = vals.length > 200 ? q(0.005) : vals[0];
  let hi = vals.length > 200 ? q(0.995) : vals[vals.length - 1];
  if (Number.isFinite(segLo)) {
    lo = Math.min(lo, segLo);
    hi = Math.max(hi, segHi);
  }
  if (hi - lo < 0.05) {
    const m = (hi + lo) / 2;
    lo = m - 0.05;
    hi = m + 0.05;
  }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

function MiniPlot({
  snap, chans, smooth, yRange, xRange, width, height, bus, live, follow, winSec, axisColor,
  rangeRef, editable, onEdge, onScrub, onMove, onDragEnd, version, resetKey, neighbors, widen = 1,
}: {
  snap: Snap;
  chans: typeof ACC;
  smooth: boolean;
  yRange: [number, number] | null;
  xRange: [number, number] | null;
  width: number;
  height: number;
  bus?: TimeBus;
  live?: boolean;
  /** 只看播放头附近 winSec 秒、跟着滚 */
  follow?: boolean;
  winSec: number;
  axisColor: string;
  /** 现在的起止（绝对毫秒）。拖边的时候改它、只重画不重建；不给就用 snap 里的 */
  rangeRef?: React.MutableRefObject<{ s: number; e: number }>;
  /** 能拖起止 */
  editable?: boolean;
  /** 拖边：which = 起 / 止，ms = 新位置（绝对毫秒） */
  onEdge?: (which: "s" | "e", ms: number) => void;
  /** 点 / 拖图上别处：把视频跳到那里 */
  onScrub?: (ms: number) => void;
  /** 按住色块顶上那条拖：整段平移，给新的起止（绝对毫秒） */
  onMove?: (s: number, e: number) => void;
  /** 拖边 / 拖整段松手 */
  onDragEnd?: () => void;
  /** 浮窗拉宽了几倍：初始视图前后按比例多看一些（一秒的像素宽度不变，宽了就是看得更多） */
  widen?: number;
  /** 外面改了 rangeRef（「起点设到播放线」）时加一，图跟着重画 */
  version?: number;
  /** 加一 = 视图回到初始（取消 Shift+滚轮的缩放 / 平移） */
  resetKey?: number;
  neighbors?: LoopInfo["neighbors"];
}) {
  const el = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const dur = (snap.info.endMs - snap.info.startMs) / 1000;
  // 片段比窗口短就没必要跟着滚，整段都放得下
  const scrolling = !!follow && dur > winSec * 1.2;

  // 交互回调放 ref 里：它们每次渲染都是新函数，放进 effect 依赖会让图每次都重建
  const cb = useRef({ onEdge, onScrub, onMove, onDragEnd, editable, neighbors });
  cb.current = { onEdge, onScrub, onMove, onDragEnd, editable, neighbors };
  // 人用 Shift+滚轮 缩放 / Shift+拖 平移过：跟随模式就别再自己挪窗口
  const zoomedRef = useRef(false);
  const initXRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const { series, info } = snap;
    const cur = () => (rangeRef?.current ? rangeRef.current : { s: info.startMs, e: info.endMs });
    // 横轴：相对片段起点的秒。钉住的几段起点都对齐在 0，形状才能直接比
    const xs = series.t.map((ms) => (ms - info.startMs) / 1000);
    const band = info.color ?? "#4096ff";
    const pad = snap.padMs / 1000;
    // 数据比初始视图宽（前后多拉了上下文），初始视图要明确给，不能让 uPlot 按数据自动铺满
    // 起止已经被拖到原来视图外面（往外多拉了数据、图重建）：初始视图要把现在的起止也包进来
    const r0 = cur();
    const rs0 = (r0.s - info.startMs) / 1000, re0 = (r0.e - info.startMs) / 1000;
    const extra = ((dur + 2 * pad) * (widen - 1)) / 2;
    const initX: [number, number] = scrolling
      ? [-pad, -pad + winSec]
      : xRange ?? [Math.max(-info.startMs / 1000, Math.min(-pad, rs0 - pad) - extra), Math.max(dur + pad, re0 + pad) + extra];
    initXRef.current = initX;
    zoomedRef.current = false;
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      cursor: { show: false },
      scales: {
        // 不能给 x 一个固定返回 initX 的 range 函数：uPlot 的 setScale 也会过一遍 range，
        // 那样跟随模式怎么 setScale 都被拉回原位。这里原样放行，初始窗口在建好之后 setScale
        x: { time: false, auto: false, range: (_u, mn, mx) => [mn, mx] },
        // 纵轴：钉住了几段要并排比时用共用的范围；平时按**当前看得见的那一截**自适应——
        // 原来按拉回来的整截数据（前后各 30 秒）取最大最小，别处一个大冲击就把这一段压成一条线。
        // 取 0.5% ~ 99.5% 分位，孤立的尖峰不撑大量程，再留 12% 余量
        y: yRange ? { range: () => yRange } : {
          auto: true,
          range: (u) => {
            const r = cur();
            return fitVisible(u, [(r.s - info.startMs) / 1000, (r.e - info.startMs) / 1000]);
          },
        },
      },
      axes: [
        { stroke: axisColor, grid: { stroke: "rgba(128,128,128,.15)" }, size: 22, font: "10px sans-serif",
          values: (_u, v) => v.map((x) => `${+x.toFixed(1)}s`) },
        { stroke: axisColor, grid: { stroke: "rgba(128,128,128,.15)" }, size: 34, font: "10px sans-serif" },
      ],
      series: [{}, ...chans.map((c) => ({ stroke: c.color, width: 1.25, ...(smooth && spline ? { paths: spline } : {}) }))],
      hooks: {
        // 片段本身那几秒铺一层底色，前后留的那截不铺：一眼看出边界在哪
        drawClear: [
          (u) => {
            const { left, top, width: bw, height: h } = u.bbox;
            const r = cur();
            const rs = (r.s - info.startMs) / 1000, re = (r.e - info.startMs) / 1000;
            // 片段起止可能在可见窗口外面（跟随模式），夹到绘图区里，别涂到坐标轴上
            const x0 = Math.max(left, u.valToPos(rs, "x", true));
            const x1 = Math.min(left + bw, u.valToPos(re, "x", true));
            if (x1 > x0) {
              u.ctx.save();
              u.ctx.fillStyle = band;
              u.ctx.globalAlpha = 0.14;
              u.ctx.fillRect(x0, top, x1 - x0, h);
              u.ctx.restore();
            }
            // 附近别的片段：顶上一条细色带 + 名字
            const nb = cb.current.neighbors ?? [];
            if (nb.length) {
              const dpr = window.devicePixelRatio || 1;
              u.ctx.save();
              u.ctx.font = `${10 * dpr}px sans-serif`;
              u.ctx.textBaseline = "top";
              u.ctx.textAlign = "left";
              for (const n of nb) {
                const a = Math.max(left, u.valToPos((n.s - info.startMs) / 1000, "x", true));
                const b = Math.min(left + bw, u.valToPos((n.e - info.startMs) / 1000, "x", true));
                if (b <= a) continue;
                u.ctx.globalAlpha = 0.55;
                u.ctx.fillStyle = n.color;
                u.ctx.fillRect(a, top, b - a, 4 * dpr);
                u.ctx.globalAlpha = 0.9;
                if (b - a > 30 * dpr) u.ctx.fillText(n.label, a + 2 * dpr, top + 5 * dpr, b - a - 4 * dpr);
              }
              u.ctx.restore();
            }
            // 能改起止：两条边画粗一点、带个把手，看得出能拖
            if (cb.current.editable) {
              const dpr = window.devicePixelRatio || 1;
              u.ctx.save();
              u.ctx.strokeStyle = band;
              u.ctx.fillStyle = band;
              u.ctx.lineWidth = 2 * dpr;
              for (const v of [rs, re]) {
                const x = u.valToPos(v, "x", true);
                if (x < left - 1 || x > left + bw + 1) continue;
                u.ctx.beginPath();
                u.ctx.moveTo(x, top);
                u.ctx.lineTo(x, top + h);
                u.ctx.stroke();
                u.ctx.fillRect(x - 4 * dpr, top + h / 2 - 9 * dpr, 8 * dpr, 18 * dpr);
              }
              // 顶上一条把手：按住它拖 = 整段平移（起止一起挪，长度不变）
              const gx0 = Math.max(left, u.valToPos(rs, "x", true));
              const gx1 = Math.min(left + bw, u.valToPos(re, "x", true));
              if (gx1 > gx0) {
                u.ctx.globalAlpha = 0.55;
                u.ctx.fillRect(gx0, top, gx1 - gx0, 14 * dpr);
                u.ctx.globalAlpha = 1;
                u.ctx.font = `${10 * dpr}px sans-serif`;
                u.ctx.textBaseline = "top";
                u.ctx.textAlign = "left";
                const text = ["⇔ 按住这条拖动整段", "⇔ 拖动整段", "⇔"].find(
                  (t) => gx1 - gx0 > u.ctx.measureText(t).width + 8 * dpr);
                if (text) {
                  u.ctx.fillStyle = "#fff";
                  u.ctx.fillText(text, gx0 + 4 * dpr, top + 2 * dpr);
                }
              }
              u.ctx.restore();
            }
          },
        ],
      },
    };
    const data: uPlot.AlignedData = [xs, ...chans.map((c) => (smooth ? movingAvg(series[c.key] ?? []) : series[c.key] ?? []))];
    plotRef.current?.destroy();
    const u = new uPlot(opts, data, el.current);
    plotRef.current = u;
    u.setScale("x", { min: initX[0], max: initX[1] });
    const dataLo = xs[0] ?? -pad, dataHi = xs[xs.length - 1] ?? dur + pad;

    // 交互：在图上按下——靠近起 / 止那条边（8 像素内）就是拖边，否则是拖播放位置
    const over = u.over;
    const msAt = (clientX: number) => {
      const rect = over.getBoundingClientRect();
      return Math.round(info.startMs + u.posToVal(clientX - rect.left, "x") * 1000);
    };
    const edgeAt = (clientX: number, clientY?: number): "s" | "e" | "m" | null => {
      if (!cb.current.editable) return null;
      const rect = over.getBoundingClientRect();
      const r = cur();
      const xs_ = u.valToPos((r.s - info.startMs) / 1000, "x", false);
      const xe_ = u.valToPos((r.e - info.startMs) / 1000, "x", false);
      const px = clientX - rect.left;
      const ds = Math.abs(px - xs_), de = Math.abs(px - xe_);
      if (Math.min(ds, de) <= 8) return ds <= de ? "s" : "e";
      // 色块顶上 14 像素那条：整段拖
      if (clientY != null && clientY - rect.top <= 14 && px > xs_ && px < xe_) return "m";
      return null;
    };
    const onHover = (ev: MouseEvent) => {
      const w = edgeAt(ev.clientX, ev.clientY);
      over.style.cursor = w === "m" ? "grab" : w ? "ew-resize" : cb.current.onScrub ? "pointer" : "default";
    };
    // Shift+滚轮：以鼠标位置为中心缩放（不按 Shift 照常滚页面）
    const onWheel = (ev: WheelEvent) => {
      if (!ev.shiftKey) return;
      ev.preventDefault();
      // 有的系统按着 Shift 滚轮会变成横向滚动，deltaY 是 0、值在 deltaX 里
      const d = ev.deltaY || ev.deltaX;
      if (!d) return;
      const rect = over.getBoundingClientRect();
      const at = u.posToVal(ev.clientX - rect.left, "x");
      const mn = u.scales.x.min ?? dataLo, mx = u.scales.x.max ?? dataHi;
      const k = d > 0 ? 1.25 : 0.8;
      let span = Math.min(dataHi - dataLo, Math.max(0.5, (mx - mn) * k));
      let nmin = at - (at - mn) * (span / (mx - mn));
      nmin = Math.min(Math.max(dataLo, nmin), dataHi - span);
      span = Math.min(span, dataHi - nmin);
      zoomedRef.current = true;
      u.setScale("x", { min: nmin, max: nmin + span });
    };
    // 拖起止时保证 [a, b]（相对秒）在视图里，留 8% 余量；不够就把视图往那边扩（不缩另一边）。
    // 最多扩到样本开头；右边不设限（超出已拉数据的部分先空着，松手后会补拉）
    const reveal = (a: number, b: number) => {
      const mn = u.scales.x.min ?? 0, mx = u.scales.x.max ?? 1;
      const margin = (mx - mn) * 0.08;
      let nmn = mn, nmx = mx;
      if (a < mn + margin) nmn = Math.max(-info.startMs / 1000, a - margin * 1.5);
      if (b > mx - margin) nmx = b + margin * 1.5;
      if (nmn !== mn || nmx !== mx) {
        zoomedRef.current = true;
        u.setScale("x", { min: nmn, max: nmx });
      }
    };
    // 鼠标在图的左右 12 像素以内或者已经出去了
    const atBorder = (clientX: number) => {
      const rect = over.getBoundingClientRect();
      return clientX < rect.left + 12 || clientX > rect.right - 12;
    };
    const onDown = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      // Shift+拖：左右平移
      if (ev.shiftKey) {
        ev.preventDefault();
        const rect = over.getBoundingClientRect();
        const x0 = ev.clientX, mn0 = u.scales.x.min ?? 0, mx0 = u.scales.x.max ?? 1;
        const perPx = (mx0 - mn0) / Math.max(1, rect.width);
        const move = (e2: MouseEvent) => {
          const span = mx0 - mn0;
          let nmin = mn0 - (e2.clientX - x0) * perPx;
          nmin = Math.min(Math.max(dataLo, nmin), dataHi - span);
          zoomedRef.current = true;
          u.setScale("x", { min: nmin, max: nmin + span });
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return;
      }
      const which = edgeAt(ev.clientX, ev.clientY);
      if (which === "m") {
        ev.preventDefault();
        const a0 = msAt(ev.clientX), r0 = { ...cur() };
        over.style.cursor = "grabbing";
        let lastX = ev.clientX;
        const apply = (x: number) => {
          const d = msAt(x) - a0;
          cb.current.onMove?.(r0.s + d, r0.e + d);
          const r = cur();
          reveal((r.s - info.startMs) / 1000, (r.e - info.startMs) / 1000);
          u.redraw(false);
        };
        const move = (e2: MouseEvent) => {
          lastX = e2.clientX;
          apply(lastX);
        };
        const timer = window.setInterval(() => atBorder(lastX) && apply(lastX), 120);
        const up = () => {
          over.style.cursor = "grab";
          window.clearInterval(timer);
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          cb.current.onDragEnd?.();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return;
      }
      if (!which && !cb.current.onScrub) return;
      ev.preventDefault();
      const act = (x: number) => {
        const ms = msAt(x);
        if (which === "s" || which === "e") {
          cb.current.onEdge?.(which, ms);
          // 拖到视图边上：视图往外扩，边界跟着走（不然长片段到窗口头就拖不动了）
          const r = cur();
          const v = ((which === "s" ? r.s : r.e) - info.startMs) / 1000;
          reveal(v, v);
        } else cb.current.onScrub?.(ms);
        u.redraw(false);
      };
      let lastX = ev.clientX;
      act(lastX);
      const move = (e2: MouseEvent) => {
        lastX = e2.clientX;
        act(lastX);
      };
      // 鼠标按着停在图的左右边上（或者拖出图外）：每 120ms 往外扩一点，一直按着就一直延伸
      const timer = which ? window.setInterval(() => atBorder(lastX) && act(lastX), 120) : 0;
      const up = () => {
        window.clearInterval(timer);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (which) cb.current.onDragEnd?.();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };
    over.addEventListener("mousemove", onHover);
    over.addEventListener("mousedown", onDown);
    if (live) over.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      over.removeEventListener("mousemove", onHover);
      over.removeEventListener("mousedown", onDown);
      over.removeEventListener("wheel", onWheel);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // 宽高单独用 setSize 改，拖大小时不用每一下都重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, chans, smooth, yRange, xRange, scrolling, winSec, axisColor, widen]);

  useEffect(() => {
    plotRef.current?.setSize({ width, height });
  }, [width, height]);

  useEffect(() => {
    plotRef.current?.redraw(false);
  }, [version, editable, neighbors]);

  useEffect(() => {
    const u = plotRef.current, r = initXRef.current;
    if (!u || !r || !resetKey) return;
    zoomedRef.current = false;
    u.setScale("x", { min: r[0], max: r[1] });
  }, [resetKey]);

  // 播放头：跟着视频走。平时只挪一个 div，不重画图（视频每帧都在报时间）；
  // 跟随模式下窗口跟着滚，限到每 100ms 最多挪一次
  useEffect(() => {
    if (!live || !bus) return;
    let lastShift = 0;
    return bus.onTime((sec) => {
      const u = plotRef.current;
      const h = headRef.current;
      if (!u || !h) return;
      const x = (sec * 1000 - snap.info.startMs) / 1000;
      if (scrolling && !zoomedRef.current) {
        const now = performance.now();
        const lo = u.scales.x.min ?? 0, hi = u.scales.x.max ?? winSec;
        // 播放头快走出窗口右侧 / 循环跳回起点时，把窗口挪过去：播放头放在 30% 的位置
        if ((x > lo + (hi - lo) * 0.8 || x < lo) && now - lastShift > 100) {
          lastShift = now;
          const min = Math.max(-snap.padMs / 1000, x - winSec * 0.3);
          u.setScale("x", { min, max: min + winSec });
        }
      }
      const px = u.valToPos(x, "x", false);
      const { left, width: w } = u.bbox;
      const dpr = window.devicePixelRatio || 1;
      const inside = px >= 0 && px <= w / dpr;
      h.style.display = inside ? "block" : "none";
      h.style.left = `${left / dpr + px}px`;
      h.style.top = `${u.bbox.top / dpr}px`;
      h.style.height = `${u.bbox.height / dpr}px`;
    });
  }, [live, bus, snap, scrolling, winSec]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={el} />
      {live && (
        // 播放线：品红色、带白描边和光晕，上下各一个三角——原来那条 2px 的橙线跟「活动」那条橙色色带、
        // 红色 X 轴混在一起，很难一眼找到
        <div
          ref={headRef}
          style={{
            position: "absolute", width: 3, marginLeft: -1, background: "#eb2f96", pointerEvents: "none", display: "none", zIndex: 3,
            boxShadow: "0 0 0 1px rgba(255,255,255,.85), 0 0 8px 2px rgba(235,47,150,.75)",
          }}
        >
          <div style={{ position: "absolute", top: -2, left: -5, width: 0, height: 0,
            borderLeft: "6.5px solid transparent", borderRight: "6.5px solid transparent", borderTop: "9px solid #eb2f96" }} />
          <div style={{ position: "absolute", bottom: -2, left: -5, width: 0, height: 0,
            borderLeft: "6.5px solid transparent", borderRight: "6.5px solid transparent", borderBottom: "9px solid #eb2f96" }} />
        </div>
      )}
    </div>
  );
}

/** 00:56:24.724 */
const fmtMs = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), sec = Math.floor((t % 60000) / 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(sec)}.${p(t % 1000, 3)}`;
};

export default function LoopWaveform({
  sampleId, bus, info, onAdjust, readOnlyHint, canAdjust, forceOpen, extra, keepOpen, onKeepOpenChange,
}: {
  sampleId: number;
  bus: TimeBus;
  /** 当前在循环的那段；null = 没在循环（钉住的还在就照样显示） */
  info: LoopInfo | null;
  onStop?: () => void;
  /** 保存新的起止（已标注片段 / 疑似片段）。不给 = 只读，不能拖起止 */
  onAdjust?: (target: AdjustTarget, startMs: number, endMs: number) => Promise<void>;
  /** 只读时为什么不能改起止（给了就在浮窗里写出来） */
  readOnlyHint?: string;
  /** 只有这些能改（片段审核：只读的任务里只放开正在审的那一条） */
  canAdjust?: (t: AdjustTarget) => boolean;
  /** 不管「循环时自动弹出」开没开都弹（片段审核：按钮都在浮窗里） */
  forceOpen?: boolean;
  /** 浮窗最底下再放一栏（片段审核的通过 / 退回 / 下一条） */
  extra?: React.ReactNode;
  /** 停止循环后浮窗还留着（由外面记住最后一段接着传 info）。给了 onKeepOpenChange 才显示这个选项 */
  keepOpen?: boolean;
  onKeepOpenChange?: (v: boolean) => void;
}) {
  const { token } = theme.useToken();
  const [cfg, setCfgState] = useState<Cfg>(loadCfg);
  // 图按哪个宽度排视图：拖大小时不跟着每一下变（变一下就要重建图），松手才更新
  const [viewW, setViewW] = useState(() => cfg.w);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const widen = Math.max(1, viewW / 460);
  const winEff = Math.round(cfg.winSec * widen);
  const setCfg = (patch: Partial<Cfg>) =>
    setCfgState((c) => {
      const next = { ...c, ...patch };
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(next));
      } catch {
        // 存不下就只在这次生效
      }
      return next;
    });
  const [cur, setCur] = useState<Snap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<Snap[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  // 这一次循环里手动关掉了 / 没开自动弹、点了小按钮才打开
  const [closed, setClosed] = useState(false);
  const [opened, setOpened] = useState(false);
  const idRef = useRef(0);
  // 调起止：rangeRef 是图上画的那对（拖的时候每一下都改它，不走 React），
  // edit 是给界面显示用的同一对；null = 没动过
  const rangeRef = useRef({ s: 0, e: 0 });
  const [edit, setEdit] = useState<{ s: number; e: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const lastSec = useRef(0);
  const lastSeek = useRef(0);
  const target: AdjustTarget | null =
    info?.itemId != null ? { kind: "item", id: info.itemId } : info?.candId != null ? { kind: "cand", id: info.candId } : null;
  const editable = !!(target && onAdjust && (!canAdjust || canAdjust(target)));
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => bus.onTime((sec) => { lastSec.current = sec; }), [bus]);

  const key = info ? `${info.startMs}-${info.endMs}` : null;
  useEffect(() => {
    setClosed(false);
    setOpened(false);
    setEdit(null);
    if (info) rangeRef.current = { s: info.startMs, e: info.endMs };
    setVersion((v) => v + 1);
    if (!info) {
      setCur(null);
      return;
    }
    let gone = false;
    const padMs = padOf(info.endMs - info.startMs);
    const ctxMs = ctxOf(info.endMs - info.startMs);
    setLoading(true);
    setError(null);
    fetchSeries(sampleId, info.startMs - ctxMs, info.endMs + ctxMs)
      .then((series) => {
        if (!gone) setCur({ id: ++idRef.current, info, padMs, ctxMs, series });
      })
      .catch((e) => !gone && setError(String(e?.message ?? e)))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
      // 换了一段 / 关掉：之前为调起止暂停的循环恢复
      bus.holdLoop(false);
    };
    // info 每次渲染都是新对象，按起止判断要不要重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId, key, info?.title]);

  // 纵轴共用一个范围：当前这段和钉住的几段放在一起比，量级不同的话形状会骗人
  const chans = cfg.gyro ? GYRO : ACC;
  const yRange = useMemo<[number, number] | null>(() => {
    // 只有一张图：各自按看得见的那一截自适应（MiniPlot 里），不给共用范围
    if (!pins.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const s of [cur, ...pins]) {
      if (!s) continue;
      for (const c of chans) for (const v of s.series[c.key] ?? []) {
        if (v == null || Number.isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * 0.05 || 0.1;
    return [lo - pad, hi + pad];
  }, [cur, pins, chans]);

  // 横轴也共用：一秒在几张图上一样宽，抖得快慢（频率）才能直接比。
  // 跟随模式下钉住的那几张也只看前 winSec 秒，跟主图同一个比例尺
  const xRange = useMemo<[number, number] | null>(() => {
    const winSec = winEff;
    const all = [cur, ...pins].filter(Boolean) as Snap[];
    if (all.length < 2) return null;
    const pad = Math.max(...all.map((s) => s.padMs)) / 1000;
    const dur = Math.max(...all.map((s) => (s.info.endMs - s.info.startMs) / 1000));
    if (cfg.follow && dur > winSec * 1.2) return [-pad, -pad + winSec];
    return [-pad, dur + pad];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, pins, cfg.follow, winEff]);

  const show = (info && (cfg.auto || forceOpen ? !closed : opened)) || (!info && pins.length > 0);

  // ── 调起止 ──
  // 拖的时候视频跟到那一帧（限 120ms 一次：每次 seek 都要等解码，拖得太勤会卡）。
  // 暂停、并暂时不循环——不然一拖到终点外面就被拽回起点
  const seekTo = (ms: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastSeek.current < 120) return;
    lastSeek.current = now;
    bus.seek(ms / 1000);
  };
  // 能调到的范围 = 拉回来的那截数据（前后各 10 秒 ~ 1 分钟）
  const lo = info && cur ? Math.max(0, info.startMs - cur.ctxMs) : 0;
  const hi = info && cur ? info.endMs + cur.ctxMs : 0;
  const setRange = (s0: number, e0: number) => {
    // 只能在拉回来的这截数据里调；起止至少隔 0.2 秒
    const s1 = Math.round(Math.min(Math.max(lo, s0), hi - 200) / 10) * 10;
    const e1 = Math.round(Math.max(Math.min(hi, e0), s1 + 200) / 10) * 10;
    rangeRef.current = { s: s1, e: e1 };
    setEdit(info && s1 === info.startMs && e1 === info.endMs ? null : { s: s1, e: e1 });
    setVersion((v) => v + 1);
    return { s: s1, e: e1 };
  };
  const onEdge = (which: "s" | "e", ms: number) => {
    bus.play("pause");
    bus.holdLoop(true);
    const r = rangeRef.current;
    const n = which === "s" ? setRange(ms, r.e) : setRange(r.s, ms);
    seekTo(which === "s" ? n.s : n.e);
  };
  const onMove = (s0: number, e0: number) => {
    bus.play("pause");
    bus.holdLoop(true);
    // 整段平移：长度不变，挪到头就停在头上
    const len = e0 - s0;
    const s1 = Math.min(Math.max(lo, s0), hi - len);
    const n = setRange(s1, s1 + len);
    seekTo(n.s);
  };
  // 起止拖到已拉数据的头上（前后 3 秒内）松手：再往外多拉 1 分钟，接着就能继续拖。
  // 长的抓挠一两分钟，开始拉的那截不一定够
  const extendData = () => {
    if (!info || !cur) return;
    const r = rangeRef.current;
    const needLo = lo > 0 && r.s < lo + 3000;
    const needHi = r.e > hi - 3000;
    if (!needLo && !needHi) return;
    const ctxMs = Math.min(cur.ctxMs + 60000, 600000);
    if (ctxMs === cur.ctxMs) return;
    const snapInfo = info;
    fetchSeries(sampleId, snapInfo.startMs - ctxMs, snapInfo.endMs + ctxMs)
      .then((series) => setCur((c) => (c && c.info === snapInfo ? { ...c, ctxMs, series } : c)))
      .catch(() => {});
  };
  const onScrub = (ms: number) => {
    bus.play("pause");
    bus.holdLoop(true);
    seekTo(Math.min(Math.max(lo, ms), hi));
  };
  const play = () => {
    const r = rangeRef.current;
    if (edit) {
      // 没保存的新起止：按它试播一圈，列表里的循环不动
      bus.previewLoop({ start: r.s / 1000, end: r.e / 1000 });
      seekTo(r.s, true);
    } else {
      bus.holdLoop(false);
      if (lastSec.current * 1000 < r.s || lastSec.current * 1000 >= r.e) seekTo(r.s, true);
    }
    bus.play("play");
  };
  const revert = () => {
    if (!info) return;
    bus.previewLoop(null);
    setRange(info.startMs, info.endMs);
  };
  const save = async () => {
    if (!target || !onAdjust || !edit) return;
    setSaving(true);
    try {
      bus.previewLoop(null);
      await onAdjust(target, edit.s, edit.e);
    } finally {
      setSaving(false);
    }
  };

  // 没开自动弹：循环时只在角上留一个小按钮
  if (info && !show) {
    return (
      <Tooltip title="打开这一段的波形" placement="left">
        <Button
          shape="round"
          icon={<LineChartOutlined />}
          style={{ position: "fixed", left: cfg.left + cfg.w - 70, top: cfg.top, zIndex: 1100 }}
          onClick={() => { setOpened(true); setClosed(false); }}
        >
          波形
        </Button>
      </Tooltip>
    );
  }
  if (!show) return null;

  // kind：move = 拖标题栏挪位置；其余是从哪条边 / 哪个角改大小（n 上 s 下 w 左 e 右，可组合）
  const dragFrom = (e: React.MouseEvent, kind: "move" | string) => {
    if (cfg.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, c0 = cfg;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (kind === "move") {
        setCfgState((c) => ({
          ...c,
          left: Math.min(Math.max(0, c0.left + dx), window.innerWidth - 80),
          top: Math.min(Math.max(0, c0.top + dy), window.innerHeight - 40),
        }));
        return;
      }
      setCfgState((c) => {
        let { left, top, w, h } = c0;
        if (kind.includes("e")) w = Math.min(Math.max(300, c0.w + dx), window.innerWidth - c0.left - 48);
        if (kind.includes("w")) {
          const nl = Math.min(Math.max(0, c0.left + dx), c0.left + c0.w - 300);
          w = c0.w + (c0.left - nl);
          left = nl;
        }
        if (kind.includes("s")) h = Math.min(Math.max(90, c0.h + dy), window.innerHeight - c0.top - 120);
        if (kind.includes("n")) {
          const nt = Math.min(Math.max(0, c0.top + dy), c0.top + c0.h - 90);
          h = c0.h + (c0.top - nt);
          top = nt;
        }
        return { ...c, left, top, w, h };
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // 松手才落盘，拖的过程中不用每一下都写 localStorage
      setCfg({});
      // 宽度定下来再按新宽度重排视图（拖的过程中每一下都重建图会卡）
      if (kind !== "move") setViewW(cfgRef.current.w);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const pinH = Math.max(70, Math.round(cfg.h * 0.55));
  const dur = info ? (info.endMs - info.startMs) / 1000 : 0;
  const plotProps = { chans, smooth: cfg.smooth, yRange, xRange, width: cfg.w, winSec: winEff, widen, axisColor: token.colorTextSecondary };

  return (
    // 浮窗本身是 zIndex 1100，antd 的下拉 / 提示默认 1050——浮窗里的类别下拉会被浮窗自己挡住。
    // 把浮窗里弹出层的基准抬到浮窗之上
    <ConfigProvider theme={{ token: { zIndexPopupBase: 1150 } }}>
    <div
      style={{
        position: "fixed", left: cfg.left, top: cfg.top, zIndex: 1100, width: cfg.w + 20,
        background: token.colorBgElevated, color: token.colorText,
        border: `1px solid ${token.colorBorder}`, borderRadius: 8, boxShadow: token.boxShadowSecondary,
        padding: "6px 10px 10px",
        // 内容多了（钉住几段、调起止那一栏）别伸出屏幕底下去，超出就在浮窗里滚
        maxHeight: `calc(100vh - ${cfg.top}px - 8px)`, overflowY: "auto",
      }}
    >
      <div
        onMouseDown={(e) => dragFrom(e, "move")}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: cfg.locked ? "default" : "move", userSelect: "none", marginBottom: 4 }}
      >
        <Typography.Text strong style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
          {info ? <>波形 · {info.title} <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            （{dur.toFixed(1)}s，前后各多看 {((cur?.padMs ?? padOf(dur * 1000)) / 1000).toFixed(1)}s）
          </Typography.Text></> : "钉住的波形"}
        </Typography.Text>
        <Space size={2} onMouseDown={(e) => e.stopPropagation()}>
          {info && (
            <>
              <Tooltip title={edit ? "按改过的起止试播（还没保存）" : "播放（接着循环这一段）"}>
                <Button size="small" type="text" icon={<CaretRightOutlined />} onClick={play} />
              </Tooltip>
              <Tooltip title="暂停。也可以直接在图上点 / 拖，视频跟着跳到那一帧">
                <Button size="small" type="text" icon={<PauseOutlined />} onClick={() => bus.play("pause")} />
              </Tooltip>
              <Tooltip title="视图回到这一段（取消 Shift+滚轮 的缩放 / Shift+拖 的平移）">
                <Button size="small" type="text" icon={<AimOutlined />} onClick={() => setResetKey((k) => k + 1)} />
              </Tooltip>
            </>
          )}
          <Tooltip title={cfg.gyro ? "现在看陀螺仪，点一下换回加速度" : "现在看加速度，点一下换成陀螺仪（只有 6 轴数据才有）"}>
            <Tag style={{ cursor: "pointer", margin: 0 }} onClick={() => setCfg({ gyro: !cfg.gyro })}>{cfg.gyro ? "陀螺仪" : "加速度"}</Tag>
          </Tooltip>
          {cur && (
            <Tooltip title="把这一段留在下面当参照，再去循环别的段并排比（最多 3 段）">
              <Button size="small" type="text" icon={<PushpinOutlined />}
                onClick={() => setPins((p) => [{ ...cur, id: ++idRef.current }, ...p].slice(0, 3))} />
            </Tooltip>
          )}
          <Tooltip title={cfg.locked ? "已锁住位置和大小，点一下解锁" : "锁住位置和大小，免得误拖"}>
            <Button size="small" type="text" icon={cfg.locked ? <LockOutlined /> : <UnlockOutlined />}
              style={cfg.locked ? { color: token.colorPrimary } : undefined}
              onClick={() => setCfg({ locked: !cfg.locked })} />
          </Tooltip>
          <Button size="small" type="text" icon={collapsed ? <PlusOutlined /> : <MinusOutlined />} onClick={() => setCollapsed((c) => !c)} />
          <Tooltip title="关掉这个浮窗（循环照旧）。不想每次都弹，取消下面的「循环时自动弹出」">
            <Button size="small" type="text" icon={<CloseOutlined />}
              onClick={() => { setPins([]); setClosed(true); setOpened(false); }} />
          </Tooltip>
        </Space>
      </div>
      {!collapsed && (
        <>
          {info && (
            <Spin spinning={loading} size="small">
              {error ? (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>波形读不到：{error}</Typography.Text>
              ) : cur ? (
                <MiniPlot snap={cur} {...plotProps} height={cfg.h} bus={bus} live follow={cfg.follow}
                  rangeRef={rangeRef} editable={editable} onEdge={onEdge} onScrub={onScrub} onMove={onMove} onDragEnd={extendData} version={version}
                  resetKey={resetKey} neighbors={info.neighbors} />
              ) : (
                <div style={{ height: cfg.h }} />
              )}
            </Spin>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, marginTop: 2 }}>
            {chans.map((c) => <span key={c.key} style={{ color: c.color }}>━ {c.label}</span>)}
            <Tooltip title="底色 = 片段，品红竖线 = 播放位置，顶上细色条 = 前后挨着的别的片段">
              <QuestionCircleOutlined style={{ color: token.colorTextTertiary, cursor: "help" }} />
            </Tooltip>
            <span style={{ flex: 1 }} />
            <Tooltip title="平滑：曲线连线 + 轻微去毛刺（约 0.1 秒）。想看原始采样点就关掉">
              <Checkbox checked={cfg.smooth} onChange={(e) => setCfg({ smooth: e.target.checked })} style={{ fontSize: 11 }}>平滑</Checkbox>
            </Tooltip>
            <Tooltip title={`长片段只看播放位置附近 ${winEff} 秒，跟着播放滚动（浮窗拉宽了就看得更长）；关掉 = 整段压在一张图里`}>
              <Checkbox checked={cfg.follow} onChange={(e) => setCfg({ follow: e.target.checked })} style={{ fontSize: 11 }}>
                跟随（{winEff}s）
              </Checkbox>
            </Tooltip>
            <Tooltip title="关掉后循环时不自动弹出，只在这个位置留一个「波形」小按钮，点了才打开">
              <Checkbox checked={cfg.auto} onChange={(e) => setCfg({ auto: e.target.checked })} style={{ fontSize: 11 }}>循环时自动弹出</Checkbox>
            </Tooltip>
            {onKeepOpenChange && (
              <Tooltip title="停止循环播放后浮窗不消失，还停在这一段：拆段、调起止时可以先停掉循环，自己拖视频看，浮窗照样能改。点右上角 X 才关">
                <Checkbox checked={!!keepOpen} onChange={(e) => onKeepOpenChange(e.target.checked)} style={{ fontSize: 11 }}>
                  停止循环后保留
                </Checkbox>
              </Tooltip>
            )}
          </div>
          {info && editable && (
            <div style={{ marginTop: 4, padding: "4px 6px", borderRadius: 4, background: edit ? token.colorWarningBg : token.colorFillQuaternary, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span>起 <b>{fmtMs(edit?.s ?? info.startMs)}</b></span>
                <span>止 <b>{fmtMs(edit?.e ?? info.endMs)}</b></span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {(((edit?.e ?? info.endMs) - (edit?.s ?? info.startMs)) / 1000).toFixed(2)}s
                  {edit && `（原 ${fmtMs(info.startMs)} ~ ${fmtMs(info.endMs)}）`}
                </Typography.Text>
                {/* 操作说明收进问号：常驻一大段字占地方，只有头几次用得上 */}
                <Tooltip
                  overlayStyle={{ maxWidth: 360 }}
                  title={
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      · 拖底色两边的竖线改起止；按住顶上那条拖动整段，视频跟着停在那一帧<br />
                      · 点 / 拖图上别处，视频跳过去<br />
                      · <b>Shift+滚轮</b>缩放、<b>Shift+拖</b>左右平移，看前后的全貌<br />
                      · 拖到窗口边上按住不放，视图会继续往外延伸<br />
                      · 改好点「保存起止」，会记下这次调整
                    </div>
                  }
                >
                  <QuestionCircleOutlined style={{ color: token.colorTextTertiary, cursor: "help" }} />
                </Tooltip>
                <span style={{ flex: 1 }} />
                <Tooltip title="先在图上点 / 拖到动作真正开始的那一帧，再点这个">
                  <Button size="small" onClick={() => { const n = setRange(lastSec.current * 1000, rangeRef.current.e); seekTo(n.s, true); }}>起点 = 播放线</Button>
                </Tooltip>
                <Tooltip title="拖到动作真正结束的那一帧，再点这个">
                  <Button size="small" onClick={() => { const n = setRange(rangeRef.current.s, lastSec.current * 1000); seekTo(n.e, true); }}>终点 = 播放线</Button>
                </Tooltip>
                {edit && <Button size="small" onClick={revert}>还原</Button>}
                <Button size="small" type="primary" disabled={!edit} loading={saving} onClick={save}>保存起止</Button>
              </div>
            </div>
          )}

          {info && extra && <div style={{ marginTop: 6 }}>{extra}</div>}
          {/* 只读：别让人拖半天没反应，直接说为什么改不了、要先做什么 */}
          {info && !editable && target && readOnlyHint && (
            <div style={{ marginTop: 4, padding: "4px 6px", borderRadius: 4, background: token.colorFillQuaternary, fontSize: 12 }}>
              <LockOutlined /> {readOnlyHint}
            </div>
          )}
          {pins.map((p) => (
            <div key={p.id} style={{ marginTop: 6, borderTop: `1px dashed ${token.colorBorderSecondary}`, paddingTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <Typography.Text style={{ fontSize: 11, flex: 1 }} ellipsis>
                  <PushpinOutlined /> {p.info.title}（{((p.info.endMs - p.info.startMs) / 1000).toFixed(1)}s）
                </Typography.Text>
                <Tooltip title="回去循环这一段">
                  <Button size="small" type="link" style={{ fontSize: 11, padding: 0 }}
                    onClick={() => bus.setLoop({ start: p.info.startMs / 1000, end: p.info.endMs / 1000 })}>跳回</Button>
                </Tooltip>
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setPins((x) => x.filter((y) => y.id !== p.id))} />
              </div>
              <MiniPlot snap={p} {...plotProps} height={pinH} />
            </div>
          ))}
        </>
      )}
      {/* 四条边、四个角都能拖着改大小：往左右拉宽看得更长，往上下拉高看得更细 */}
      {([
        ["n", { top: 0, left: 10, right: 10, height: 5, cursor: "ns-resize" }],
        ["s", { bottom: 0, left: 10, right: 14, height: 5, cursor: "ns-resize" }],
        ["w", { left: 0, top: 10, bottom: 10, width: 5, cursor: "ew-resize" }],
        ["e", { right: 0, top: 10, bottom: 14, width: 5, cursor: "ew-resize" }],
        ["nw", { left: 0, top: 0, width: 10, height: 10, cursor: "nwse-resize" }],
        ["ne", { right: 0, top: 0, width: 10, height: 10, cursor: "nesw-resize" }],
        ["sw", { left: 0, bottom: 0, width: 10, height: 10, cursor: "nesw-resize" }],
      ] as [string, React.CSSProperties][]).map(([k, st]) => (
        <div key={k} onMouseDown={(e) => dragFrom(e, k)} style={{ position: "absolute", zIndex: 2, ...st, ...(cfg.locked ? { cursor: "default" } : {}) }} />
      ))}
      <div
        onMouseDown={(e) => dragFrom(e, "se")}
        title="拖着改大小"
        style={{
          position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: cfg.locked ? "default" : "nwse-resize", display: cfg.locked ? "none" : undefined,
          background: `linear-gradient(135deg, transparent 50%, ${token.colorTextQuaternary} 50%)`,
          borderBottomRightRadius: 8,
        }}
      />
    </div>
    </ConfigProvider>
  );
}
