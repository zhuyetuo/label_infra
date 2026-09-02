import request from "@/utils/request";
import type { Sample } from "@/types";

export const listSamples = () => request.get<never, Sample[]>("/samples");

export interface ImportScanResult {
  scanned_sessions: number;
  created: number;
  skipped_existing: number;
  verified: number;
  errors: number;
  detail: string[];
}

// 扫描要对每个新样本探测视频信息(ffprobe)，NAS上历史文件多时可能耗时较久，单独放宽超时
export const importScan = () =>
  request.post<never, ImportScanResult>("/samples/import-scan", undefined, { timeout: 300000 });
