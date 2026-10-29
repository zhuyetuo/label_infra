import { Button, Checkbox, Space, Spin, Tag, Tooltip, Typography, theme } from "antd";
import { CloseOutlined, LineChartOutlined, MinusOutlined, PlusOutlined, PushpinOutlined } from "@ant-design/icons";
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
}

interface Snap {
  id: number;
  info: LoopInfo;
  padMs: number;
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
}) {
  const el = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const dur = (snap.info.endMs - snap.info.startMs) / 1000;
  // 片段比窗口短就没必要跟着滚，整段都放得下
  const scrolling = !!follow && dur > winSec * 1.2;

  useEffect(() => {
    if (!el.current) return;
    const { series, info } = snap;
    // 横轴：相对片段起点的秒。钉住的几段起点都对齐在 0，形状才能直接比
    const xs = series.t.map((ms) => (ms - info.startMs) / 1000);
    const band = info.color ?? "#4096ff";
    const pad = snap.padMs / 1000;
    const initX: [number, number] | null = scrolling ? [-pad, -pad + winSec] : xRange;
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      cursor: { show: false },
      scales: {
        // 不能给 x 一个固定返回 initX 的 range 函数：uPlot 的 setScale 也会过一遍 range，
        // 那样跟随模式怎么 setScale 都被拉回原位。这里原样放行，初始窗口在建好之后 setScale
        x: initX ? { time: false, auto: false, range: (_u, mn, mx) => [mn, mx] } : { time: false },
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
            // 片段起止可能在可见窗口外面（跟随模式），夹到绘图区里，别涂到坐标轴上
            const x0 = Math.max(left, u.valToPos(0, "x", true));
            const x1 = Math.min(left + bw, u.valToPos(dur, "x", true));
            if (x1 <= x0) return;
            u.ctx.save();
            u.ctx.fillStyle = band;
            u.ctx.globalAlpha = 0.14;
            u.ctx.fillRect(x0, top, x1 - x0, h);
            u.ctx.restore();
          },
        ],
      },
    };
    const data: uPlot.AlignedData = [xs, ...chans.map((c) => (smooth ? movingAvg(series[c.key] ?? []) : series[c.key] ?? []))];
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, el.current);
    if (initX) plotRef.current.setScale("x", { min: initX[0], max: initX[1] });
    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // 宽高单独用 setSize 改，拖大小时不用每一下都重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, chans, smooth, yRange, xRange, scrolling, winSec, axisColor]);

  useEffect(() => {
    plotRef.current?.setSize({ width, height });
  }, [width, height]);

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
      if (scrolling) {
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

export default function LoopWaveform({
  sampleId, bus, info, onStop,
}: {
  sampleId: number;
  bus: TimeBus;
  /** 当前在循环的那段；null = 没在循环（钉住的还在就照样显示） */
  info: LoopInfo | null;
  onStop: () => void;
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

  const key = info ? `${info.startMs}-${info.endMs}` : null;
  useEffect(() => {
    setClosed(false);
    setOpened(false);
    if (!info) {
      setCur(null);
      return;
    }
    let gone = false;
    const padMs = padOf(info.endMs - info.startMs);
    setLoading(true);
    setError(null);
    fetchSeries(sampleId, info.startMs - padMs, info.endMs + padMs)
      .then((series) => {
        if (!gone) setCur({ id: ++idRef.current, info, padMs, series });
      })
      .catch((e) => !gone && setError(String(e?.message ?? e)))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
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

  const show = (info && (cfg.auto ? !closed : opened)) || (!info && pins.length > 0);

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
    <div
      style={{
        position: "fixed", left: cfg.left, top: cfg.top, zIndex: 1100, width: cfg.w + 20,
        background: token.colorBgElevated, color: token.colorText,
        border: `1px solid ${token.colorBorder}`, borderRadius: 8, boxShadow: token.boxShadowSecondary,
        padding: "6px 10px 10px",
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
                <MiniPlot snap={cur} {...plotProps} height={cfg.h} bus={bus} live follow={cfg.follow} />
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
  );
}
