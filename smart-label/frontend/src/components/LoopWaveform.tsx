import { Button, Checkbox, ConfigProvider, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { AimOutlined, CaretRightOutlined, LockOutlined, CloseOutlined, LineChartOutlined, MinusOutlined, PauseOutlined, PlusOutlined, PushpinOutlined } from "@ant-design/icons";
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
/** 前后各拉多少数据：至少 10 秒、最多 1 分钟，缩小看全貌时够用 */
const ctxOf = (durMs: number) => Math.min(60000, Math.max(10000, durMs));

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

function MiniPlot({
  snap, chans, smooth, yRange, xRange, width, height, bus, live, follow, winSec, axisColor,
  rangeRef, editable, onEdge, onScrub, onMove, version, resetKey, neighbors,
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
  const cb = useRef({ onEdge, onScrub, onMove, editable, neighbors });
  cb.current = { onEdge, onScrub, onMove, editable, neighbors };
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
    const initX: [number, number] = scrolling ? [-pad, -pad + winSec] : xRange ?? [-pad, dur + pad];
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
        y: yRange ? { range: () => yRange } : {},
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
        const move = (e2: MouseEvent) => {
          const d = msAt(e2.clientX) - a0;
          cb.current.onMove?.(r0.s + d, r0.e + d);
          u.redraw(false);
        };
        const up = () => {
          over.style.cursor = "grab";
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return;
      }
      if (!which && !cb.current.onScrub) return;
      ev.preventDefault();
      const act = (x: number) => {
        const ms = msAt(x);
        if (which === "s" || which === "e") cb.current.onEdge?.(which, ms);
        else cb.current.onScrub?.(ms);
        u.redraw(false);
      };
      act(ev.clientX);
      const move = (e2: MouseEvent) => act(e2.clientX);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
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
  }, [snap, chans, smooth, yRange, xRange, scrolling, winSec, axisColor]);

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
        <div
          ref={headRef}
          style={{ position: "absolute", width: 2, background: "#fa8c16", pointerEvents: "none", display: "none" }}
        />
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
  sampleId, bus, info, onAdjust, readOnlyHint, canAdjust, forceOpen, extra,
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
}) {
  const { token } = theme.useToken();
  const [cfg, setCfgState] = useState<Cfg>(loadCfg);
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
    const all = [cur, ...pins].filter(Boolean) as Snap[];
    if (all.length < 2) return null;
    const pad = Math.max(...all.map((s) => s.padMs)) / 1000;
    const dur = Math.max(...all.map((s) => (s.info.endMs - s.info.startMs) / 1000));
    if (cfg.follow && dur > cfg.winSec * 1.2) return [-pad, -pad + cfg.winSec];
    return [-pad, dur + pad];
  }, [cur, pins, cfg.follow, cfg.winSec]);

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

  const dragFrom = (e: React.MouseEvent, kind: "move" | "resize") => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, c0 = cfg;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (kind === "move") {
        setCfgState((c) => ({
          ...c,
          left: Math.min(Math.max(0, c0.left + dx), window.innerWidth - 80),
          top: Math.min(Math.max(0, c0.top + dy), window.innerHeight - 40),
        }));
      } else {
        setCfgState((c) => ({
          ...c,
          w: Math.min(Math.max(300, c0.w + dx), window.innerWidth - c0.left - 24),
          h: Math.min(Math.max(90, c0.h + dy), window.innerHeight - c0.top - 120),
        }));
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // 松手才落盘，拖的过程中不用每一下都写 localStorage
      setCfg({});
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const pinH = Math.max(70, Math.round(cfg.h * 0.55));
  const dur = info ? (info.endMs - info.startMs) / 1000 : 0;
  const plotProps = { chans, smooth: cfg.smooth, yRange, xRange, width: cfg.w, winSec: cfg.winSec, axisColor: token.colorTextSecondary };

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
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "move", userSelect: "none", marginBottom: 4 }}
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
                  rangeRef={rangeRef} editable={editable} onEdge={onEdge} onScrub={onScrub} onMove={onMove} version={version}
                  resetKey={resetKey} neighbors={info.neighbors} />
              ) : (
                <div style={{ height: cfg.h }} />
              )}
            </Spin>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, marginTop: 2 }}>
            {chans.map((c) => <span key={c.key} style={{ color: c.color }}>━ {c.label}</span>)}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>底色 = 片段，橙线 = 播放位置</Typography.Text>
            <span style={{ flex: 1 }} />
            <Tooltip title="平滑：曲线连线 + 轻微去毛刺（约 0.1 秒）。想看原始采样点就关掉">
              <Checkbox checked={cfg.smooth} onChange={(e) => setCfg({ smooth: e.target.checked })} style={{ fontSize: 11 }}>平滑</Checkbox>
            </Tooltip>
            <Tooltip title={`长片段只看播放位置附近 ${cfg.winSec} 秒，跟着播放滚动；关掉 = 整段压在一张图里`}>
              <Checkbox checked={cfg.follow} onChange={(e) => setCfg({ follow: e.target.checked })} style={{ fontSize: 11 }}>
                跟随（{cfg.winSec}s）
              </Checkbox>
            </Tooltip>
            <Tooltip title="关掉后循环时不自动弹出，只在这个位置留一个「波形」小按钮，点了才打开">
              <Checkbox checked={cfg.auto} onChange={(e) => setCfg({ auto: e.target.checked })} style={{ fontSize: 11 }}>循环时自动弹出</Checkbox>
            </Tooltip>
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
              {!edit && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  拖底色两边的竖线改起止、按住顶上那条拖动整段，视频跟着停在那一帧；点 / 拖图上别处把视频跳过去；
                  <b>Shift+滚轮</b>缩放、<b>Shift+拖</b>左右平移，看前后的全貌。改好点「保存起止」，会记下这次调整
                </Typography.Text>
              )}
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
      {/* 右下角拖着改大小 */}
      <div
        onMouseDown={(e) => dragFrom(e, "resize")}
        title="拖着改大小"
        style={{
          position: "absolute", right: 0, bottom: 0, width: 14, height: 14, cursor: "nwse-resize",
          background: `linear-gradient(135deg, transparent 50%, ${token.colorTextQuaternary} 50%)`,
          borderBottomRightRadius: 8,
        }}
      />
    </div>
    </ConfigProvider>
  );
}
