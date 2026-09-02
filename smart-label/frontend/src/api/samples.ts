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

export const importScan = () => request.post<never, ImportScanResult>("/samples/import-scan");
