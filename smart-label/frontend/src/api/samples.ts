import request from "@/utils/request";
import type { Sample } from "@/types";

export const listSamples = () => request.get<never, Sample[]>("/samples");

/** 现在只用来手动关联到哪只狗（采集端文件名还没带 dog 编号之前只能这样补） */
export const updateSample = (id: number, body: { dog_id: number | null }) =>
  request.patch<never, Sample>(`/samples/${id}`, body);

export interface SampleMedia {
  video1_id: number | null;
  video2_id: number | null;
  video3_id: number | null;
  csv_id: number | null;
  video_fps: number | null;
}

export const getSampleMedia = (sampleId: number) =>
  request.get<never, SampleMedia>(`/samples/${sampleId}/media`);

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
