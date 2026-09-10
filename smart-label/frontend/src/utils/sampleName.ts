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
  /** 结束时间是不是已经跨到第二天了（23:30 开始录一小时那种） */
  endsNextDay: boolean;
  imu: string; // imu1 / 其它
}

const CODE_RE = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?/;

const pad = (n: number) => String(n).padStart(2, "0");
// 跨零点的录制（23:30 开始录一小时）算出来是 86400 秒往上，直接格式化会得到
// "24:30:00" 这种不存在的时间。狗场是按整点切片通宵录的，每天都要撞上一次。
// 对 24 小时取模回到真实时间，跨没跨天由调用方另外标。
const hms = (sec: number) => {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
};

export function parseSampleTime(code: string | null | undefined, durationSec?: number | null): SampleTime | null {
  const m = CODE_RE.exec(code ?? "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const startSec = Number(h) * 3600 + Number(mi) * 60 + Number(s);
  const endSec = durationSec != null && durationSec > 0 ? startSec + durationSec : null;
  return {
    date: `${y}-${mo}-${d}`,
    start: `${h}:${mi}:${s}`,
    end: endSec != null ? hms(endSec) : null,
    endsNextDay: endSec != null && endSec >= 86400,
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
 * 列表里显示用的样本名："09:42:46 ~ 09:59:59"。
 *
 * 默认不带日期：任务列表是按项目展开的，项目名本身就是日期，重复一遍是噪声。
 *
 * withDate 用在看不到项目名的地方——工作台标题就是，那里只有任务号、狗、样本
 * 时间，"哪一天"根本无从得知。而且从 Label Studio 导进来的项目名是日期区间
 * （2026_7_17-2026_7_29_old），就算看得见项目名也说不出是哪天，所以"项目名就是
 * 日期"这个前提现在只对新建的项目成立。
 */
export function sampleDisplayName(
  code: string | null | undefined,
  durationSec: number | null | undefined,
  _role?: string | null | undefined,
  withDate = false
): string {
  if (!code) return "";
  const t = parseSampleTime(code, durationSec);
  if (!t) return code;
  const range = `${t.start} ~ ${t.end ?? "?"}${t.endsNextDay ? "（次日）" : ""}`;
  return withDate ? `${t.date} ${range}` : range;
}
