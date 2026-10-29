import { Button, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { CloseOutlined, MinusOutlined, PlusOutlined, PushpinOutlined } from "@ant-design/icons";
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
 * 拿一段确定是舔的当参照，看这段疑似的长得像不像。横轴都从片段起点算，纵轴共用一个范围，
 * 形状才能直接比。
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
  { key: "acc_y", label: "Y", color: "#2ecc71" },
  { key: "acc_z", label: "Z", color: "#3498db" },
];
const GYRO: { key: ChKey; label: string; color: string }[] = [
  { key: "gyro_x", label: "GX", color: "#e67e22" },
  { key: "gyro_y", label: "GY", color: "#1abc9c" },
  { key: "gyro_z", label: "GZ", color: "#9b59b6" },
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

/** 前后各留多少：短段多留一点，不然看不出起止前后是什么样 */
const padOf = (durMs: number) => Math.min(3000, Math.max(800, durMs * 0.3));

const fetchSeries = (sampleId: number, startMs: number, endMs: number) =>
  request.get<never, Series>(`/imu/${sampleId}/series`, {
    params: { start_ms: Math.max(0, Math.round(startMs)), end_ms: Math.round(endMs), max_points: 1200 },
  });

function MiniPlot({
  snap, gyro, yRange, xRange, width, height, bus, live,
}: {
  snap: Snap;
  gyro: boolean;
  yRange: [number, number] | null;
  xRange: [number, number] | null;
  width: number;
  height: number;
  bus?: TimeBus;
  live?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const chans = gyro ? GYRO : ACC;

  useEffect(() => {
    if (!el.current) return;
    const { series, info } = snap;
    // 横轴：相对片段起点的秒。钉住的几段起点都对齐在 0，形状才能直接比
    const xs = series.t.map((ms) => (ms - info.startMs) / 1000);
    const dur = (info.endMs - info.startMs) / 1000;
    const band = info.color ?? "#4096ff";
    const opts: uPlot.Options = {
      width,
      height,
      legend: { show: false },
      cursor: { show: false },
      scales: {
        x: xRange ? { time: false, range: () => xRange } : { time: false },
        y: yRange ? { range: () => yRange } : {},
      },
      axes: [
        { stroke: "#888", grid: { stroke: "rgba(128,128,128,.15)" }, size: 22, font: "10px sans-serif",
          values: (_u, v) => v.map((x) => `${+x.toFixed(1)}s`) },
        { stroke: "#888", grid: { stroke: "rgba(128,128,128,.15)" }, size: 34, font: "10px sans-serif" },
      ],
      series: [{}, ...chans.map((c) => ({ stroke: c.color, width: 1 }))],
      hooks: {
        // 片段本身那几秒铺一层底色，前后留的那截不铺：一眼看出边界在哪
        drawClear: [
          (u) => {
            const x0 = u.valToPos(0, "x", true);
            const x1 = u.valToPos(dur, "x", true);
            const { top, height: h } = u.bbox;
            u.ctx.save();
            u.ctx.fillStyle = band;
            u.ctx.globalAlpha = 0.14;
            u.ctx.fillRect(x0, top, x1 - x0, h);
            u.ctx.restore();
          },
        ],
      },
    };
    const data: uPlot.AlignedData = [xs, ...chans.map((c) => series[c.key] ?? [])];
    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, el.current);
    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [snap, gyro, yRange, xRange, width, height, chans]);

  // 播放头：跟着视频走。只挪一个 div，不重画图（视频每帧都在报时间）
  useEffect(() => {
    if (!live || !bus) return;
    return bus.onTime((sec) => {
      const u = plotRef.current;
      const h = headRef.current;
      if (!u || !h) return;
      const x = (sec * 1000 - snap.info.startMs) / 1000;
      const px = u.valToPos(x, "x", false);
      const { left, width: w } = u.bbox;
      const dpr = window.devicePixelRatio || 1;
      const inside = px >= 0 && px <= w / dpr;
      h.style.display = inside ? "block" : "none";
      h.style.left = `${left / dpr + px}px`;
      h.style.top = `${u.bbox.top / dpr}px`;
      h.style.height = `${u.bbox.height / dpr}px`;
    });
  }, [live, bus, snap]);

  return (
    <div style={{ position: "relative" }}>
      <div ref={el} />
      {live && (
        <div
          ref={headRef}
          style={{ position: "absolute", width: 1, background: "#fadb14", pointerEvents: "none", display: "none" }}
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
  const [cur, setCur] = useState<Snap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<Snap[]>([]);
  const [gyro, setGyro] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);
  // 浮窗位置：可以拖着标题栏挪开，别挡住视频
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 16, bottom: 16 });
  const idRef = useRef(0);

  const key = info ? `${info.startMs}-${info.endMs}` : null;
  useEffect(() => {
    if (!info) {
      setCur(null);
      return;
    }
    setHidden(false);
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
  const chans = gyro ? GYRO : ACC;
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

  // 横轴也共用：一秒在几张图上一样宽，抖得快慢（频率）才能直接比
  const xRange = useMemo<[number, number] | null>(() => {
    const all = [cur, ...pins].filter(Boolean) as Snap[];
    if (all.length < 2) return null;
    const pad = Math.max(...all.map((s) => s.padMs)) / 1000;
    const dur = Math.max(...all.map((s) => (s.info.endMs - s.info.startMs) / 1000));
    return [-pad, dur + pad];
  }, [cur, pins]);

  if ((!info && pins.length === 0) || hidden) return null;

  const W = 440;
  const startDrag = (e: React.MouseEvent) => {
    const sx = e.clientX, sy = e.clientY, p0 = pos;
    const move = (ev: MouseEvent) =>
      setPos({ right: Math.max(0, p0.right - (ev.clientX - sx)), bottom: Math.max(0, p0.bottom - (ev.clientY - sy)) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      style={{
        position: "fixed", right: pos.right, bottom: pos.bottom, zIndex: 1100, width: W + 20,
        background: "var(--ant-color-bg-elevated, #1f1f1f)", border: "1px solid rgba(128,128,128,.35)",
        borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.45)", padding: "6px 10px 8px",
      }}
    >
      <div
        onMouseDown={startDrag}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "move", userSelect: "none", marginBottom: 4 }}
      >
        <Typography.Text strong style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
          {info ? <>波形 · {info.title} <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            （{((info.endMs - info.startMs) / 1000).toFixed(1)}s，前后各多看 {((cur?.padMs ?? padOf(info.endMs - info.startMs)) / 1000).toFixed(1)}s）
          </Typography.Text></> : "钉住的波形"}
        </Typography.Text>
        <Space size={2} onMouseDown={(e) => e.stopPropagation()}>
          <Tooltip title={gyro ? "现在看陀螺仪，点一下换回加速度" : "现在看加速度，点一下换成陀螺仪（只有 6 轴数据才有）"}>
            <Tag style={{ cursor: "pointer", margin: 0 }} onClick={() => setGyro((g) => !g)}>{gyro ? "陀螺仪" : "加速度"}</Tag>
          </Tooltip>
          {cur && (
            <Tooltip title="把这一段留在下面当参照，再去循环别的段并排比（最多 3 段）">
              <Button size="small" type="text" icon={<PushpinOutlined />}
                onClick={() => setPins((p) => [{ ...cur, id: ++idRef.current }, ...p].slice(0, 3))} />
            </Tooltip>
          )}
          <Button size="small" type="text" icon={collapsed ? <PlusOutlined /> : <MinusOutlined />} onClick={() => setCollapsed((c) => !c)} />
          <Tooltip title={info ? "关掉浮窗并停止循环" : "关掉"}>
            <Button size="small" type="text" icon={<CloseOutlined />}
              onClick={() => { setPins([]); setHidden(true); if (info) onStop(); }} />
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
                <MiniPlot snap={cur} gyro={gyro} yRange={yRange} xRange={xRange} width={W} height={150} bus={bus} live />
              ) : (
                <div style={{ height: 150 }} />
              )}
            </Spin>
          )}
          <Space size={8} style={{ fontSize: 11, marginTop: 2 }}>
            {chans.map((c) => <span key={c.key} style={{ color: c.color }}>━ {c.label}</span>)}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>底色 = 片段本身，黄线 = 播放位置</Typography.Text>
          </Space>
          {pins.map((p) => (
            <div key={p.id} style={{ marginTop: 6, borderTop: "1px dashed rgba(128,128,128,.3)", paddingTop: 4 }}>
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
              <MiniPlot snap={p} gyro={gyro} yRange={yRange} xRange={xRange} width={W} height={90} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
