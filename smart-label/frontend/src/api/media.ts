import request from "@/utils/request";

/** 超级管理员勾了「我也看遮罩版」（项目 → 隐私遮罩里）：取视频时要遮罩版，看看效果。对别人没影响 */
export const PREVIEW_MASK_KEY = "privacy-preview-mask";
const wantMask = () => {
  try { return localStorage.getItem(PREVIEW_MASK_KEY) === "1"; } catch { return false; }
};
export const getMediaToken = (fileId: number) =>
  request.post<never, { token: string }>(`/media/${fileId}/token`, undefined, wantMask() ? { params: { view: "mask" } } : undefined);

export const mediaStreamUrl = (fileId: number, token: string) => `/api/v1/media/${fileId}/stream?token=${token}`;
