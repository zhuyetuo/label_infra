import request from "@/utils/request";

export const getMediaToken = (fileId: number) => request.post<never, { token: string }>(`/media/${fileId}/token`);

export const mediaStreamUrl = (fileId: number, token: string) => `/api/v1/media/${fileId}/stream?token=${token}`;
