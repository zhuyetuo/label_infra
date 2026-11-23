import request from "@/utils/request";
import type { Sample } from "@/types";

export const listSamples = () => request.get<never, Sample[]>("/samples");

/** 现在只用来手动关联到哪只狗（采集端文件名还没带 dog 编号之前只能这样补） */
export const updateSample = (
  id: number,
  body: { dog_id?: number | null; is_sensitive?: boolean; sensitive_note?: string | null }
) => request.patch<never, Sample>(`/samples/${id}`, body);

/** 一批样本一起标记/解除"含敏感隐私信息"（只有管理员能看能标） */
export const setSamplesSensitive = (sampleIds: number[], isSensitive: boolean, note?: string | null) =>
  request.patch<never, { updated: number }>("/samples/sensitive", {
    sample_ids: sampleIds,
    is_sensitive: isSensitive,
    sensitive_note: note ?? null,
  });

/** 一批样本一起关联到同一只狗；dogId 传 null = 解除关联 */
export const setSamplesDog = (sampleIds: number[], dogId: number | null) =>
  request.patch<never, { updated: number }>("/samples/dog", {
    sample_ids: sampleIds,
    dog_id: dogId,
  });

/** 删一批样本，连同它们上面的任务。NAS 上的文件不动，删的只是数据库登记 */
export const deleteSamplesBatch = (sampleIds: number[]) =>
  request.post<never, { deleted: number; tasks_deleted: number }>("/samples/batch-delete", {
    sample_ids: sampleIds,
  });

export interface SampleMedia {
  video1_id: number | null;
  video2_id: number | null;
  video3_id: number | null;
  csv_id: number | null;
  video_fps: number | null;
  /** 样本所在场地（bolangwang / yingpeng / gouchang）：影棚是公共区，不做机位纠正 */
  site?: string | null;
  /** 样本上登记的三路视频相对路径（没登记就是 null）——播不了时用来说清楚缺哪一步 */
  video_paths: (string | null)[];
  /** 登记了路径但媒体库里没有这条：文件没传上 NAS，或者传了还没被扫到 */
  video_missing_in_library: string[];
  /** 路数比该场地应有的少时的一句说明（少的是哪一种、该去做什么）。
   *  没问题时后端回 null，界面上就不出现 */
  video_note?: string | null;
  /** 三路各自的时间偏移（毫秒，跟 video_paths 同序）：**这一路的第 0 秒在样本
   *  时间轴上是第几毫秒**。0 = 同一个原点（绝大多数）。播放器必须按它换算，
   *  否则跨 session 挂过来的那一路放的是十几分钟之外的画面 */
  video_offsets_ms?: number[];
}

export const getSampleMedia = (sampleId: number) =>
  request.get<never, SampleMedia>(`/samples/${sampleId}/media`);

/** 后端已经把 AI 服务按类别分组的片段摊平、换算成相对 CSV 起点的毫秒 */
export interface PrelabelItem {
  label_name: string;
  start_time_ms: number;
  end_time_ms: number;
  confidence: number;
}

export interface PrelabelResult {
  sample_id: number;
  ai_label_path: string;
  items: PrelabelItem[];
  n_windows: number;
  skipped: number;
}

/** 同步调用 AI 服务推理，可能要等几十秒，超时放宽 */
/** mode：stable=稳定版（平滑合并后的片段，少而可信）/ raw=调试版（模型逐窗口原始输出） */
/** 这个样本现在的 AI 结果是哪个版本、哪个模型跑的、什么时候跑的 */
export interface AiLabelInfo {
  exists: boolean;
  mode?: string | null;
  model_path?: string | null;
  n_windows?: number | null;
  missing_seconds?: number | null;
  generated_at?: string | null;
}
export const getAiLabelInfo = (sampleId: number) =>
  request.get<never, AiLabelInfo>(`/samples/${sampleId}/ai-label-info`);

/** mode 可以是 stable/viterbi/raw，也可以是端侧模型 edge:<标签> */
export const aiPrelabel = (sampleId: number, mode: string = "stable", taskId?: number) =>
  request.post<never, PrelabelResult>(`/samples/${sampleId}/ai-prelabel`, undefined, {
    timeout: 180_000,
    params: { mode, ...(taskId != null ? { task_id: taskId } : {}) },
  });

export interface ScanProgress {
  status: "idle" | "running" | "done" | "error";
  total_groups: number;
  processed: number;
  created: number;
  skipped_existing: number;
  verified: number;
  errors: number;
  detail: string[];
  error_message: string | null;
  elapsed_sec: number;
  estimated_remaining_sec: number | null;
}

export const startImportScan = () =>
  request.post<never, { already_running: boolean }>("/samples/import-scan");

export const getImportScanStatus = () => request.get<never, ScanProgress>("/samples/import-scan/status");

export interface MissingFileSample {
  id: number;
  sample_code: string;
  session_date: string | null;
  task_count: number;
  import_error: string | null;
}

export interface MissingFileSamples {
  total: number;
  with_tasks: number;
  items: MissingFileSample[];
}

/** NAS 上文件已经没了的样本（当天重录过、或者人工删过原始数据），扫描时标出来的 */
export const listMissingFileSamples = () =>
  request.get<never, MissingFileSamples>("/samples/missing-files");

export const cleanupMissingFileSamples = () =>
  request.post<never, { deleted: number; tasks_deleted: number }>("/samples/missing-files/cleanup");

// ── NAS 冗余文件（采集端中间产物）──────────────────────────────────────
// 现场正常会先跑 cleanup_gouchang.sh 再上传；忘了跑的时候 NAS 上会多出未配对的
// 视频副本、meta/合并流水等。检测只读不删，清理只删能证明是同一份数据的中间文件，
// 被样本引用的路径一律跳过。

export type RedundancyCategory =
  | "unpaired_video"
  | "shared_paired_video"
  | "shared_paired_csv"
  | "meta_csv"
  | "merged_csv"
  | "imu_raw_csv";

export interface RedundancyCategoryStat {
  files: number;
  bytes: number;
  /** 真正能释放的空间：硬链接删掉不释放 */
  reclaim_bytes: number;
}

export interface RedundancyDay {
  /** YYYY-MM-DD */
  date: string;
  /** 这一天对应的日期目录（同一天可能有多个场地后缀） */
  dirs: string[];
  files: number;
  bytes: number;
  reclaim_bytes: number;
  /** 认出来是冗余、但被数据库引用所以保留下来的文件数 */
  protected: number;
  by_category: Partial<Record<RedundancyCategory, RedundancyCategoryStat>>;
}

export interface RedundancyReport {
  dates: RedundancyDay[];
  scanned_dirs: number;
  total_files: number;
  total_bytes: number;
  total_reclaim_bytes: number;
}

/** 扫一遍 NAS 的 data_raw/，按日期汇总可清理的冗余文件。只报告，不删 */
export const scanRedundancy = () =>
  request.get<never, RedundancyReport>("/samples/redundancy", { timeout: 180_000 });

export interface RedundancyCleanResult {
  deleted: number;
  freed_bytes: number;
  /** 被数据库引用、主动跳过的文件数 */
  protected: number;
  dirs: { dir: string; deleted: number; freed_bytes: number; protected: number; errors: string[] }[];
  errors: string[];
}

/** 真删除。dates 不传 = 全部日期；传了只清这几天 */
export const cleanRedundancy = (dates?: string[]) =>
  request.post<never, RedundancyCleanResult>(
    "/samples/redundancy/clean",
    { dates: dates ?? null },
    { timeout: 600_000 },
  );

// ── 画面扫描：这份样本的视频里有没有狗 ─────────────────────────────────

export type VisionVerdict = "has_dog" | "mostly_empty" | "no_dog" | "unknown" | "unscanned";

export interface VisionScanCam {
  cam: string;
  state: "ok" | "failed";
  error: string | null;
  verdict: string | null;
  /** 采样点里没狗的比例。**扫不成时为 null**——不是 0 也不是 1 */
  no_dog_ratio: number | null;
  max_dogs: number | null;
  sampled: number | null;
  duration_sec: number | null;
  weights: string | null;
  scanned_at: string | null;
}

export interface DogPresence {
  /** present 在画面里 / absent 不在 / unknown 判不了（reason 一定说清楚为什么）*/
  state: "present" | "absent" | "unknown";
  reason: string;
}

/** 已扫过的样本 → 结论。**没扫过的不在这个表里**，调用方据此显示"未扫描" */
export const listVisionScans = () =>
  request.get<never, Record<string, {
    verdict: VisionVerdict;
    presence: DogPresence;
    dog_name: string | null;
    cams: VisionScanCam[];
  }>>("/samples/vision-scans");

export const runVisionScan = (sample_ids: number[], every_sec = 5) =>
  request.post<never, { samples: number; items: { sample_code: string; scanned: number; failed: number }[] }>(
    "/samples/vision-scan", { sample_ids, every_sec },
  );

export const getVisionScanStatus = () =>
  request.get<never, { available: boolean; error: string | null; loaded_weights?: string | null; dog_class?: number | null }>(
    "/samples/vision-scan/status",
  );

// ── 抓挠：IMU 说有的时候，画面里有没有狗 ───────────────────────────────

export interface ScratchCross {
  /** agree 对得上 / no_dog 画面里没狗（最该先看）/ unknown 判不了 */
  state: "agree" | "no_dog" | "unknown";
  reason: string;
  points: number;
}

export const scratchCrosscheck = (sampleId: number, cam?: string) =>
  request.get<never, {
    counts: Record<string, number>;
    items: { id: number; start_time_ms: number; end_time_ms: number; cross: ScratchCross }[];
    cam: string | null;
    /** 没扫过画面时**明说**——不然人会以为"一段可疑的都没有" */
    note: string | null;
  }>(`/samples/${sampleId}/scratch-crosscheck`, { params: cam ? { cam } : undefined });

/** 画面扫描的时间线（带框）：预览视频时把狗框叠在画面上复查。
 *  points 每项 [秒, 几只, [[x,y,w,h,conf], ...]]；老结果没有第三项 */
export interface VisionScanTimeline {
  every_sec: number;
  verdict: string | null;
  weights: string | null;
  points: [number, number, number[][]?][];
  /** 这段画面是在哪份样本上扫的（同一段公共区画面挂在好几份样本上，只扫一次） */
  scanned_on?: number | null;
  /** 公共区那一路：各单间在画面里的区域，预览时叠在画面上 */
  regions?: { label: string; x: number; y: number; w: number; h: number }[] | null;
}

export const getVisionScanTimeline = (sampleId: number) =>
  request.get<never, Record<string, VisionScanTimeline>>(`/samples/${sampleId}/vision-scan/timeline`);

/** 「看全场的那一路」（狗场 cam7）该补挂给哪些样本、偏移多少。**只出报告，不写库**。
 *  偏移是从文件名的开机时刻推出来的，对不对要拿两路画面上同一个瞬间核一次 */
export const sharedCamPlan = (dayDir?: string) =>
  request.get<never, {
    items: {
      sample_id: number; sample_code: string; slot: string; path: string;
      /** 这一路的第 0 秒在样本时间轴上是第几毫秒（它比样本早开就是负数） */
      offset_ms: number; own_start_ms: number; public_start_ms: number;
      /** 这一路盖住了这份样本的多少时间（0~1）。null = 缺时长算不了。
       *  **判断该不该挂看这个，不是看时间差**：同一场重叠接近满，隔壁场次几乎不重叠 */
      coverage: number | null;
    }[];
    skipped: Record<string, number>;
    day_dirs: string[];
  }>("/samples/shared-cam/plan", { params: dayDir ? { day_dir: dayDir } : {} });

/** 真写库：按上面那份报告挂上那一路并记下偏移。
 *  **建议先只跑一天**（day_dir），拿两路画面上同一个可辨认的瞬间核一眼再铺开 */
export const sharedCamApply = (dayDir?: string) =>
  request.post<never, { attached: number; skipped: Record<string, number> }>(
    "/samples/shared-cam/apply", null, { params: dayDir ? { day_dir: dayDir } : {} });

/** 这一刻的夜视增强：原样 / 只拉伸 / 多帧堆栈（配了权重再加一张模型增强的）。
 *  三张一起给，不是只给最好看的那张——判断"看不清"是哪一种要靠对比 */
export const getLowlight = (sampleId: number, params: { cam: string; t: number; window_s?: number; model?: string }) =>
  request.get<never, {
    available?: boolean; error?: string;
    raw?: string; stretch?: string; stacked?: string; model?: string;
    /** 这一帧原本用到哪一段亮度、放大了几倍。**放大到封顶还是噪点 = 没拍到东西** */
    stretch_info?: { lo: number; hi: number; gain: number };
    /** 平均了几帧、信噪比理论上涨几倍 */
    stack_info?: { frames: number; snr_gain: number; aligned: number; lo: number; hi: number; gain: number };
    /** 用的哪个权重文件。LOL_v1/v2 是照片数据集，对监控夜视不对口，出来会糊 */
    model_name?: string; model_weights?: string; model_error?: string;
  }>(`/samples/${sampleId}/lowlight`, { params, timeout: 130000 });

/** 整段夜视增强，回一串帧，前端自己轮播。
 *
 *  **抓挠是动作，单帧判不出来**——看清了"狗侧卧着"，还是不知道它在不在抓。
 *  回图片串而不是视频文件：省掉转码和临时文件，还能随手改速度、来回看。 */
export const getLowlightSeq = (
  sampleId: number,
  params: { cam: string; start: number; end: number; fps?: number; smooth?: number },
) =>
  request.get<never, {
    available?: boolean; error?: string;
    frames?: string[]; fps?: number;
    /** 整段共用的那套拉伸：用到哪一段亮度、放大几倍、几帧、滑动平均几帧 */
    info?: { lo: number; hi: number; gain: number; n: number; smooth: number; width: number };
  }>(`/samples/${sampleId}/lowlight-seq`, { params, timeout: 250000 });

/** 工作台标题上「换狗」：dog_id 传 null = 不指定（回到按设备号猜）；same_day = 同一天同一个设备号一起改 */
export const pickSampleDog = (sampleId: number, dogId: number | null, sameDay = true) =>
  request.patch<never, { updated: number; dog_label: string | null; dog_id: number | null }>(
    `/samples/${sampleId}/dog-pick`, { dog_id: dogId, same_day: sameDay });
