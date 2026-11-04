import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Col, InputNumber, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography, message, theme,
} from "antd";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  BEHAV_NAMES, CMD, DP, PC, WIT, WitStream, assessRate, buildAckFrame, buildTimeFrame, parseDps, parseFrame, parseSegments,
  type PcSegment, type RateAssess,
} from "@/utils/imuProtocols";

/**
 * 设备调试：用打开网页这台电脑的蓝牙直接连 IMU（Web Bluetooth，Chrome / Edge），
 * 实时看波形、采样率是不是期望值、每帧间隔稳不稳；自制项圈还能校时、看当前行为 / 行为片段。
 * 不经过服务器，数据只在这个页面里；要留就「录制」下载 CSV。
 *
 * 浏览器只在 https 或 localhost 上开放蓝牙。平台是 http + 局域网 IP 时，要在调试的那台电脑上
 * 把这个地址加进 Chrome 的「当作安全来源」白名单（页面上有步骤）。
 */
type Kind = "pc" | "wit";
interface Sample { host: number; dev: number | null; ax: number; ay: number; az: number; gx?: number; gy?: number; gz?: number }

const KEEP_S = 20;          // 波形和评估保留最近这么多秒
const PLOT_S = 10;

// Web Bluetooth 的类型 TS 自带的 lib 里没有，这里只声明用到的那几样
type BtChar = { startNotifications(): Promise<BtChar>; addEventListener(t: string, f: (e: Event) => void): void; writeValueWithoutResponse?(v: BufferSource): Promise<void>; writeValue(v: BufferSource): Promise<void>; value?: DataView; properties: { notify: boolean } };
type BtService = { getCharacteristic(u: string): Promise<BtChar>; getCharacteristics(): Promise<BtChar[]> };
type BtServer = { connected: boolean; getPrimaryService(u: string): Promise<BtService>; disconnect(): void };
type BtDevice = {
  name?: string; id: string; gatt?: { connect(): Promise<BtServer>; connected?: boolean };
  addEventListener(t: string, f: () => void): void; removeEventListener?(t: string, f: () => void): void;
  // 设备不在旁边时直接 connect 会失败：先等它的广播，收到再连
  watchAdvertisements?(): Promise<void>;
};
// getDevices：拿到之前授权过的设备，不用再弹选择框（Chrome 要开 #enable-web-bluetooth-new-permissions-backend）
const bt = () => (navigator as unknown as { bluetooth?: { requestDevice(o: unknown): Promise<BtDevice>; getDevices?(): Promise<BtDevice[]> } }).bluetooth;
const LAST_KEY = "smart-label:ble-last";

export default function DeviceDebug() {
  const { token } = theme.useToken();
  const [kind, setKind] = useState<Kind>("pc");
  const [expectHz, setExpectHz] = useState<number>(31.25);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [devName, setDevName] = useState<string>("");
  const [autoAck, setAutoAck] = useState(true);
  const [showGyro, setShowGyro] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [behav, setBehav] = useState<{ cls: number; conf: number; at: number } | null>(null);
  const [segs, setSegs] = useState<PcSegment[]>([]);
  const [rate, setRate] = useState<RateAssess | null>(null);
  const [count, setCount] = useState(0);
  const [recording, setRecording] = useState(false);
  const [noRawHint, setNoRawHint] = useState(false);

  const samples = useRef<Sample[]>([]);
  const rec = useRef<Sample[] | null>(null);
  const total = useRef(0);
  const server = useRef<BtServer | null>(null);
  const rx = useRef<BtChar | null>(null);
  const lastSeq = useRef(0);
  const plotEl = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const connectedAt = useRef(0);

  const supported = !!bt() && window.isSecureContext;
  const addLog = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 200));

  useEffect(() => setExpectHz(kind === "pc" ? 31.25 : 50), [kind]);

  const write = async (frame: Uint8Array) => {
    const c = rx.current;
    if (!c) return;
    const buf = frame.slice().buffer as ArrayBuffer;   // 拷一份成普通 ArrayBuffer（BufferSource 不收 SharedArrayBuffer 视图）
    try {
      if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(buf);
      else await c.writeValue(buf);
    } catch (e) {
      addLog(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const timeSync = async () => { await write(buildTimeFrame()); addLog("已下发校时（UTC）"); };

  const push = (s: Sample) => {
    // 设备时间大跳（刚校时把时钟拨了）：评估重新开始
    const prev = samples.current[samples.current.length - 1];
    if (prev && prev.dev != null && s.dev != null && Math.abs(s.dev - prev.dev) > 10_000) {
      samples.current = [];
      addLog(`设备时间跳了 ${((s.dev - prev.dev) / 1000).toFixed(1)} 秒（多半是刚校时），重新统计`);
    }
    samples.current.push(s);
    total.current++;
    if (prev && prev.dev != null && s.dev != null && Math.abs(s.dev - prev.dev) > 10_000) resetSess();
    if (!sess.current.n) { sess.current.host0 = s.host; sess.current.dev0 = s.dev; }
    sess.current.n++;
    sess.current.hostN = s.host;
    sess.current.devN = s.dev;
    if (rec.current) rec.current.push(s);
    const cut = s.host - KEEP_S * 1000;
    if (samples.current.length > 4000 || samples.current[0].host < cut) {
      let i = 0;
      while (i < samples.current.length && samples.current[i].host < cut) i++;
      samples.current = samples.current.slice(i);
    }
  };

  const onPcNotify = (e: Event) => {
    const dv = (e.target as unknown as BtChar).value!;
    const p = parseFrame(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    if (!p) return;
    if (p.cmd === CMD.TIME) { void timeSync(); return; }
    if (p.cmd === CMD.RAW) {
      const d = parseDps(p.payload);
      push({ host: performance.now(), dev: d[DP.TS] ?? null, ax: (d[DP.AX] ?? 0) / 1e6, ay: (d[DP.AY] ?? 0) / 1e6, az: (d[DP.AZ] ?? 0) / 1e6 });
      return;
    }
    if (p.cmd === CMD.BEHAVIOR) {
      const d = parseDps(p.payload);
      setBehav({ cls: d[DP.CLS] ?? -1, conf: d[DP.CONF] ?? 0, at: d[DP.TS] ?? Date.now() });
      return;
    }
    if (p.cmd === CMD.SEGMENT) {
      const ss = parseSegments(p.payload);
      if (!ss.length) return;
      setSegs((old) => {
        const by = new Map(old.map((x) => [x.seq, x]));
        for (const x of ss) by.set(x.seq, x);
        return [...by.values()].sort((a, b) => b.seq - a.seq).slice(0, 500);
      });
      lastSeq.current = Math.max(lastSeq.current, ...ss.map((x) => x.seq));
      addLog(`收到 ${ss.length} 条行为片段，最新 seq ${lastSeq.current}`);
      if (autoAckRef.current) void write(buildAckFrame(lastSeq.current));
    }
  };
  const autoAckRef = useRef(autoAck);
  autoAckRef.current = autoAck;

  const witStream = useRef(new WitStream());
  const onWitNotify = (e: Event) => {
    const dv = (e.target as unknown as BtChar).value!;
    for (const s of witStream.current.feed(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) {
      push({ host: performance.now(), dev: s.chipMs, ax: s.acc[0], ay: s.acc[1], az: s.acc[2], gx: s.gyro[0], gy: s.gyro[1], gz: s.gyro[2] });
    }
  };

  const device = useRef<BtDevice | null>(null);
  const userClosed = useRef(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const autoReconnectRef = useRef(autoReconnect);
  autoReconnectRef.current = autoReconnect;
  // 整次连接：真实时间里收了多少个、设备时间走了多久——分清「传感器真的慢」还是「设备时间戳算得不对」
  const sess = useRef<{ n: number; host0: number; hostN: number; dev0: number | null; devN: number | null }>({ n: 0, host0: 0, hostN: 0, dev0: null, devN: null });
  const [sessView, setSessView] = useState<typeof sess.current | null>(null);
  const resetSess = () => { sess.current = { n: 0, host0: 0, hostN: 0, dev0: null, devN: null }; };

  // 回调每次渲染都是新函数；监听挂的是这两个固定的转发函数，同一个特征只挂一次——
  // 重连时浏览器可能给回同一个特征对象，再挂一次每个样本就收两遍（全是 0 ms 间隔）
  const pcRef = useRef(onPcNotify);
  pcRef.current = onPcNotify;
  const witRef = useRef(onWitNotify);
  witRef.current = onWitNotify;
  const pcHandler = useRef((e: Event) => pcRef.current(e)).current;
  const witHandler = useRef((e: Event) => witRef.current(e)).current;
  const hooked = useRef(new WeakSet<object>());
  const listen = async (c: BtChar, h: (e: Event) => void) => {
    if (!hooked.current.has(c)) {
      c.addEventListener("characteristicvaluechanged", h);
      hooked.current.add(c);
    }
    await c.startNotifications();
  };

  /** 连 GATT + 订阅；断线自动重连也走这里（不再弹选择框） */
  const attach = async (dev: BtDevice) => {
    const srv = await dev.gatt!.connect();
    server.current = srv;
    samples.current = [];
    resetSess();
    connectedAt.current = performance.now();
    if (kind === "pc") {
      const svc = await srv.getPrimaryService(PC.service);
      rx.current = await svc.getCharacteristic(PC.rx);
      const tx = await svc.getCharacteristic(PC.tx);
      await listen(tx, pcHandler);
      try {
        const tx2 = await svc.getCharacteristic(PC.tx2);
        await listen(tx2, pcHandler);
      } catch {
        addLog("TX2（0203）订阅不了：这个固件可能没开原始采样镜像");
      }
      await timeSync();
    } else {
      rx.current = null;
      witStream.current = new WitStream();
      let ok = false;
      for (const su of WIT.services) {
        try {
          const svc = await srv.getPrimaryService(su);
          for (const c of await svc.getCharacteristics()) {
            if (!c.properties.notify) continue;
            await listen(c, witHandler);
            ok = true;
          }
        } catch { /* 这个服务没有，试下一个 */ }
      }
      if (!ok) throw new Error("没找到 WitMotion 的数据通道（ffe5 / ffe0 服务）");
    }
    setStatus("connected");
    addLog(`已连接 ${dev.name || dev.id}`);
  };

  const onDisconnected = async () => {
    setStatus("idle");
    if (userClosed.current || !autoReconnectRef.current || !device.current) { addLog("设备断开了"); return; }
    // 信号弱时常常掉：同一个设备直接重连，不用重新选
    for (let i = 1; i <= 8 && !userClosed.current; i++) {
      addLog(`设备断开了，第 ${i} 次重连…`);
      setStatus("connecting");
      try {
        await attach(device.current);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * i)));
      }
    }
    setStatus("idle");
    addLog("重连不上：靠近一点再点「连接设备」");
  };

  const useDevice = async (dev: BtDevice) => {
    device.current = dev;
    userClosed.current = false;
    setDevName(dev.name || dev.id);
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ kind, id: dev.id, name: dev.name })); } catch { /* ignore */ }
    dev.addEventListener("gattserverdisconnected", () => { void onDisconnected(); });
    total.current = 0;
    lastSeq.current = 0;
    setSegs([]);
    setBehav(null);
    setNoRawHint(false);
    await attach(dev);
  };

  const connect = async () => {
    const b = bt();
    if (!b) return;
    setStatus("connecting");
    try {
      const dev = await b.requestDevice(kind === "pc"
        ? { filters: [{ namePrefix: "HICC" }, { services: [PC.service] }], optionalServices: [PC.service] }
        : { filters: [{ namePrefix: "WT" }], optionalServices: WIT.services });
      await useDevice(dev);
    } catch (e) {
      setStatus("idle");
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) message.error(`连接失败：${msg}`);
    }
  };

  // 上次连过的设备：浏览器支持 getDevices 时直接连，不弹选择框
  const last = (() => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || "null") as { kind: Kind; id: string; name?: string } | null; } catch { return null; } })();
  const canQuick = !!bt()?.getDevices && !!last && last.kind === kind;
  const connectLast = async (silent = false) => {
    const b = bt();
    if (!b?.getDevices || !last) return;
    setStatus("connecting");
    try {
      const dev = (await b.getDevices()).find((d) => d.id === last.id);
      if (!dev) throw new Error("浏览器里找不到上次那个设备的授权，用「连接设备」重新选一次");
      try {
        await useDevice(dev);
      } catch (e) {
        // 刚打开页面时浏览器还没「看见」它：等它的广播（最多 20 秒），收到再连
        if (!dev.watchAdvertisements) throw e;
        addLog(`等 ${dev.name ?? "设备"} 的广播…`);
        await dev.watchAdvertisements();
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("20 秒没收到它的广播：设备在不在旁边、开没开")), 20000);
          const on = () => { window.clearTimeout(timer); dev.removeEventListener?.("advertisementreceived", on); resolve(); };
          dev.addEventListener("advertisementreceived", on);
        });
        await useDevice(dev);
      }
    } catch (e) {
      setStatus("idle");
      const msg = e instanceof Error ? e.message : String(e);
      if (silent) addLog(`自动连上次的设备没成：${msg}`);
      else message.error(`连不上：${msg}`);
    }
  };

  // 刷新 / 重新打开页面：蓝牙连接跟着页面没了（浏览器的规定，网页留不住）。
  // 浏览器支持 getDevices 时自动连回上次那个，不用再选
  const [autoOpen, setAutoOpenState] = useState(() => { try { return localStorage.getItem("smart-label:ble-auto-open") !== "0"; } catch { return true; } });
  const setAutoOpen = (v: boolean) => { setAutoOpenState(v); try { localStorage.setItem("smart-label:ble-auto-open", v ? "1" : "0"); } catch { /* ignore */ } };
  const triedAuto = useRef(false);
  useEffect(() => {
    if (triedAuto.current || !supported || !last || !bt()?.getDevices || !autoOpen) return;
    if (last.kind !== kind) { setKind(last.kind); return; }   // 先切到上次的设备类型，切过去这个 effect 再跑一次
    triedAuto.current = true;
    void connectLast(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  // 连着的时候刷新 / 关页面先问一句
  useEffect(() => {
    if (status !== "connected") return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [status]);

  const disconnect = () => { userClosed.current = true; server.current?.disconnect(); setStatus("idle"); };
  useEffect(() => () => { userClosed.current = true; server.current?.disconnect(); }, []);

  // 每秒评估一次 + 刷新波形（不在每个样本上重画）
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = performance.now();
      const win = samples.current.filter((s) => s.host >= now - 5000);
      setCount(total.current);
      const withDev = win.filter((s) => s.dev != null);
      setRate(withDev.length >= 3
        ? assessRate(withDev.map((s) => s.dev!), withDev.map((s) => s.host), expectHz)
        : win.length >= 3 ? { ...assessRate(win.map((s) => s.host), win.map((s) => s.host), expectHz), problems: ["设备没带时间戳，下面按浏览器收到的时间算（蓝牙成批送，间隔会偏乱）"] } : null);
      if (kind === "pc" && status === "connected" && total.current === 0 && now - connectedAt.current > 6000) setNoRawHint(true);
      const u = plot.current;
      // 横轴按设备时间戳（有的话）：蓝牙一批一批到，按浏览器收到的时间画，一批挤在一点、批与批之间连成直线
      const lastS = samples.current[samples.current.length - 1];
      const byDev = !!lastS && lastS.dev != null;
      const pts = byDev
        ? samples.current.filter((s) => s.dev != null && s.dev >= lastS.dev! - PLOT_S * 1000)
        : samples.current.filter((s) => s.host >= now - PLOT_S * 1000);
      setSessView({ ...sess.current });
      if (u) {
        const xs = pts.map((s) => (byDev ? (s.dev! - lastS.dev!) / 1000 : (s.host - now) / 1000));
        const g = showGyro;
        u.setData([xs, pts.map((s) => (g ? s.gx ?? 0 : s.ax)), pts.map((s) => (g ? s.gy ?? 0 : s.ay)), pts.map((s) => (g ? s.gz ?? 0 : s.az))]);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [expectHz, kind, status, showGyro]);

  useEffect(() => {
    if (!plotEl.current) return;
    const u = new uPlot({
      width: plotEl.current.clientWidth || 800, height: 240, legend: { show: true },
      scales: { x: { time: false, range: [-PLOT_S, 0] } },
      axes: [{ stroke: token.colorTextSecondary, grid: { stroke: token.colorBorderSecondary } },
        { stroke: token.colorTextSecondary, grid: { stroke: token.colorBorderSecondary } }],
      series: [{ label: "秒" }, { label: "X", stroke: "#ff7875", width: 1.5 }, { label: "Y", stroke: "#95de64", width: 1.5 }, { label: "Z", stroke: "#69b1ff", width: 1.5 }],
    }, [[], [], [], []], plotEl.current);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: plotEl.current!.clientWidth, height: 240 }));
    ro.observe(plotEl.current);
    return () => { ro.disconnect(); u.destroy(); plot.current = null; };
  }, [token.colorTextSecondary, token.colorBorderSecondary]);

  const download = () => {
    const rows = rec.current ?? [];
    rec.current = null;
    setRecording(false);
    if (!rows.length) { message.info("没录到数据"); return; }
    const head = kind === "pc" ? "t_dev_ms,ax_g,ay_g,az_g,t_host_ms" : "t_chip_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,t_host_ms";
    const t0 = performance.timeOrigin;
    const lines = rows.map((s) => kind === "pc"
      ? `${s.dev ?? ""},${s.ax.toFixed(4)},${s.ay.toFixed(4)},${s.az.toFixed(4)},${Math.round(t0 + s.host)}`
      : `${s.dev ?? ""},${s.ax.toFixed(4)},${s.ay.toFixed(4)},${s.az.toFixed(4)},${s.gx?.toFixed(2)},${s.gy?.toFixed(2)},${s.gz?.toFixed(2)},${Math.round(t0 + s.host)}`);
    const blob = new Blob([[head, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(devName || kind).replace(/[^\w-]/g, "_")}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const flagUrl = "chrome://flags/#unsafely-treat-insecure-origin-as-secure";
  const segCols = useMemo(() => [
    { title: "seq", dataIndex: "seq", width: 80 },
    { title: "开始", render: (_: unknown, s: PcSegment) => (s.startMs == null ? <Tag>时间未知</Tag> : new Date(s.startMs).toLocaleString()) },
    { title: "时长", render: (_: unknown, s: PcSegment) => `${s.durS.toFixed(1)} s` },
    { title: "类别", render: (_: unknown, s: PcSegment) => <Tag>{BEHAV_NAMES[s.cls] ?? `?${s.cls}`}</Tag> },
    { title: "置信度", dataIndex: "conf", render: (v: number) => `${v}%` },
  ], []);

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>设备调试</Typography.Title>
        <Segmented value={kind} onChange={(v) => setKind(v as Kind)} disabled={status !== "idle"}
          options={[{ value: "pc", label: "自制项圈" }, { value: "wit", label: "WitMotion" }]} />
        {status === "connected"
          ? <Button danger onClick={disconnect}>断开 {devName}</Button>
          : <Button type="primary" loading={status === "connecting"} disabled={!supported} onClick={connect}>连接设备</Button>}
        {status === "idle" && canQuick && (
          <Tooltip title="直接连上次选过的那个，不弹选择框">
            <Button disabled={!supported} onClick={() => connectLast()}>重连 {last?.name ?? "上次的设备"}</Button>
          </Tooltip>
        )}
        <Tooltip title="信号弱掉线时，自动重连同一个设备（不用重新选）">
          <Checkbox checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)}>掉线自动重连</Checkbox>
        </Tooltip>
        {!!bt()?.getDevices && (
          <Tooltip title="刷新 / 重新打开这页时自动连回上次那个设备">
            <Checkbox checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)}>打开页面自动连</Checkbox>
          </Tooltip>
        )}
        {status === "connected" && kind === "pc" && <Button onClick={timeSync}>校时</Button>}
        {status === "connected" && (recording
          ? <Button onClick={download}>停止并下载 CSV（{rec.current?.length ?? 0}）</Button>
          : <Button onClick={() => { rec.current = []; setRecording(true); }}>开始录制</Button>)}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          用这台电脑的蓝牙直接连，数据不经过服务器
        </Typography.Text>
      </Space>

      {!supported && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          // http 页面上 Chrome 根本不给 navigator.bluetooth，所以先判是不是 http，别误报成「浏览器不支持」
          message={!window.isSecureContext
            ? "这个地址是 http，Chrome / Edge 默认不让网页用蓝牙，要在这台电脑上设一次"
            : "这个浏览器不支持网页蓝牙：用电脑上的 Chrome 或 Edge 打开"}
          description={!window.isSecureContext ? (
            <div style={{ lineHeight: 1.9 }}>
              <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                <li>新标签页地址栏打开 <Typography.Text copyable code>{flagUrl}</Typography.Text>（Edge 把开头的 chrome 换成 edge）</li>
                <li>页面会直接定位到黄色高亮的「<b>Insecure origins treated as secure</b>」那一项。<b>别填在最上面的搜索框里</b>——
                  在这一项<b>下面的文本框</b>里填 <Typography.Text copyable code>{window.location.origin}</Typography.Text></li>
                <li>这一项右边的下拉选 <b>Enabled</b>，再点右下角 <b>Relaunch</b> 重启浏览器，回到这页</li>
              </ol>
              <div style={{ marginTop: 4 }}>
                找不到这一项：搜索框里搜 <Typography.Text code>insecure</Typography.Text>（不是搜地址）。
                还是没有（新版 Chrome 收起来了）：用命令行启动一份 Chrome，
                <Typography.Text copyable code>{`chrome.exe --unsafely-treat-insecure-origin-as-secure=${window.location.origin} --user-data-dir=%TEMP%\\chrome-ble`}</Typography.Text>
              </div>
              <div style={{ marginTop: 4, opacity: 0.8 }}>以后要所有电脑都免设置，平台改成 https 就行。</div>
            </div>
          ) : undefined} />
      )}

      {supported && !bt()?.getDevices && (
        <Alert type="info" showIcon closable style={{ marginBottom: 12 }}
          message="刷新页面蓝牙会断开（浏览器规定，连接跟着页面走），默认刷新后要重新选设备"
          description={<span>想刷新后自动连回上次的设备：Chrome 打开 <Typography.Text copyable code>chrome://flags/#enable-web-bluetooth-new-permissions-backend</Typography.Text>，选 Enabled，重启浏览器。</span>} />
      )}

      <Row gutter={12}>
        <Col xs={24} xl={16}>
          <Card size="small" title={`波形（最近 ${PLOT_S} 秒）`}
            extra={kind === "wit" && <Checkbox checked={showGyro} onChange={(e) => setShowGyro(e.target.checked)}>看角速度</Checkbox>}>
            <div ref={plotEl} style={{ width: "100%" }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {kind === "pc" ? "加速度（g），来自 0x08 原始采样镜像" : showGyro ? "角速度（°/s）" : "加速度（g）"} · 已收 {count} 个样本
            </Typography.Text>
            {noRawHint && (
              <Alert type="info" showIcon style={{ marginTop: 8 }}
                message="连上了但收不到原始采样（0x08）：正式固件（协议 v2.0）不发，要用 PB_RAW_STREAM=1 编的调试固件。当前行为和行为片段照常能看" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card size="small" title="采样率 / 间隔（最近 5 秒）"
            extra={<Space size={4}><span style={{ fontSize: 12 }}>期望</span>
              <InputNumber size="small" min={1} max={500} step={0.25} value={expectHz} onChange={(v) => v && setExpectHz(v)} style={{ width: 80 }} />
              <span style={{ fontSize: 12 }}>Hz</span></Space>}>
            {!rate ? <Typography.Text type="secondary">还没有数据</Typography.Text> : (
              <>
                <Space size={24} wrap>
                  <Statistic title="采样率" value={rate.rateHz?.toFixed(2) ?? "-"} suffix="Hz"
                    valueStyle={{ color: rate.ok ? token.colorSuccess : token.colorError }} />
                  <Statistic title={`在 ${rate.expectMs.toFixed(1)}±10% ms 内`} value={rate.within10Pct?.toFixed(0) ?? "-"} suffix="%" />
                  <Statistic title="间隔标准差" value={rate.ivStd?.toFixed(1) ?? "-"} suffix="ms" />
                </Space>
                <div style={{ fontSize: 12, marginTop: 8, color: token.colorTextSecondary, lineHeight: 1.8 }}>
                  间隔 均值 {rate.ivMean?.toFixed(1)} · p5 {rate.ivP5?.toFixed(0)} · p95 {rate.ivP95?.toFixed(0)} · 最短 {rate.ivMin?.toFixed(0)} · 最长 {rate.ivMax?.toFixed(0)} ms<br />
                  0 ms {rate.dup} 次 · 大缝 {rate.gaps} 处 · 长短交替 {rate.alternating} 次
                  {rate.hostHz != null && <><br />浏览器收到 {rate.hostHz.toFixed(1)} Hz（蓝牙成批送，只看有没有丢）</>}
                </div>
                <div style={{ marginTop: 8 }}>
                  {rate.ok ? <Tag color="success">正常</Tag> : rate.problems.map((p) => <div key={p}><Tag color="error" style={{ whiteSpace: "normal" }}>{p}</Tag></div>)}
                </div>
              </>
            )}
          </Card>
          {sessView && sessView.n > 10 && (() => {
            const realS = (sessView.hostN - sessView.host0) / 1000;
            const devS = sessView.dev0 != null && sessView.devN != null ? (sessView.devN - sessView.dev0) / 1000 : null;
            const realHz = realS > 0 ? (sessView.n - 1) / realS : NaN;
            const devHz = devS && devS > 0 ? (sessView.n - 1) / devS : NaN;
            const drift = devS != null && realS > 0 ? (devS / realS - 1) * 100 : NaN;
            return (
              <Card size="small" title="整次连接（真实时间 vs 设备时间）" style={{ marginTop: 12 }}>
                <Space size={24} wrap>
                  <Statistic title="真实时间里每秒收到" value={Number.isFinite(realHz) ? realHz.toFixed(2) : "-"} suffix="个" />
                  <Statistic title="按设备时间戳" value={Number.isFinite(devHz) ? devHz.toFixed(2) : "-"} suffix="Hz" />
                </Space>
                <div style={{ fontSize: 12, marginTop: 6, color: token.colorTextSecondary, lineHeight: 1.8 }}>
                  {sessView.n} 个样本 · 真实 {realS.toFixed(0)} 秒{devS != null ? ` · 设备时间走了 ${devS.toFixed(1)} 秒（${drift >= 0 ? "快" : "慢"} ${Math.abs(drift).toFixed(1)}%）` : ""}
                  <br />两个数接近 = 传感器就是这个速率；真实时间收到的明显多于设备时间戳算的 = 设备时间戳算得不对（比如按错的周期给每个样本插时间）。
                  前十几秒可能是连上后补发的积压，看久一点再下结论
                </div>
              </Card>
            );
          })()}
          {kind === "pc" && (
            <Card size="small" title="当前行为（0x07）" style={{ marginTop: 12 }}>
              {behav ? (
                <Space>
                  <Tag color="purple" style={{ fontSize: 16, padding: "4px 12px" }}>{BEHAV_NAMES[behav.cls] ?? `?${behav.cls}`}</Tag>
                  <span>{behav.conf}%</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(behav.at).toLocaleTimeString()}</Typography.Text>
                </Space>
              ) : <Typography.Text type="secondary">还没收到（约 5 秒一条）</Typography.Text>}
            </Card>
          )}
        </Col>
      </Row>

      {kind === "pc" && (
        <Card size="small" title={`行为片段（0x09）· ${segs.length} 条`} style={{ marginTop: 12 }}
          extra={<Tooltip title="收到就回 0x0A 确认，设备才会释放这些片段；关掉用来验证「不确认会补发」">
            <Checkbox checked={autoAck} onChange={(e) => setAutoAck(e.target.checked)}>自动确认</Checkbox>
          </Tooltip>}>
          <Table size="small" rowKey="seq" dataSource={segs} columns={segCols} pagination={{ pageSize: 20, hideOnSinglePage: true }} />
        </Card>
      )}

      <Card size="small" title="日志" style={{ marginTop: 12 }}>
        <div style={{ maxHeight: 180, overflow: "auto", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12 }}>
          {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <Typography.Text type="secondary">—</Typography.Text>}
        </div>
      </Card>
    </div>
  );
}
