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
  dog_id: number | null;
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

export const listDailyStatsVersions = () =>
  request.get<never, DailyStatsVersion[]>("/daily-stats/versions");

export const listDailyStats = (p: {
  date_from: string;
  date_to: string;
  model_tag: string;
  mode: string;
  dog_ids?: string;
}) => request.get<never, DailyStatsRow[]>("/daily-stats", { params: p });
