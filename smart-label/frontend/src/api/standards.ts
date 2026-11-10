import request from "@/utils/request";

export interface StandardFile { name: string; size_bytes: number; mtime: string; token: string }
/** 评级标准原件（兽医的 PPT / PDF）在 NAS 上的各个版本，最新的在前 */
export const listStandards = (kind: "skin") => request.get<never, { dir: string; files: StandardFile[] }>(`/standards/${kind}`);
export const standardFileUrl = (kind: "skin", f: StandardFile) =>
  `/api/v1/standards/${kind}/file?name=${encodeURIComponent(f.name)}&token=${f.token}`;
/** 网页里直接看（PPT 后端转成 PDF） */
export const standardViewUrl = (kind: "skin", f: StandardFile) =>
  `/api/v1/standards/${kind}/view?name=${encodeURIComponent(f.name)}&token=${f.token}`;
export const uploadStandard = (kind: "skin", file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  return request.post<never, { name: string }>(`/standards/${kind}/upload`, fd, { timeout: 300_000 });
};
