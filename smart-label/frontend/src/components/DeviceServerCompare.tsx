import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, InputNumber, Select, Space, Statistic, Table, Tag, Tooltip, Typography, message, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import request from "@/utils/request";
import { BEHAV_NAMES, type PcSegment } from "@/utils/imuProtocols";

/**
 * 设备调试页「服务端预测」：把最近 N 秒收到的原始采样送到 AI 服务跑模型，
 * 跟板子自己识别的结果（0x07 当前行为、0x09 片段）放在同一条设备时间轴上比。
 */
export interface DevSample { dev: number | null; ax: number; ay: number; az: number; gx?: number; gy?: number; gz?: number }
export interface BoardEvent { ts: number; cls: number; conf: number }

interface ServerWindow { ts_ms: number | null; label: string; conf: number }
interface ServerResult {
  classes: string[]; window_s: number; stride_s: number; hz_model: number; mode: string; n_windows: number;
  windows: ServerWindow[]; model_path: string;
}
interface ModelInfo { tag: string; name: string; is_default?: boolean; hz?: number | null; classes?: string[] | null }

// 板子是 4 类；服务端模型类别可能更细，比对时按名字归一下（甩动类并进活动——板子的后处理也是这么做的）
const TO_BOARD: Record<string, string> = { "甩身体": "活动", "甩头/抖身": "活动", "甩动": "活动", "行走": "活动", "奔跑": "活动" };
const norm = (l: string) => TO_BOARD[l] ?? l;
const COLORS: Record<string, string> = { "睡觉": "#4c72b0", "未佩戴": "#8c8c8c", "活动": "#55a868", "抓挠": "#c44e52" };
const colorOf = (l: string) => COLORS[l] ?? "#dd8452";

export default function DeviceServerCompare({ getSamples, boardEvents, segs, hz, connected }: {
  getSamples: () => DevSample[];
  boardEvents: BoardEvent[];
  segs: PcSegment[];
  hz: number;
  connected: boolean;
}) {
  const { token } = theme.useToken();
  const { data: models } = useQuery({
    queryKey: ["device-debug-models"],
    queryFn: () => request.get<never, ModelInfo[]>("/device-debug/models"),
    staleTime: 60_000,
  });
  const [model, setModel] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<"raw" | "viterbi">("raw");
  const [secs, setSecs] = useState(60);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ServerResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);

  const run = async () => {
    if (busyRef.current) return;
    const all = getSamples().filter((s) => s.dev != null);
    if (all.length < hz * 3) { setErr("最近收到的原始采样不够（至少 3 秒）"); return; }
    const end = all[all.length - 1].dev!;
    const pts = all.filter((s) => s.dev! >= end - secs * 1000);
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const hasGyro = pts.some((s) => s.gx != null);
      const r = await request.post<never, ServerResult>("/device-debug/infer", {
        t_ms: pts.map((s) => Math.round(s.dev!)), acc: pts.map((s) => [s.ax, s.ay, s.az]),
        gyro: hasGyro ? pts.map((s) => [s.gx ?? 0, s.gy ?? 0, s.gz ?? 0]) : null,
        hz, mode, model,
      }, { timeout: 120_000 });
      setRes(r);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      if (!auto) message.error(`服务端预测失败：${m}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!auto || !connected) return;
    void run();
    const t = window.setInterval(() => void run(), Math.max(10, secs / 2) * 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, connected, secs, mode, model]);

  // 同一条时间轴：板子 0x07 每条保持到下一条；服务端每个窗口占一个步长
  const view = useMemo(() => {
    if (!res?.windows.length) return null;
    const ws = res.windows.filter((w) => w.ts_ms != null) as (ServerWindow & { ts_ms: number })[];
    if (!ws.length) return null;
    const step = res.stride_s * 1000;
    const t0 = ws[0].ts_ms, t1 = ws[ws.length - 1].ts_ms + res.window_s * 1000;
    const serverSpans = ws.map((w) => ({ a: w.ts_ms, b: w.ts_ms + step, label: w.label, conf: w.conf }));
    const ev = [...boardEvents].sort((a, b) => a.ts - b.ts);
    const boardSpans = ev.map((e, i) => ({ a: e.ts, b: ev[i + 1]?.ts ?? e.ts + 5000, label: BEHAV_NAMES[e.cls] ?? `?${e.cls}`, conf: e.conf }))
      .filter((s) => s.b > t0 && s.a < t1);
    const segSpans = segs.filter((s) => s.startMs != null).map((s) => ({ a: s.startMs!, b: s.startMs! + s.durS * 1000, label: BEHAV_NAMES[s.cls] ?? `?${s.cls}`, conf: s.conf }))
      .filter((s) => s.b > t0 && s.a < t1);
    // 一致率：每条板子 0x07，取它时刻上服务端的窗口（窗口中心离它最近的那个）
    const centers = ws.map((w) => w.ts_ms + (res.window_s * 1000) / 2);
    const pairs = ev.filter((e) => e.ts >= t0 && e.ts <= t1).map((e) => {
      let k = 0, best = Infinity;
      centers.forEach((c, i) => { const d = Math.abs(c - e.ts); if (d < best) { best = d; k = i; } });
      const board = BEHAV_NAMES[e.cls] ?? `?${e.cls}`;
      return { ts: e.ts, board, boardConf: e.conf, server: ws[k].label, serverConf: ws[k].conf, same: norm(ws[k].label) === board };
    });
    // 服务端各类占比
    const cnt: Record<string, number> = {};
    for (const w of ws) cnt[w.label] = (cnt[w.label] ?? 0) + 1;
    return { t0, t1, serverSpans, boardSpans, segSpans, pairs, cnt, n: ws.length };
  }, [res, boardEvents, segs]);

  const Row = ({ name, spans, t0, t1 }: { name: string; spans: { a: number; b: number; label: string; conf: number }[]; t0: number; t1: number }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <div style={{ width: 110, fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>{name}</div>
      <div style={{ position: "relative", flex: 1, height: 22, background: token.colorFillQuaternary, borderRadius: 4, overflow: "hidden" }}>
        {spans.map((s, i) => {
          const l = ((Math.max(s.a, t0) - t0) / (t1 - t0)) * 100, w = ((Math.min(s.b, t1) - Math.max(s.a, t0)) / (t1 - t0)) * 100;
          return w > 0 ? (
            <Tooltip key={i} title={`${s.label} ${s.conf <= 1 ? Math.round(s.conf * 100) : s.conf}% · ${new Date(s.a).toLocaleTimeString()}–${new Date(s.b).toLocaleTimeString()}`}>
              <div style={{ position: "absolute", left: `${l}%`, width: `${w}%`, top: 2, bottom: 2, background: colorOf(norm(s.label)), opacity: 0.85, borderRight: `1px solid ${token.colorBgContainer}` }} />
            </Tooltip>
          ) : null;
        })}
      </div>
    </div>
  );

  const agree = view?.pairs.length ? view.pairs.filter((p) => p.same).length / view.pairs.length : null;
  const modelName = (models ?? []).find((m) => m.tag === model) ?? (models ?? []).find((m) => m.is_default);
  return (
    <Card size="small" title="服务端预测（同一段原始采样送去跑模型，跟板子比）" style={{ marginTop: 12 }}
      extra={
        <Space wrap size={6}>
          <Select size="small" style={{ width: 220 }} placeholder="默认模型" allowClear value={model} onChange={setModel}
            options={(models ?? []).map((m) => ({ value: m.tag, label: `${m.name}${m.is_default ? "（默认）" : ""}${m.hz ? ` · ${m.hz}Hz` : ""}` }))} />
          <Select size="small" style={{ width: 130 }} value={mode} onChange={setMode}
            options={[{ value: "raw", label: "逐窗口原始" }, { value: "viterbi", label: "稳定版（平滑）" }]} />
          <span style={{ fontSize: 12 }}>最近</span>
          <InputNumber size="small" min={10} max={600} step={10} value={secs} onChange={(v) => v && setSecs(v)} style={{ width: 70 }} />
          <span style={{ fontSize: 12 }}>秒</span>
          <Button size="small" type="primary" loading={busy} disabled={!connected} onClick={run}>跑一次</Button>
          <Tooltip title={`连着的时候每 ${Math.max(10, secs / 2)} 秒自动跑一次`}>
            <Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)}>自动</Checkbox>
          </Tooltip>
        </Space>
      }>
      {err && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={err} />}
      {!res && !err && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          要原始采样（0x08）。板子只有加速度：选 3 轴（只用加速度）训的模型比才公平，6 轴模型陀螺仪按 0 喂，结果会偏。
        </Typography.Text>
      )}
      {view && (
        <>
          <Space size={24} wrap style={{ marginBottom: 8 }}>
            <Statistic title="跟板子一致（按 0x07 时刻）" value={agree == null ? "-" : `${Math.round(agree * 100)}%`}
              suffix={<span style={{ fontSize: 12 }}>{view.pairs.length} 条</span>} />
            <Statistic title="服务端窗口" value={view.n} suffix={<span style={{ fontSize: 12 }}>{res!.window_s}s 窗 / {res!.stride_s}s 步 · {res!.hz_model}Hz</span>} />
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
              模型 {modelName?.name ?? res!.model_path.split("/").slice(-2).join("/")}<br />
              服务端各类：{Object.entries(view.cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / view.n) * 100)}%`).join(" · ")}
            </div>
          </Space>
          <Row name="板子 · 当前行为" spans={view.boardSpans} t0={view.t0} t1={view.t1} />
          {view.segSpans.length > 0 && <Row name="板子 · 片段" spans={view.segSpans} t0={view.t0} t1={view.t1} />}
          <Row name={`服务端 · ${mode === "raw" ? "逐窗口" : "稳定版"}`} spans={view.serverSpans} t0={view.t0} t1={view.t1} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: token.colorTextTertiary, marginLeft: 118 }}>
            <span>{new Date(view.t0).toLocaleTimeString()}</span><span>{new Date(view.t1).toLocaleTimeString()}</span>
          </div>
          <Space size={10} style={{ marginTop: 6 }}>
            {Object.entries(COLORS).map(([k, c]) => <span key={k} style={{ fontSize: 12 }}><span style={{ display: "inline-block", width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4 }} />{k}</span>)}
            <span style={{ fontSize: 12 }}><span style={{ display: "inline-block", width: 10, height: 10, background: "#dd8452", borderRadius: 2, marginRight: 4 }} />其它</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>服务端的甩动类算作活动（板子把甩动并进活动 / 抓挠）</Typography.Text>
          </Space>
          {view.pairs.some((p) => !p.same) && (
            <Table size="small" style={{ marginTop: 8 }} rowKey="ts" pagination={{ pageSize: 8, hideOnSinglePage: true }}
              dataSource={view.pairs.filter((p) => !p.same)}
              columns={[
                { title: "时刻", render: (_: unknown, p) => new Date(p.ts).toLocaleTimeString() },
                { title: "板子", render: (_: unknown, p) => <Tag color={colorOf(p.board)}>{p.board} {p.boardConf}%</Tag> },
                { title: "服务端", render: (_: unknown, p) => <Tag color={colorOf(norm(p.server))}>{p.server} {Math.round(p.serverConf * 100)}%</Tag> },
              ]} />
          )}
        </>
      )}
    </Card>
  );
}
