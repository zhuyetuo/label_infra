import request from "@/utils/request";

/** 相册跟 material 路由同名：oral=口腔验证，skin=皮肤问诊 */
export type VisionAlbum = "oral" | "skin";

export interface VisionLabel {
  code: string;
  name: string;
  color: string;
  hotkey: string;
}

export interface VisionAttrOption {
  value: number | string;
  label: string;
}

export interface VisionAttrDef {
  key: string;
  name: string;
  /** grade = 0-3 单选；select = 枚举；tooth_code = 牙位选择器 */
  type: "grade" | "select" | "tooth_code";
  options?: VisionAttrOption[];
  help?: string;
}

export interface VisionCatalog {
  album: VisionAlbum;
  domain: "tooth" | "skin";
  labels: VisionLabel[];
  item_attrs: VisionAttrDef[];
  asset_attrs: VisionAttrDef[];
}

export type VisionAssetState = "todo" | "done" | "skipped";

export interface VisionPhoto {
  rel_path: string;
  filename: string;
  size_bytes: number;
  n_boxes: number;
  state: VisionAssetState;
}

export interface VisionDogFolder {
  name: string;
  photos: VisionPhoto[];
}

export interface VisionDateFolder {
  folder: string;
  date: string | null;
  ok: boolean;
  dogs: VisionDogFolder[];
}

/** 归一化到 0-1 的框，左上角原点 */
export type VisionBox = [number, number, number, number];

export interface VisionItem {
  id?: number;
  label_code: string;
  bbox: VisionBox;
  attrs: Record<string, number | string>;
  source?: string;
}

export interface VisionAsset {
  album: VisionAlbum;
  rel_path: string;
  state: VisionAssetState;
  skip_reason: string | null;
  attrs: Record<string, number | string>;
  width: number | null;
  height: number | null;
  updated_at: string | null;
}

export const getVisionLabels = (album: VisionAlbum) =>
  request.get<never, VisionCatalog>("/vision/labels", { params: { album } });

export const listVisionPhotos = (album: VisionAlbum) =>
  request.get<never, { album: VisionAlbum; folders: VisionDateFolder[] }>("/vision/photos", { params: { album } });

export const getVisionAnnotations = (album: VisionAlbum, path: string) =>
  request.get<never, { items: VisionItem[]; asset: VisionAsset }>("/vision/annotations", { params: { album, path } });

export const saveVisionAnnotations = (body: {
  album: VisionAlbum;
  path: string;
  items: { label_code: string; bbox: VisionBox; attrs: Record<string, number | string> }[];
  state: VisionAssetState;
  skip_reason?: string | null;
  asset_attrs?: Record<string, number | string>;
  width?: number;
  height?: number;
}) => request.put<never, { saved: number; state: VisionAssetState }>("/vision/annotations", body);

export const getVisionStats = (album: VisionAlbum) =>
  request.get<never, {
    by_label: { label_code: string; n: number }[];
    by_state: { state: string; n: number }[];
    total_boxes: number;
  }>("/vision/stats", { params: { album } });
