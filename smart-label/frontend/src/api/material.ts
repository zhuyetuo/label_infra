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
/** 一次拿一批照片的访问凭证 {路径: token}（原来一张一个请求） */
export const getMaterialPhotoTokens = (album: Album, paths: string[]) =>
  request.post<never, Record<string, string>>(`/material/${album}/photos/tokens`, { paths });
/** 缩略图地址：后端缩到长边 w 像素再给（网格里用，原图留给放大看） */
export const thumbUrl = (url: string, w = 360) => (url ? `${url}&w=${w}` : url);

/** 皮肤照片评级：S0 正常 / S1 轻度 / S2 中重度 / unsure 看不清 */
export type SkinGrade = "S0" | "S1" | "S2" | "unsure";
export interface PhotoRating {
  folder: string; dog_folder: string; user_id: number; user_name: string; user_role: string;
  grade: SkinGrade; note: string | null; updated_at: string | null;
}
export const listPhotoRatings = (album: Album) => request.get<never, PhotoRating[]>(`/material/${album}/ratings`);
/** grade 给 null = 撤销我对这只狗的评级 */
export const putPhotoRating = (album: Album, body: { folder: string; dog_folder: string; grade: SkinGrade | null; note?: string | null }) =>
  request.put<never, { grade: SkinGrade | null; note: string | null }>(`/material/${album}/ratings`, body);

/** 单张照片拍摄不合格的标记（模糊 / 太暗 / 没拍到皮肤…），汇总给狗场用 */
export type FlagReason = "blurry" | "dark" | "no_skin" | "blocked" | "far" | "other";
export interface PhotoFlag {
  folder: string; dog_folder: string; filename: string; reason: FlagReason; reason_text: string;
  note: string | null; user_name: string; updated_at: string | null;
}
export const listPhotoFlags = (album: Album) =>
  request.get<never, { reasons: Record<FlagReason, string>; flags: PhotoFlag[] }>(`/material/${album}/flags`);
/** reason 给 null = 取消这张的标记 */
export const putPhotoFlag = (album: Album, body: { folder: string; dog_folder: string; filename: string; reason: FlagReason | null; note?: string | null }) =>
  request.put<never, { reason: FlagReason | null }>(`/material/${album}/flags`, body);
