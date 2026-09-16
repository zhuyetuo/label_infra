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
}

/** 能筛的狗。一只狗可能有两个 IMU（轮换充电）。 */
export interface DailyStatsDog {
  dog_name: string;
  imus: string[];
}

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
