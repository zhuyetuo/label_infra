import request from "@/utils/request";

/** 跑过的 (模型, 版本)。日常统计必须按版本看——一天里的样本可能是
 *  不同版本跑的，混着加会得到一个悄悄把两版平均掉的数字。 */
export interface DailyStatsVersion {
  model_tag: string;
  mode: string;
  n_samples: number;
}

export interface DailyStatsRow {
  stat_date: string;
  /** 设备号（IMU5）。狗是**从 sample_code 解析出 IMU 再映射**的，
   *  不是 Sample.dog_id——那一列在实际数据里基本是空的。
   *  跟皮肤评估用同一套映射，免得同一个样本在两个页面上判给不同的狗。 */
  imu: string;
  dog_name: string | null;
  n_samples: number;
  n_windows: number;
  missing_seconds: number;
  /** 这一天的行有没有时长数据。label_seconds 那一列是后加的、历史不回填，
   *  所以"没有时长"和"时长是 0"要分开——前者是不知道，后者是知道。 */
  has_seconds: boolean;
  labels: string[];
  seconds: Record<string, number>;
  counts: Record<string, number>;
  /** 各类时长之和，用来跟 24 小时对。**后端算好的**——表和图各自加一遍的话
   *  会出现"表上 23 小时、图上 24 小时"。没有时长数据时是 null（不知道，不是 0）。 */
  total_seconds: number | null;
  /** 那天压根没数据的时间 = 24 小时 − 合计 − 缺数据。
   *  跟 missing_seconds **是两回事**：那个是记录期间断联缺的，
   *  这个是根本没在记（摘下来充电、当天下午才开始采）。
   *  合计超过 24 小时时是负数，照实给——负数本身就是「时间段有重叠」的信号。 */
  uncovered_seconds: number | null;
}

/** 能筛的狗。一只狗可能有两个 IMU（轮换充电）。 */
export interface DailyStatsDog {
  dog_name: string;
  imus: string[];
}

/** 狗场单间：按摄像头算的一天。同一段视频不管配了几个 IMU 只算一次 */
export interface RoomPresenceRow {
  stat_date: string;
  /** 单间的机位号（cam4 = 4 号单间） */
  cam: string;
  dog_name: string | null;
  imus: string[];
  n_videos: number;
  n_scanned: number;
  /** 还没扫画面（或扫失败）的段数，它们的时间不在 present_seconds 里 */
  n_unscanned: number;
  /** 这一天这间录了多久 */
  recorded_seconds: number;
  /** 扫过画面的那些段加起来多久 */
  scanned_seconds: number;
  /** 扫过的那些段里，画面里有狗多久 */
  present_seconds: number;
  /** 一天超过 24 小时：同一段画面以不同名字导了两遍，要查 */
  over_day: boolean;
  /** 这一天这间的每段视频，点开看画面复查 */
  videos: RoomVideo[];
}

/** 单间的一段画面。房间和狗都是从文件名 `_camN_imuM` 读的，不看样本挂的是哪个 IMU */
export interface RoomVideo {
  /** 这段画面"自己的"样本（文件名里的项圈号跟样本一致的那份），点开看画面用它 */
  sample_id: number;
  sample_code: string;
  file: string;
  /** 录制起始时刻 HH:MM:SS，文件名里没有就是 null */
  start: string | null;
  imu: string;
  dog_name: string | null;
  duration_seconds: number;
  scanned: boolean;
  present_seconds: number | null;
  /** 这段画面还挂在哪些别的样本上（轮换的另一个项圈、或者错误导入的） */
  also_on: string[];
}

export const listRoomPresence = (p: { date_from: string; date_to: string }) =>
  request.get<never, RoomPresenceRow[]>("/daily-stats/rooms", { params: p });

/** 后台补扫这段日期没扫的单间画面：串行，一段几十秒 */
export interface RoomScanJob {
  status: "idle" | "running" | "done" | "error";
  total: number;
  done: number;
  failed: number;
  current: string | null;
  date_from: string | null;
  date_to: string | null;
  error: string | null;
  elapsed_sec: number;
  estimated_remaining_sec: number | null;
}

export const startRoomScan = (p: { date_from: string; date_to: string }) =>
  request.post<never, { started: boolean; already_running: boolean; total: number }>("/daily-stats/rooms/scan", undefined, { params: p });

export const getRoomScanStatus = () => request.get<never, RoomScanJob>("/daily-stats/rooms/scan/status");

export const listDailyStatsDogs = () =>
  request.get<never, DailyStatsDog[]>("/daily-stats/dogs");

export const listDailyStatsVersions = () =>
  request.get<never, DailyStatsVersion[]>("/daily-stats/versions");

export const listDailyStats = (p: {
  date_from: string;
  date_to: string;
  model_tag: string;
  mode: string;
  /** 设备号，逗号分隔。空 = 全部狗 */
  imus?: string;
}) => request.get<never, DailyStatsRow[]>("/daily-stats", { params: p });
