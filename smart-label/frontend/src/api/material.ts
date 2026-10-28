import request from "@/utils/request";

export type Album = "oral" | "skin";

export interface MaterialPhoto { rel_path: string; filename: string; size_bytes: number }
export interface MaterialDogFolder { name: string; photos: MaterialPhoto[] }
export interface MaterialDateFolder { folder: string; date: string | null; ok: boolean; source?: string; dogs: MaterialDogFolder[] }
/** 每个来源（视频问诊 / 雷喏斯达 / 博朗旺…）扫到多少张、多少张分不出是口腔还是皮肤 */
export interface MaterialSource { source: string; path: string; photos: number; unclassified: number; examples: string[] }

/** 素材库相册（日期 > 狗 > 照片）：oral=口腔验证，skin=颈圈算法验证/皮肤瘙痒/视频问诊 */
export const listMaterialPhotos = (album: Album) => request.get<never, { root: string; folders: MaterialDateFolder[]; sources?: MaterialSource[] }>(`/material/${album}/photos`);
export const getMaterialPhotoToken = (album: Album, path: string) => request.post<never, { token: string }>(`/material/${album}/photos/token`, { path });
export const materialPhotoUrl = (album: Album, path: string, token: string) =>
  `/api/v1/material/${album}/photos/stream?path=${encodeURIComponent(path)}&token=${token}`;
