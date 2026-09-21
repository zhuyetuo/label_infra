import request from "@/utils/request";
import type { SimilarHit } from "@/api/candidates";
import type { Project } from "@/types";

export const listProjects = () => request.get<never, Project[]>("/projects");

export const createProject = (body: { name: string; description?: string }) =>
  request.post<never, Project>("/projects", body);

export const updateProject = (id: number, body: Partial<Pick<Project, "name" | "description" | "is_active">>) =>
  request.patch<never, Project>(`/projects/${id}`, body);

export const deleteProject = (id: number) => request.delete<never, null>(`/projects/${id}`);

export interface PrelabelProgress {
  status: "idle" | "running" | "done" | "cancelled" | "error";
  project_id: number;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  current_task_id: number | null;
  current_sample_code: string | null;
  detail: string[];
  unmatched_labels: string[];
  error_message: string | null;
  elapsed_sec: number;
  estimated_remaining_sec: number | null;
  ai_wait_sec: number;
  batches_done: number;
  finished_at: number | null;
}

/** 项目下待认领/标注中且没人动过的任务批量跑 AI 预标注（后台），用 status 轮询进度 */
/** 版本可以是算法服务（imu_train 的 label_service）的后处理 mode，
 *  也可以是 srv:<标签> / edge:<标签>。
 *  端侧那几个是运行时才知道的（问服务），所以只能是 string——
 *  写成联合类型的话每加一个端侧模型都要改前端代码。 */
export type InferMode = string;

export const startProjectPrelabel = (id: number, overwriteAi = false, mode: InferMode = "stable") =>
  request.post<never, { started: boolean; queued: boolean }>(`/projects/${id}/ai-prelabel`, {
    overwrite_ai: overwriteAi,
    mode,
  });

export const getProjectPrelabelStatus = (id: number) =>
  request.get<never, PrelabelProgress>(`/projects/${id}/ai-prelabel/status`);

/** 停掉正在跑的批量预标注。已发出去的那一批停不下来，是「跑完这批就停」 */
export const cancelProjectPrelabel = (id: number) =>
  request.post<never, { stopped: boolean }>(`/projects/${id}/ai-prelabel/cancel`);

/** 跑完一次记一条：总耗时、AI 等待耗时、数量，慢了好拿数字去反馈 */
export interface PrelabelRun {
  id: number;
  finished_at: string | null;
  status: string;
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  elapsed_sec: number;
  ai_wait_sec: number;
  batches: number;
  batch_size: number;
  avg_sec_per_task: number | null;
  unmatched_labels: string[];
  /** 这一批用的哪个版本（stable / viterbi / raw）和哪个模型文件 */
  mode?: string | null;
  model_path?: string | null;
  error_message: string | null;
}

export const getProjectPrelabelHistory = (id: number) =>
  request.get<never, PrelabelRun[]>(`/projects/${id}/ai-prelabel/history`);

/** 把项目下的任务一次性指派给某人；user_id 传 null 表示收回指派 */
export const assignProject = (id: number, userId: number | null, includeClaimed = false) =>
  request.post<never, { assigned: number; skipped: number }>(`/projects/${id}/assign`, {
    user_id: userId,
    include_claimed: includeClaimed,
  });

// ── 大模型看视频找动作（视觉大模型走 API） ───────────────────────────────────

export interface VisionSeekProgress {
  status: "idle" | "running" | "paused" | "done" | "cancelled" | "error";
  project_id: number;
  dry_run: boolean;
  total: number;
  processed: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** 写进去的候选条数 */
  candidates: number;
  /** 本地筛出来会送的段数（dry_run 看这个） */
  clips_candidate: number;
  /** 真送去问模型的段数 */
  clips_sent: number;
  /** 估算花了多少美元（数量级，账以 Anthropic 后台为准） */
  est_usd: number;
  current_task_id: number | null;
  current_sample_code: string | null;
  labels: string[];
  /** 用的哪家哪个模型，如 anthropic:claude-opus-5；空 = 视觉服务环境变量里那把 */
  llm: string | null;
  detail: string[];
  error_message: string | null;
  elapsed_sec: number;
  finished_at: number | null;
  /** 这一轮是不是「先筛一遍再写」 */
  review?: boolean;
  /** 待筛的段有几条（列表走 /vision-seek/found 单独取，状态里只报个数） */
  found?: number;
  /** 视觉服务那边找片段能不能用（没配 key / 没起服务）；providers 有值 = 新版，支持选模型 */
  service?: { available: boolean; error?: string | null; model?: string; providers?: string[] };
}

export interface VisionSeekRequest {
  task_ids?: number[];
  /** 只找这几个父类（舔身体/啃身体/抓挠/蹭身体）；留空 = 项目里有的全找 */
  labels?: string[];
  /** 部位送到第几层：0 不问部位 / 1 大区域 / 2 具体部位（默认）/ 3 连左右 */
  part_depth?: number;
  cam?: "cam1" | "cam2" | "cam3";
  /** 每个视频最多送多少段去问模型——花费上限 */
  max_clips?: number;
  min_conf?: number;
  /** 只做本地筛选、不问模型、不写候选：先看会送多少段 */
  dry_run?: boolean;
  /** 用哪家的哪个模型（「大模型 API」页配的）；不传 = 视觉服务环境变量里那把 Claude key */
  provider?: string;
  model?: string;
  /** 先筛一遍再写：跑完不直接写候选，把找到的段摆成一屏让人勾 */
  review?: boolean;
}

/** review 模式跑完之后待人筛的一段 */
export interface SeekFound {
  task_id: number;
  sample_code: string | null;
  path: string;
  /** 这一段在哪份样本的哪一路：左边循环播这几秒用 */
  sample_id?: number | null;
  cam?: string | null;
  label_name: string;
  start_ms: number;
  end_ms: number;
  /** 这一段的中点（秒）：取缩略图用 */
  t: number;
  confidence: number | null;
  evidence: string | null;
}

export const getVisionSeekFound = (id: number) =>
  request.get<never, { found: SeekFound[]; total: number; review: boolean }>(`/projects/${id}/vision-seek/found`);

/** 把人勾中的段写成候选（只加不删） */
export const writeVisionSeekPicks = (id: number, picks: (SeekFound & { label_name: string })[]) =>
  request.post<never, { written: number; left: number }>(`/projects/${id}/vision-seek/write`, { picks });

// ── 项目级「一句话找画面」 ─────────────────────────────────────────
// 想找「一张狗咬尾巴的图」时，人手上还没有任何样例，也不该先随便挑个任务
// 打开工作台再去里面找这个功能。这里不挑任务、不要样例帧，直接搜整个项目。

export const projectSimilarSearch = (id: number, body: {
  text: string; top_k?: number; min_score?: number; gap_s?: number;
  center?: boolean; pose_w?: number; part?: string;
}) =>
  request.post<never, {
    hits: SimilarHit[]; searched: number; missing: number; centered: boolean; pose_used: boolean;
    /** 有几路索引是旧版（没有「没抠背景」那一列），这次没搜它们 */
    old_index?: number;
    /** 这次一句话搜比的是哪一列：原图 / 抠图 */
    text_space?: string | null;
    /** 搜过的里面有几路是快档（约 12 秒一帧）：搜不到不等于素材里没有 */
    coarse?: number;
  }>(`/projects/${id}/similar-search`, body, { timeout: 120000 });

/** 勾中的帧 → 候选。[[任务号, 路径, 秒, 类别名], …]，类别各按各的 */
export const projectSimilarWrite = (id: number, picks: [number, string, number, string][], gapS?: number) =>
  request.post<never, { written: number }>(`/projects/${id}/similar-write`, { picks, gap_s: gapS });

export const startVisionSeek = (id: number, body: VisionSeekRequest) =>
  request.post<never, { started: boolean }>(`/projects/${id}/vision-seek`, body);

export const getVisionSeekStatus = (id: number) =>
  request.get<never, VisionSeekProgress>(`/projects/${id}/vision-seek/status`);

export const pauseVisionSeek = (id: number) =>
  request.post<never, { paused: boolean }>(`/projects/${id}/vision-seek/pause`);

export const resumeVisionSeek = (id: number) =>
  request.post<never, { resumed: boolean }>(`/projects/${id}/vision-seek/resume`);

export const cancelVisionSeek = (id: number) =>
  request.post<never, { stopped: boolean }>(`/projects/${id}/vision-seek/cancel`);


// ── 画面向量索引（以图搜图 / 一句话搜的前提） ────────────────────────

export interface VisionIndexProgress {
  /** 这一轮建的是哪一档：fine 每秒一帧 / fast 只取关键帧 */
  mode?: "fine" | "fast";
  /** paused：正在建的那几路建完就停在那，「继续」接着建 */
  status: "idle" | "running" | "paused" | "done" | "cancelled" | "error";
  project_id: number;
  cam: string;
  total: number;
  processed: number;
  built: number;
  cached: number;
  skipped: number;
  failed: number;
  current: string | null;
  detail: string[];
  error_message: string | null;
  elapsed_sec: number;
  finished_at: number | null;
  service?: { available: boolean; error?: string | null; model?: string; indexed_videos?: number };
}

/** cam：all = 样本有几路建几路；cam1/2/3 是样本里的槽位（视角1/2/3），不是现场摄像头编号 */
export const startVisionIndex = (id: number, body: {
  task_ids?: number[]; cam?: string; force?: boolean;
  /** fine = 每秒一帧（慢、全）；fast = 只解关键帧（快、稀，约 12 秒一帧，短动作会漏） */
  mode?: "fine" | "fast";
}) =>
  request.post<never, { started: boolean }>(`/projects/${id}/vision-index`, body);

export const getVisionIndexStatus = (id: number) =>
  request.get<never, VisionIndexProgress>(`/projects/${id}/vision-index/status`);

/** 停止：立刻，正在建的那几路也掐掉；建好的保留 */
export const cancelVisionIndex = (id: number) =>
  request.post<never, { stopped: boolean }>(`/projects/${id}/vision-index/cancel`);

export const pauseVisionIndex = (id: number) =>
  request.post<never, { paused: boolean }>(`/projects/${id}/vision-index/pause`);

export const resumeVisionIndex = (id: number) =>
  request.post<never, { resumed: boolean }>(`/projects/${id}/vision-index/resume`);
