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
  room_options: CamCheckRoom[];
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
  dog_id: number | null;
  dog_name: string | null;
  room: number | null;
  /** 自己那间的画面录在哪个录制机位（对应界面上的「录制 camN」列） */
  cam: number | null;
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

export interface CamCheckSite {
  key: string;
  name: string;
  active: boolean;
}

export interface CamCheckSegment extends CamCheckSession {
  segment_key: string;
  /** 这一段包含的 session（两台机器各一个），应用时分别下发 */
  session_keys: string[];
}

export interface CamCheckOut {
  dates: string[];
  date: string | null;
  sites: CamCheckSite[];
  sessions: CamCheckSession[];
  segments: CamCheckSegment[];
}

export interface CamMapBatchResult {
  session_key: string;
  updated: number;
  missing_rooms: number[];
}

/** 配对 IMU 分开录的场次：跟着选中段一起改的那些 */
export interface CamMapBatchExtra extends CamMapBatchResult {
  imus: number[];
}

export interface CamMapBatchOut {
  updated: number;
  results: CamMapBatchResult[];
  extra: CamMapBatchExtra[];
  failed: { session_key: string; error: string }[];
}

/** 标注工作台里就地核对：这份样本这一场有几路画面、这只狗该在哪一间 */
export interface CamSampleCam {
  recorded_cam: number;
  real_cam: number;
  path: string;
  media_id: number | null;
  /** 跨采集机的机位：这一路第 0 秒相对本样本原点的毫秒数（同场为 0） */
  offset_ms?: number;
  room_options: CamCheckRoom[];
}

export interface CamSampleCams {
  applicable: boolean;
  reason?: string;
  sample_id?: number;
  sample_code?: string;
  session_key?: string;
  /** 这一段的几场（两台采集机）：跨机纠正时一起保存 */
  session_keys?: string[];
  date?: string | null;
  site?: string | null;
  site_name?: string;
  room?: number | null;
  room_label?: string | null;
  current_recorded_cam?: number | null;
  rooms?: CamCheckRoom[];
  mapping?: Record<string, number>;
  cams?: CamSampleCam[];
}

export const getSampleCams = (sampleId: number) =>
  request.get<never, CamSampleCams>(`/cam-map/sample/${sampleId}`);

export const listCamSessions = (date?: string, site?: string) =>
  request.get<never, CamCheckOut>("/cam-map/sessions", {
    params: {
      ...(date ? { date } : {}),
      ...(site ? { site } : {}),
    },
  });

export const saveCamBatch = (date: string, mapping: Record<string, number>, sessionKeys: string[]) =>
  request.put<never, CamMapBatchOut>("/cam-map/batch", {
    date,
    mapping,
    session_keys: sessionKeys,
  });

export const saveCamMap = (sessionKey: string, mapping: Record<string, number>) =>
  request.put<never, { updated: number; missing_rooms: number[] }>(
    `/cam-map/sessions/${encodeURIComponent(sessionKey)}`,
    { mapping }
  );

export const resetCamMap = (sessionKey: string) =>
  request.delete<never, { updated: number }>(`/cam-map/sessions/${encodeURIComponent(sessionKey)}`);
