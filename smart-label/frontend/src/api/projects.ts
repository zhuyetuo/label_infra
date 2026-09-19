import request from "@/utils/request";
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

// ── 画面找片段（视觉大模型走 API） ───────────────────────────────────

export interface VisionSeekProgress {
  status: "idle" | "running" | "done" | "cancelled" | "error";
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
  /** 视觉服务那边找片段能不能用（没配 key / 没起服务）；providers 有值 = 新版，支持选模型 */
  service?: { available: boolean; error?: string | null; model?: string; providers?: string[] };
}

export interface VisionSeekRequest {
  task_ids?: number[];
  /** 只找这几个父类（舔身体/啃身体/抓挠/蹭身体）；留空 = 项目里有的全找 */
  labels?: string[];
  cam?: "cam1" | "cam2" | "cam3";
  /** 每个视频最多送多少段去问模型——花费上限 */
  max_clips?: number;
  min_conf?: number;
  /** 只做本地筛选、不问模型、不写候选：先看会送多少段 */
  dry_run?: boolean;
  /** 用哪家的哪个模型（「大模型 API」页配的）；不传 = 视觉服务环境变量里那把 Claude key */
  provider?: string;
  model?: string;
}

export const startVisionSeek = (id: number, body: VisionSeekRequest) =>
  request.post<never, { started: boolean }>(`/projects/${id}/vision-seek`, body);

export const getVisionSeekStatus = (id: number) =>
  request.get<never, VisionSeekProgress>(`/projects/${id}/vision-seek/status`);

export const cancelVisionSeek = (id: number) =>
  request.post<never, { stopped: boolean }>(`/projects/${id}/vision-seek/cancel`);


// ── 画面向量索引（以图搜图 / 一句话搜的前提） ────────────────────────

export interface VisionIndexProgress {
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
export const startVisionIndex = (id: number, body: { task_ids?: number[]; cam?: string; force?: boolean }) =>
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
