import request from "@/utils/request";

export interface ToothDetection {
  class_id: number;
  class_name: string;
  confidence: number;
  box: [number, number, number, number];
}

export interface ToothPhotoResult {
  rel_path: string;
  folder: string;
  dog_folder: string;
  dog_id: number | null;
  detections: ToothDetection[];
  n_detections: number;
  top_class: string | null;
  top_conf: number | null;
  model_conf: number;
  width: number | null;
  height: number | null;
  detected_at: string | null;
}

export interface ToothPhoto {
  rel_path: string;
  filename: string;
  size_bytes: number;
  result: ToothPhotoResult | null;
}

export interface ToothDogFolder {
  name: string;
  photos: ToothPhoto[];
}

export interface ToothDateFolder {
  folder: string;
  date: string | null;
  ok: boolean;
  dogs: ToothDogFolder[];
}

export interface ToothDetectItem {
  rel_path: string;
  ok: boolean;
  error?: string;
  result?: ToothPhotoResult;
  annotated_jpeg_b64?: string | null;
  class_names?: string[];
}

/** 素材库 口腔验证/ 下的目录树（日期 > 狗 > 照片），每张带最近一次检测结果 */
export const listToothPhotos = () => request.get<never, { root: string; folders: ToothDateFolder[] }>("/tooth/photos");

export const getToothPhotoToken = (path: string) =>
  request.post<never, { token: string }>("/tooth/photos/token", { path });

export const toothPhotoUrl = (path: string, token: string) =>
  `/api/v1/tooth/photos/stream?path=${encodeURIComponent(path)}&token=${token}`;

/** 逐张调 AI 服务检测并落库；with_image 只在单张查看时开 */
export const detectToothPhotos = (paths: string[], opts?: { conf?: number; with_image?: boolean }) =>
  request.post<never, ToothDetectItem[]>("/tooth/detect", { paths, ...opts }, { timeout: 600_000 });

export const getToothStatus = () =>
  request.get<never, { available: boolean; weights?: string; loaded?: boolean; error?: string | null }>("/tooth/status");
