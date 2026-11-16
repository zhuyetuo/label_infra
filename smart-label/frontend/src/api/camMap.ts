import request from "@/utils/request";

export interface CamCheckRoom {
  value: number;
  label: string;
}

export interface CamCheckCam {
  recorded_cam: number;
  real_cam: number;
  path: string;
  samples: number;
  media_id: number | null;
}

export interface CamCheckSlot {
  slot: string;
  path: string;
  real_cam: number | null;
}

export interface CamCheckSample {
  id: number;
  sample_code: string;
  imu: number | null;
  dog_name: string | null;
  room: number | null;
  slots: CamCheckSlot[];
}

export interface CamCheckSession {
  session_key: string;
  date: string;
  day_dir: string;
  site: string | null;
  site_name: string;
  corrected: boolean;
  rooms: CamCheckRoom[];
  cams: CamCheckCam[];
  samples: CamCheckSample[];
}

export interface CamCheckOut {
  dates: string[];
  date: string | null;
  sessions: CamCheckSession[];
}

export const listCamSessions = (date?: string) =>
  request.get<never, CamCheckOut>("/cam-map/sessions", { params: date ? { date } : undefined });

export const saveCamMap = (sessionKey: string, mapping: Record<string, number>) =>
  request.put<never, { updated: number; missing_rooms: number[] }>(
    `/cam-map/sessions/${encodeURIComponent(sessionKey)}`,
    { mapping }
  );

export const resetCamMap = (sessionKey: string) =>
  request.delete<never, { updated: number }>(`/cam-map/sessions/${encodeURIComponent(sessionKey)}`);
