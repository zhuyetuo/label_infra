import request from "@/utils/request";

/** 超级管理员勾了「我也看遮罩版」（项目 → 隐私遮罩里）：取视频时要遮罩版，看看效果。对别人没影响 */
export const PREVIEW_MASK_KEY = "privacy-preview-mask";
const wantMask = () => {
  try { return localStorage.getItem(PREVIEW_MASK_KEY) === "1"; } catch { return false; }
};
export const getMediaToken = (fileId: number) =>
  request.post<never, { token: string }>(`/media/${fileId}/token`, undefined, wantMask() ? { params: { view: "mask" } } : undefined);

export const mediaStreamUrl = (fileId: number, token: string) =>
  `${mediaOrigin()}/api/v1/media/${fileId}/stream?token=${token}`;

/** 视频流走单独一个端口（见 nginx/default.conf 的 8285）：
 *  网页和接口都在 8284，Chrome 对同一个源最多开 6 个连接，循环播放时视频分片
 *  一直占着几条，保存、刷新列表这些接口就得排队。只在线上（8284 打包版）换端口，
 *  开发服务器（npm run dev 也是 8284，但没有 8285）和 https 反代仍然用同源相对路径。 */
const MEDIA_PORT = 8285;
function mediaOrigin(): string {
  const { protocol, hostname, port } = window.location;
  return import.meta.env.PROD && protocol === "http:" && port === "8284"
    ? `${protocol}//${hostname}:${MEDIA_PORT}`
    : "";
}
