/**
 * 设备调试页用的 IMU 协议：自制项圈（HICC_PetCollar 行为识别固件，协议 v2.0）和 WitMotion WT901。
 * 纯函数、不碰浏览器 API，方便单独测。
 *
 * 跟 witmotion_imu 仓库里的 Python 是同一套：
 *   自制项圈  petcollar_rate_monitor.py（帧格式 / DP / 校时 / 确认 / 采样率评估）
 *   WitMotion wit_parse.py 的 StreamingByteBuffer / parse_one_packet（0x55 0x61 28 字节、0x55 0x60 14 字节）
 */

// ── 自制项圈 ──────────────────────────────────────────────────────────────
export const PC = {
  name: "HICC_PetCollar",
  service: "a6ed0201-d344-460a-8075-b9e8ec90d71b",
  tx: "a6ed0202-d344-460a-8075-b9e8ec90d71b",   // Notify: 0x06 校时请求 / 0x07 当前行为 / 0x09 片段
  tx2: "a6ed0203-d344-460a-8075-b9e8ec90d71b",  // Notify: 0x08 原始采样镜像（PB_RAW_STREAM=1 的调试固件才有）
  rx: "a6ed0204-d344-460a-8075-b9e8ec90d71b",   // Write : 校时应答 / 0x0A 确认
};
export const CMD = { TIME: 0x06, BEHAVIOR: 0x07, RAW: 0x08, SEGMENT: 0x09, ACK: 0x0a } as const;
export const DP = { TS: 0x0a, CLS: 0x30, CONF: 0x31, AX: 0x17, AY: 0x18, AZ: 0x19 } as const;
export const BEHAV_NAMES: Record<number, string> = { 0: "睡觉", 1: "未佩戴", 2: "活动", 3: "抓挠" };

const sum8 = (b: Uint8Array) => b.reduce((s, x) => (s + x) & 0xff, 0);

export function buildFrame(cmd: number, body: Uint8Array): Uint8Array {
  const f = new Uint8Array(7 + body.length);
  f.set([0x55, 0xaa, 0x00, cmd, (body.length >> 8) & 0xff, body.length & 0xff]);
  f.set(body, 6);
  f[6 + body.length] = sum8(f.subarray(0, 6 + body.length));
  return f;
}

/** 校时应答：按 UTC（协议 v2.0 §6.3） */
export function buildTimeFrame(now = new Date()): Uint8Array {
  return buildFrame(CMD.TIME, Uint8Array.from([
    0x01, (now.getUTCFullYear() - 2000) & 0xff, now.getUTCMonth() + 1, now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(),
  ]));
}

export function buildAckFrame(seq: number): Uint8Array {
  return buildFrame(CMD.ACK, Uint8Array.from([(seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff]));
}

/** 校验通过返回 {cmd, payload}，否则 null */
export function parseFrame(b: Uint8Array): { cmd: number; payload: Uint8Array } | null {
  if (b.length < 7 || b[0] !== 0x55 || b[1] !== 0xaa || b[2] !== 0x00) return null;
  const len = (b[4] << 8) | b[5];
  if (b.length < 7 + len || sum8(b.subarray(0, 6 + len)) !== b[6 + len]) return null;
  return { cmd: b[3], payload: b.subarray(6, 6 + len) };
}

/** 大端有符号整数（最多 8 字节，用 BigInt 免得丢精度，再转回 number） */
function beSigned(raw: Uint8Array): number {
  let v = 0n;
  for (const x of raw) v = (v << 8n) | BigInt(x);
  const bits = BigInt(raw.length * 8);
  if (raw.length && raw[0] & 0x80) v -= 1n << bits;
  return Number(v);
}

export function parseDps(payload: Uint8Array): Record<number, number> {
  const out: Record<number, number> = {};
  let pos = 0;
  while (pos + 4 <= payload.length) {
    const id = payload[pos], type = payload[pos + 1];
    const len = (payload[pos + 2] << 8) | payload[pos + 3];
    const raw = payload.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (type === 0x02 && raw.length) out[id] = beSigned(raw);
    else if (type === 0x04 && raw.length) out[id] = raw[0];
  }
  return out;
}

export interface PcSegment { seq: number; start: number; durS: number; cls: number; conf: number; flags: number; startMs: number | null }

/** 0x09：n(1) + n×13 字节。startMs：能换成绝对时间就给（flags bit0 = Unix 秒；都没置 = 距发送时刻的秒数），时间未知给 null */
export function parseSegments(payload: Uint8Array, nowMs = Date.now()): PcSegment[] {
  if (!payload.length) return [];
  const n = payload[0];
  const out: PcSegment[] = [];
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < n; i++) {
    const p = 1 + i * 13;
    if (p + 13 > payload.length) break;
    const seq = dv.getUint32(p), start = dv.getUint32(p + 4), dur = dv.getUint16(p + 8);
    const cls = payload[p + 10], conf = payload[p + 11], flags = payload[p + 12];
    const startMs = flags & 0x02 ? null : flags & 0x01 ? start * 1000 : nowMs - start * 1000;
    out.push({ seq, start, durS: dur / 10, cls, conf, flags, startMs });
  }
  return out;
}

// ── WitMotion ─────────────────────────────────────────────────────────────
export const WIT = {
  services: ["0000ffe5-0000-1000-8000-00805f9a34fb", "0000ffe0-0000-1000-8000-00805f9a34fb"],
  notify: ["0000ffe4-0000-1000-8000-00805f9a34fb", "0000ffe1-0000-1000-8000-00805f9a34fb", "0000ffe5-0000-1000-8000-00805f9a34fb"],
};
const ACC_RANGE = 16, GYRO_RANGE = 2000, ANGLE_RANGE = 180;

export interface WitSample { acc: [number, number, number]; gyro: [number, number, number]; angle: [number, number, number] | null; chipMs: number | null }

/** 按包头切 0x55 0x61（28 字节）/ 0x55 0x60（14 字节），不够一个包的留到下次 */
export class WitStream {
  private buf: number[] = [];
  feed(data: Uint8Array): WitSample[] {
    for (const x of data) this.buf.push(x);
    const out: WitSample[] = [];
    let i = 0;
    while (i + 1 < this.buf.length) {
      if (this.buf[i] !== 0x55) { i++; continue; }
      const t = this.buf[i + 1];
      const len = t === 0x61 ? 28 : t === 0x60 ? 14 : 0;
      if (!len) { i++; continue; }
      if (i + len > this.buf.length) break;
      const s = parseWitPacket(Uint8Array.from(this.buf.slice(i, i + len)));
      if (s) out.push(s);
      i += len;
    }
    this.buf = this.buf.slice(i);
    return out;
  }
}

export function parseWitPacket(p: Uint8Array): WitSample | null {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const i16 = (o: number) => dv.getInt16(o, true) / 32768;
  if (p.length === 14 && p[0] === 0x55 && p[1] === 0x60) {
    return { acc: [i16(2) * ACC_RANGE, i16(4) * ACC_RANGE, i16(6) * ACC_RANGE], gyro: [i16(8) * GYRO_RANGE, i16(10) * GYRO_RANGE, i16(12) * GYRO_RANGE], angle: null, chipMs: null };
  }
  if (p.length !== 28 || p[0] !== 0x55 || p[1] !== 0x61) return null;
  const [yy, mo, dd, hh, mi, ss] = Array.from(p.subarray(20, 26));
  const ms = dv.getUint16(26, true);
  const d = new Date(2000 + yy, mo - 1, dd, hh, mi, ss, ms);
  return {
    acc: [i16(2) * ACC_RANGE, i16(4) * ACC_RANGE, i16(6) * ACC_RANGE],
    gyro: [i16(8) * GYRO_RANGE, i16(10) * GYRO_RANGE, i16(12) * GYRO_RANGE],
    angle: [i16(14) * ANGLE_RANGE, i16(16) * ANGLE_RANGE, i16(18) * ANGLE_RANGE],
    chipMs: Number.isNaN(d.getTime()) || mo < 1 || mo > 12 ? null : d.getTime(),
  };
}

// ── 采样率 / 间隔评估（跟 petcollar_rate_monitor.assess 同一套口径）─────────────
export interface RateAssess {
  n: number; expectHz: number; expectMs: number; ok: boolean; problems: string[];
  rateHz?: number; spanS?: number; ivMean?: number; ivStd?: number; ivMin?: number; ivMax?: number;
  ivP5?: number; ivP95?: number; within10Pct?: number; dup?: number; gaps?: number; gapMaxMs?: number; alternating?: number;
  hostHz?: number;
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * q, lo = Math.floor(k), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
};

/** devMs：设备时间戳（毫秒，采样的真实节奏）；hostMs：浏览器收到的时间（蓝牙成批送，只看速率） */
export function assessRate(devMs: number[], hostMs: number[], expectHz: number, tol = 0.02): RateAssess {
  const expectMs = 1000 / expectHz;
  const n = devMs.length;
  const base: RateAssess = { n, expectHz, expectMs, ok: false, problems: [] };
  if (n < 3) return { ...base, problems: ["样本太少"] };
  const iv = devMs.slice(1).map((t, i) => t - devMs[i]);
  const spanS = (devMs[n - 1] - devMs[0]) / 1000;
  const rateHz = spanS > 0 ? (n - 1) / spanS : NaN;
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  const std = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
  const within = iv.filter((x) => Math.abs(x - expectMs) <= expectMs * 0.1).length;
  const dup = iv.filter((x) => x <= 0).length;
  const gaps = iv.filter((x) => x > expectMs * 1.5);
  let alt = 0;
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i - 1], b = iv[i];
    if ((a > expectMs * 1.15 && b < expectMs * 0.85) || (a < expectMs * 0.85 && b > expectMs * 1.15)) alt++;
  }
  const r: RateAssess = {
    ...base, rateHz, spanS, ivMean: mean, ivStd: std, ivMin: Math.min(...iv), ivMax: Math.max(...iv),
    ivP5: pct(iv, 0.05), ivP95: pct(iv, 0.95), within10Pct: (within / iv.length) * 100, dup,
    gaps: gaps.length, gapMaxMs: gaps.length ? Math.max(...gaps) : 0, alternating: alt,
  };
  if (hostMs.length >= 2 && hostMs[hostMs.length - 1] > hostMs[0]) {
    r.hostHz = ((hostMs.length - 1) * 1000) / (hostMs[hostMs.length - 1] - hostMs[0]);
  }
  const p: string[] = [];
  if (!(Math.abs(rateHz - expectHz) <= expectHz * tol)) p.push(`采样率 ${rateHz.toFixed(2)} Hz，跟 ${expectHz} 差 ${((rateHz / expectHz - 1) * 100).toFixed(1)}%`);
  if (r.within10Pct! < 95) p.push(`只有 ${r.within10Pct!.toFixed(0)}% 的间隔在 ${expectMs.toFixed(1)}±10% ms 内`);
  if (dup) p.push(`${dup} 次时间戳没走（0 ms 间隔）`);
  if (gaps.length) p.push(`${gaps.length} 处大缝（最长 ${r.gapMaxMs!.toFixed(0)} ms）`);
  if (alt >= Math.max(3, iv.length * 0.05)) p.push(`长短交替 ${alt} 次（一会长一会短）`);
  r.problems = p;
  r.ok = !p.length;
  return r;
}
