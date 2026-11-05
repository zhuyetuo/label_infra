import { useEffect, useRef, useState } from "react";
import { Card, Space, Statistic, Tooltip, Typography, theme } from "antd";
import request from "@/utils/request";

/**
 * 设备调试页「板上时间 vs 电脑时间 vs 服务器时间」。
 *
 * 每个样本带着板子打的时间戳（板上时间），浏览器收到时记一下电脑时间。
 * 两者之差 = 时钟偏差 + 蓝牙延迟；蓝牙只会让它「晚到」，所以每 2 秒取差值最大的那个
 * （延迟最小的那个样本）当这一刻的真实偏差。偏差随时间的斜率 = 板子时钟比真实时间快/慢多少：
 *   斜率≈0：板上时间跟真实时间同步走，时间戳可信——按时间戳算出的采样率就是传感器真实的速率；
 *   斜率≠0：板子的时间戳本身走快/走慢了（时钟源不准，或按固定周期给每帧填时间），
 *           真实采样率要按真实时间数个数，不能信时间戳。
 * 刚连上的前 20 秒常有积压的数据一起补发，不算进去。
 */
export interface ClockSample { host: number; dev: number | null }

const BUCKET_MS = 2000;
const SKIP_S = 20;

interface Stat {
  pts: { t: number; off: number }[];         // t：连上后第几秒；off：板上时间 − 电脑时间（ms）
  nowOff: number | null;
  slope: number | null;                      // ms / s（= 千分之几）
  realHz: number | null; devHz: number | null; fitS: number;
}

const fmtOff = (ms: number) => {
  const a = Math.abs(ms), sign = ms >= 0 ? "快" : "慢";
  if (a < 1000) return `${sign} ${a.toFixed(0)} ms`;
  if (a < 120_000) return `${sign} ${(a / 1000).toFixed(2)} 秒`;
  if (a < 7_200_000) return `${sign} ${(a / 60_000).toFixed(1)} 分钟`;
  return `${sign} ${(a / 3_600_000).toFixed(2)} 小时`;
};

export default function DeviceClockCompare({ getSamples, epoch, expectHz, isPc }: {
  getSamples: () => ClockSample[];
  /** 新的一次连接（或设备时间跳了）就换一个号，从头算 */
  epoch: number;
  expectHz: number;
  isPc: boolean;
}) {
  const { token } = theme.useToken();
  const acc = useRef({
    buckets: new Map<number, number>(), lastHost: -1, host0: null as number | null,
    n: 0, h0: 0, h1: 0, d0: 0, d1: 0,
  });
  const [st, setSt] = useState<Stat | null>(null);
  const [srv, setSrv] = useState<{ off: number; rtt: number } | null>(null);   // 服务器时间 − 电脑时间

  useEffect(() => {
    acc.current = { buckets: new Map(), lastHost: -1, host0: null, n: 0, h0: 0, h1: 0, d0: 0, d1: 0 };
    setSt(null);
  }, [epoch]);

  // 服务器时间：取往返最短的那次（往返越短，「对方是在中点那一刻读的表」越准）
  useEffect(() => {
    let best: { off: number; rtt: number; at: number } | null = null;
    const once = async () => {
      try {
        const a = performance.now();
        const r = await request.get<never, { server_ms: number }>("/device-debug/time");
        const b = performance.now();
        const off = r.server_ms - (performance.timeOrigin + (a + b) / 2);
        // 太旧的不要：电脑时钟可能被系统校时改过
        if (!best || b - a < best.rtt || performance.now() - best.at > 300_000) best = { off, rtt: b - a, at: performance.now() };
        setSrv({ off: best.off, rtt: best.rtt });
      } catch { /* 服务器老版本没这个接口：这一行不显示 */ }
    };
    once();
    const t = setInterval(once, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const A = acc.current;
      const ss = getSamples();
      for (const s of ss) {
        if (s.host <= A.lastHost || s.dev == null) continue;
        A.lastHost = s.host;
        if (A.host0 == null) A.host0 = s.host;
        const off = s.dev - (performance.timeOrigin + s.host);
        const k = Math.floor((s.host - A.host0) / BUCKET_MS);
        const prev = A.buckets.get(k);
        if (prev == null || off > prev) A.buckets.set(k, off);
        if (s.host - A.host0 >= SKIP_S * 1000) {
          if (!A.n) { A.h0 = s.host; A.d0 = s.dev; }
          A.n++; A.h1 = s.host; A.d1 = s.dev;
        }
      }
      if (A.buckets.size > 3600) {           // 最多留 2 小时
        const ks = [...A.buckets.keys()].sort((a, b) => a - b);
        for (const k of ks.slice(0, ks.length - 3600)) A.buckets.delete(k);
      }
      // 最后一个桶可能才刚开始（样本少、最小延迟还没出现），画图和拟合都不要它
      const keys = [...A.buckets.keys()].sort((a, b) => a - b).slice(0, -1);
      if (!keys.length) return;
      const pts = keys.map((k) => ({ t: (k * BUCKET_MS) / 1000, off: A.buckets.get(k)! }));
      const fit = pts.filter((p) => p.t >= SKIP_S);
      let slope: number | null = null;
      if (fit.length >= 10) {
        const mt = fit.reduce((s, p) => s + p.t, 0) / fit.length, mo = fit.reduce((s, p) => s + p.off, 0) / fit.length;
        const sxx = fit.reduce((s, p) => s + (p.t - mt) ** 2, 0);
        slope = sxx > 0 ? fit.reduce((s, p) => s + (p.t - mt) * (p.off - mo), 0) / sxx : null;
      }
      const realS = (A.h1 - A.h0) / 1000, devS = (A.d1 - A.d0) / 1000;
      setSt({
        pts, nowOff: pts[pts.length - 1].off, slope,
        realHz: A.n > 10 && realS > 0 ? (A.n - 1) / realS : null,
        devHz: A.n > 10 && devS > 0 ? (A.n - 1) / devS : null,
        fitS: fit.length ? fit[fit.length - 1].t - fit[0].t : 0,
      });
    }, 2000);
    return () => clearInterval(t);
  }, [getSamples]);

  if (!st) return null;
  const driftPct = st.slope != null ? st.slope / 10 : null;      // ms/s → %
  const boardSrv = st.nowOff != null && srv ? st.nowOff - srv.off : null;

  // 图：偏差随时间，纵轴减掉第一个点，只看变化
  const W = 600, H = 120, P = 4;
  const base = st.pts[0].off;
  const ys = st.pts.map((p) => p.off - base);
  const tMax = Math.max(1, st.pts[st.pts.length - 1].t);
  const yMin = Math.min(0, ...ys), yMax = Math.max(1, ...ys);
  const X = (t: number) => P + (t / tMax) * (W - 2 * P);
  const Y = (v: number) => H - P - ((v - yMin) / (yMax - yMin || 1)) * (H - 2 * P);
  const line = st.pts.map((p, i) => `${X(p.t).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");

  let verdict: React.ReactNode = <>再连一会儿（去掉前 {SKIP_S} 秒后要 20 秒以上）才能算出板子时钟快慢</>;
  if (driftPct != null && st.fitS >= 20) {
    if (Math.abs(driftPct) < 0.5) {
      verdict = <>板上时间跟真实时间<b>同步走</b>（差 {driftPct.toFixed(2)}%），时间戳可信：
        按时间戳算的 {st.devHz?.toFixed(2) ?? "-"} Hz 就是传感器真实的速率{st.devHz && Math.abs(st.devHz / expectHz - 1) > 0.02 ? <>，<b>跟 {expectHz} Hz 对不上是传感器本身的问题</b>（ODR 配置 / 内部振荡器）</> : null}。</>;
    } else {
      verdict = <>板子时间戳比真实时间<b>走{driftPct > 0 ? "快" : "慢"} {Math.abs(driftPct).toFixed(1)}%</b>（每分钟{driftPct > 0 ? "快" : "慢"} {Math.abs(driftPct * 0.6).toFixed(1)} 秒）：
        <b>是时间戳的问题，不是采样的问题</b>。真实采样率按真实时间数：{st.realHz?.toFixed(2) ?? "-"} 个/秒。
        查固件给样本打时间的方式（时钟源不准，或按固定周期给每帧填时间）。</>;
    }
  }

  return (
    <Card size="small" title="板上时间 vs 电脑时间 vs 服务器时间" style={{ marginTop: 12 }}>
      <Space size={24} wrap>
        <Statistic title="板子比电脑" value={st.nowOff != null ? fmtOff(st.nowOff) : "-"} valueStyle={{ fontSize: 20 }} />
        {srv && <Tooltip title={`往返 ${srv.rtt.toFixed(0)} ms，误差在它一半以内`}>
          <span><Statistic title="电脑比服务器" value={fmtOff(-srv.off)} valueStyle={{ fontSize: 20 }} /></span>
        </Tooltip>}
        {boardSrv != null && <Statistic title="板子比服务器" value={fmtOff(boardSrv)} valueStyle={{ fontSize: 20 }} />}
        <Statistic title="板子时钟快慢" value={driftPct == null ? "-" : `${driftPct >= 0 ? "+" : ""}${driftPct.toFixed(2)}%`}
          valueStyle={{ fontSize: 20, color: driftPct != null && Math.abs(driftPct) >= 0.5 ? token.colorError : undefined }} />
      </Space>
      <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4 }}>
        去掉前 {SKIP_S} 秒（{st.fitS.toFixed(0)} 秒）：真实时间里每秒 {st.realHz?.toFixed(2) ?? "-"} 个 · 按板子时间戳 {st.devHz?.toFixed(2) ?? "-"} Hz
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, marginTop: 6, background: token.colorFillQuaternary, borderRadius: 4 }}>
        {SKIP_S < tMax && <rect x={P} y={0} width={X(SKIP_S) - P} height={H} fill={token.colorFillSecondary} />}
        <polyline points={line} fill="none" stroke={token.colorPrimary} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: token.colorTextTertiary }}>
        <span>0 秒（灰色 = 刚连上的积压，不算）</span>
        <span>纵轴：板子比电脑多走的时间，从 0 起 · {yMax - yMin >= 1000 ? `${((yMax - yMin) / 1000).toFixed(1)} 秒` : `${(yMax - yMin).toFixed(0)} ms`} 范围</span>
        <span>{tMax.toFixed(0)} 秒</span>
      </div>
      <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.8 }}>{verdict}</div>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        线是平的 = 板子时钟准；一直往上爬 = 板子走快，往下 = 走慢（坡度就是快慢多少）。
        {isPc && st.nowOff != null && Math.abs(st.nowOff) > 5000 ? "板子跟电脑差好几秒以上：多半没校时，点上面「校时」。" : ""}
        蓝牙延迟只会让样本晚到，每 2 秒取最早到的那个，所以这条线不受蓝牙成批送的影响。
      </Typography.Text>
    </Card>
  );
}
