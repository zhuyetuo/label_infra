import request from "@/utils/request";

export interface SkinOption { text: string; score: number; letter: string }
export interface SkinQuestion { label: string; group?: string; only_if_hair_loss?: boolean; options: SkinOption[] | string[] }
export interface SkinOptions {
  dog_names: string[];
  imu_dog_default_map: Record<string, string>;
  questions: Record<"has_hair_loss" | "color" | "odor" | "lesion" | "hair_spot" | "hair_diameter" | "coat", SkinQuestion>;
  weights: { skin_group: number; hair_group: number; c: number };
  c_tiers: Record<string, string>;
  s_tiers: Record<string, string>;
  default_stats_roots: string;
  weekly_report_columns: string[];
  weekly_autofill_indices: number[];
  ml_caveat: string;
}

export type Answers = {
  has_hair_loss?: string | null; color?: string | null; odor?: string | null; lesion?: string | null;
  hair_spot?: string | null; hair_diameter?: string | null; coat?: string | null;
};

export interface QScore {
  total: number; items: Record<string, number>; skin_group_raw: number; skin_group_score: number;
  hair_group_raw: number; hair_group_score: number; hair_questions_counted: boolean;
  red_flag_items: string[]; missing: string[]; letters: Record<string, string>; breakdown_md: string;
}
export interface CInputs {
  baseline_count: number; baseline_duration_min: number; today_count: number; today_duration_min: number;
  cluster_count: number; persistence_days: number; zn: number; zd: number; long_scratch: boolean; has_baseline: boolean;
}
export interface CResult {
  total: number; tier: string; red_flags: string[]; has_baseline: boolean; max_possible: number;
  components: Record<
    "delta" | "cluster" | "persistence" | "interruption",
    {
      score: number;
      max: number;
      red_flag: boolean;
      by?: string | null;
      ratio?: number | null;
      counted?: boolean;
      /** 这一项为什么是这个分（label_service 按规则生成，前端不重算） */
      note?: string | null;
    }
  >;
}
export interface SResult {
  total: number; c_tier: string; s_tier: string; c_score: number; c_value_used: number; c_missing: boolean;
  skin_group_raw: number; skin_group_score: number; hair_group_raw: number; hair_group_score: number; red_flags: string[];
}
export interface StatsRow {
  date: string; date_iso: string; date_label: string; imu: string; root: string; root_label: string;
  valid_wear_hours: number | null; data_quality_flag: string; event_count: number | null; total_duration_min: number | null;
  max_event_duration_sec: number | null; cluster_count: number | null; night_event_count: number | null; zn: number | null; zd: number | null;
  long_scratch: boolean; baseline_count: number | null; baseline_duration_min: number | null; n_baseline_days: number | null;
  persistence_days: number | null; has_baseline: boolean;
}
export interface ScanResult<T> { ok: boolean; rows: T[]; date_labels?: string[]; message: string }
export interface MlRow { date: string; date_raw: string; imu: string; root: string; root_label: string; infer_sub: string | null; date_label: string }
export interface MlPredict { ok: boolean; message?: string; model?: "A" | "B"; tier?: string; proba?: Record<string, number>; used_questionnaire?: boolean; missing_features?: string[]; c_tier_from_a?: string | null; caveat?: string }

export interface SkinRecord {
  id: number; dog_name: string; dog_id: number | null; fill_date: string; filler: string; imu: string | null;
  has_hair_loss: string | null; color: string | null; odor: string | null; lesion: string | null; hair_spot: string | null; hair_diameter: string | null; coat: string | null;
  q_score: number | null; c_value: number | null; c_tier: string | null; s_total: number | null; s_tier: string | null; c_inputs: CInputs | null;
  /** C 值来源：ai / human（标注平台）/ stats（stats.csv）/ manual；从标注平台拉取时两个版本都存 */
  c_source: CSource | null; c_value_ai: number | null; c_tier_ai: string | null; c_value_human: number | null; c_tier_human: string | null;
  created_by: number; created_at: string | null; updated_at: string | null;
}
export type CSource = "ai" | "human" | "stats" | "manual";
/** 标注平台联动：一行一个 (日期, IMU)，AI 版 / 人工版各一份日统计 + C 值 */
export interface LinkSide { stats: StatsRow; c_inputs: CInputs & { fill_date: string | null; dog_name: string | null; warnings: string[] }; c: { total: number | null; tier: string | null; red_flags: string[] } }
export interface LinkRow {
  date: string; imu: string;
  tasks: { total: number; approved: number; submitted: number; in_progress: number; pending: number; rejected: number; no_ai: number };
  ai_mode: string[]; ai: LinkSide | null; human: LinkSide | null; human_status: "complete" | "partial" | "none";
}
export interface LinkResult {
  rows: LinkRow[];
  warnings: string[];
  from_cache?: boolean;
  /** 这批数字是什么时候算的（缓存读的是库里最后一次更新时间） */
  computed_at?: string | null;
}
export interface WeeklyRow { id: number; imu: string; dog_name: string | null; report_date: string; data: Record<string, string | number>; updated_at: string | null }

export type LinkStaleness = {
  stale: { date: string; imu: string; changed_at: string }[];
  stale_days: string[];
  computed_days: number;
  range: { from: string; to: string } | null;
};
/** 哪些天的标注在上次算完之后又改过了。一条聚合查询，不碰 algo_service。 */
export const skinLinkStaleness = () => request.get<never, LinkStaleness>("/skin/link/staleness");

export const getSkinOptions = () => request.get<never, SkinOptions>("/skin/options");
export const skinQScore = (a: Answers) => request.post<never, QScore>("/skin/questionnaire-score", a);
export const skinCScore = (c: CInputs) => request.post<never, CResult>("/skin/c-score", c);
export const skinSTotal = (body: Answers & { c_value: number | null; c_tier_hint: string | null }) => request.post<never, SResult>("/skin/s-total", body);
export const skinStatsScan = (roots: string) => request.post<never, ScanResult<StatsRow>>("/skin/stats/scan", { roots }, { timeout: 120_000 });
export const skinStatsToC = (row: StatsRow) => request.post<never, CInputs & { fill_date: string | null; dog_name: string | null; warnings: string[] }>("/skin/stats/to-c-inputs", row);
export const skinMlScan = (roots: string) => request.post<never, ScanResult<MlRow>>("/skin/ml/scan", { roots }, { timeout: 120_000 });
export const skinMlPreview = (b: { rows: MlRow[]; date_label: string; imu: string; dog_name: string | null }) =>
  request.post<never, { ok: boolean; message?: string; empty?: boolean; features?: Record<string, unknown> }>("/skin/ml/preview", b, { timeout: 300_000 });
export const skinMlPredictC = (b: { rows: MlRow[]; date_label: string; imu: string; dog_name: string | null }) => request.post<never, MlPredict>("/skin/ml/predict-c", b, { timeout: 300_000 });
export const skinMlPredictS = (b: { rows: MlRow[]; date_label: string; imu: string; dog_name: string | null; answers: Answers }) => request.post<never, MlPredict>("/skin/ml/predict-s", b, { timeout: 300_000 });

export const skinLinkStats = (p: { date_from: string; date_to: string; project_id?: number | null; ai_min_conf?: number; include_drafts?: boolean; refresh?: boolean }) =>
  request.get<never, LinkResult>("/skin/link/stats", { params: p, timeout: 300_000 });
/** 标注平台上现在有任务的数据覆盖范围。每日跟踪表的日期默认跟着它走 */
export const getSkinDataRange = () =>
  request.get<never, { date_from: string | null; date_to: string | null }>("/skin/data-range");

/** 清理「项目联动」存下来的日统计。dry_run 只数不删，用来在确认框里显示影响面 */
export const purgeSkinDailyStats = (b: {
  date_from?: string | null;
  date_to?: string | null;
  only_orphan?: boolean;
  dry_run?: boolean;
}) => request.post<never, { deleted: number; dates: string[]; dry_run: boolean }>("/skin/daily-stats/purge", b);

export const listSkinRecords = () => request.get<never, SkinRecord[]>("/skin/records");
export const saveSkinRecord = (body: Partial<SkinRecord> & { dog_name: string; fill_date: string; filler: string; confirm_overwrite?: boolean }) =>
  request.post<never, SkinRecord>("/skin/records", body);
export const deleteSkinRecord = (id: number) => request.delete<never, null>(`/skin/records/${id}`);

export const listWeekly = (imu?: string) => request.get<never, WeeklyRow[]>("/skin/weekly", { params: imu ? { imu } : {} });
export const weeklyDefaults = (b: { imu: string; report_date: string; data: Record<string, unknown> }) => request.post<never, Record<string, string>>("/skin/weekly/defaults", b);
export const upsertWeekly = (b: { imu: string; report_date: string; dog_name?: string | null; data: Record<string, unknown> }) => request.post<never, WeeklyRow>("/skin/weekly", b);
export const deleteWeekly = (id: number) => request.delete<never, null>(`/skin/weekly/${id}`);
export const weeklyAutofill = (b: { imu: string; dog_name?: string | null; stats_rows: StatsRow[]; date_labels: string[] }) =>
  request.post<never, { filled: number; skipped: string[] }>("/skin/weekly/autofill", b, { timeout: 300_000 });
export const weeklyRecomputeAll = (imu?: string) => request.post<never, { count: number }>("/skin/weekly/recompute-all", undefined, { params: imu ? { imu } : {} });

/** 每日跟踪：一行 = (日期, 狗)，C 值 → 是否触发问答 → S 总分（不填问答 / 填了问答两份） */
export interface CSide {
  c_value: number | null;
  c_tier: string | null;
  /** 算 C 用的那几个输入（今天几次/几分钟、基线、聚集、连续天数、ZN/ZD…） */
  c_inputs: Record<string, number | boolean | string | null> | null;
  /** 四个打分项各得了多少分、有没有红旗，跟踪表 tooltip 讲「这分怎么来的」用 */
  c_detail: CResult | null;
}
/** S 总分：除了总分/档位，还带各部分各贡献了多少 */
export interface STotalOut {
  total: number | null;
  s_tier: string | null;
  c_tier: string | null;
  c_score?: number | null;
  c_value_used?: number | null;
  c_missing?: boolean;
  skin_group_raw?: number | null;
  skin_group_score?: number | null;
  hair_group_raw?: number | null;
  hair_group_score?: number | null;
  red_flags?: string[];
}
export interface TrackingRow {
  date: string;
  imu: string;
  dog_name: string;
  stats: Record<string, number | string | boolean | null>;
  baseline_count: number | null;
  baseline_duration_min: number | null;
  n_baseline_days: number | null;
  /** NAS 上实际的狗目录名，弹窗按它筛图（跟 PM 狗名可能不一样） */
  photo_dog: string | null;
  /** 这天这只狗底下的任务，点进去复看标注用 */
  tasks_detail: {
    task_id: number;
    sample_code: string;
    status: string;
    scratch_segments: number;
    video_duration_sec: number | null;
    /** 人工复看这个时段抓挠的结论：确认了几段、判待定几段（三种原因分开数）、
     *  还有几段本来是 AI 标的抓挠被改成了别的类别 */
    confirmed: number;
    uncertain_no_view: number;
    uncertain_ambiguous: number;
    /** 是抓挠但起止要调/要拆细，暂时没时间弄 */
    uncertain_needs_split: number;
    relabeled: number;
    /** 「疑似抓挠」候选的处理进度 */
    cand_pending: number;
    cand_confirmed: number;
    cand_relabeled: number;
    cand_rejected: number;
    cand_uncertain: number;
    cand_uncertain_no_view: number;
    cand_uncertain_ambiguous: number;
    cand_uncertain_needs_split: number;
  }[];
  c_ai: CSide | null;
  c_human: CSide | null;
  c_source: "human" | "ai" | null;
  c_value: number | null;
  c_tier: string | null;
  delta_c: number | null;
  question_triggered: boolean;
  has_answers: boolean;
  record_id: number | null;
  q_score: number | null;
  filler: string | null;
  photo_count: number;
  s_no_q: STotalOut | null;
  s_with_q: STotalOut | null;
}
export interface TrackingResult { rows: TrackingRow[]; warnings: string[]; trigger_tiers: string[] }

export const skinDailyTracking = (p: { date_from: string; date_to: string; c_prefer?: "human" | "ai" }) =>
  request.get<never, TrackingResult>("/skin/daily-tracking", { params: p, timeout: 300_000 });
