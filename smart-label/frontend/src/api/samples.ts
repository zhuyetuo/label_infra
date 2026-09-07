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

export interface SampleMedia {
  video1_id: number | null;
  video2_id: number | null;
  video3_id: number | null;
  csv_id: number | null;
  video_fps: number | null;
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
export const aiPrelabel = (sampleId: number, mode: "stable" | "viterbi" | "raw" = "stable") =>
  request.post<never, PrelabelResult>(`/samples/${sampleId}/ai-prelabel`, undefined, {
    timeout: 180_000,
    params: { mode },
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
