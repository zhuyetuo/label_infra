import request from "@/utils/request";

export interface ImuMeta {
  duration_ms: number;
  row_count: number;
  sample_rate_hz: number | null;
  start_timestamp: string | null;
}

export const getImuMeta = (sampleId: number) => request.get<never, ImuMeta>(`/imu/${sampleId}/meta`);
