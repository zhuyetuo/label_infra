import { imuOf } from "@/utils/imuOf";

/**
 * 样本编号（multicam_20260820_000000623_imu1）只有开发者看得懂。标注员/审核员/
 * 管理员看到的应该是"这段数据是哪天、几点到几点、总共多长"——挑任务的时候
 * 可以先挑时间短的。这里从编号里的 YYYYMMDD_HHMMSSmmm 解析出采集开始时间，
 * 加上视频时长算结束时间。解析不出来（编号不是这个格式）就原样返回编号。
 */
export interface SampleTime {
  date: string; // 2026-08-20
  start: string; // 00:00:00
  end: string | null; // 01:00:00，没有时长时为 null
  imu: string; // imu1 / 其它
}

const CODE_RE = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?/;

const pad = (n: number) => String(n).padStart(2, "0");
const hms = (sec: number) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(Math.floor(sec % 60))}`;

export function parseSampleTime(code: string | null | undefined, durationSec?: number | null): SampleTime | null {
  const m = CODE_RE.exec(code ?? "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const startSec = Number(h) * 3600 + Number(mi) * 60 + Number(s);
  return {
    date: `${y}-${mo}-${d}`,
    start: `${h}:${mi}:${s}`,
    end: durationSec != null && durationSec > 0 ? hms(startSec + durationSec) : null,
    imu: imuOf(code),
  };
}

/** 总时长：1小时02分 / 35分钟 / 48秒 */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}小时${m ? `${pad(m)}分` : ""}`;
  if (m) return `${m}分钟${s ? `${pad(s)}秒` : ""}`;
  return `${s}秒`;
}

/**
 * 列表里显示用的样本名，所有角色一样："09:42:46 ~ 09:59:59"。项目名本身就是
 * 日期，这里不重复；原始编号放在鼠标悬停里给开发者看。
 */
export function sampleDisplayName(
  code: string | null | undefined,
  durationSec: number | null | undefined,
  _role?: string | null | undefined
): string {
  if (!code) return "";
  const t = parseSampleTime(code, durationSec);
  if (!t) return code;
  return `${t.start} ~ ${t.end ?? "?"}`;
}
