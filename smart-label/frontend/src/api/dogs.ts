import request from "@/utils/request";

export interface Dog {
  id: number;
  dog_code: string;
  name: string | null;
  breed: string | null;
  /** 这只狗戴的哪个机位（IMU1…）；留空按 dog_code 推断 */
  imu: string | null;
  /** 别名，逗号分隔：NAS 照片目录名、拼音、小名 */
  aliases: string | null;
  /** 场所：影棚 / 狗场 */
  site: string | null;
  /** 出生日期。年龄不存数字存生日——存「3岁」第二年就错了 */
  birth_date: string | null;
  remark: string | null;
  /** 下面几个是后端算出来的：年龄、最新一次的体重/颈围 */
  age_text: string | null;
  latest_weight_kg: number | null;
  latest_neck_cm: number | null;
  latest_measured_on: string | null;
  n_measurements: number;
  /** NAS 上存了几张照片 */
  n_photos: number;
  created_at: string;
}

export const listDogs = () => request.get<never, Dog[]>("/dogs");

export const createDog = (body: {
  dog_code: string;
  name?: string;
  breed?: string;
  imu?: string;
  aliases?: string;
  site?: string;
  birth_date?: string;
  remark?: string;
}) =>
  request.post<never, Dog>("/dogs", body);

export const updateDog = (id: number, body: Partial<Pick<Dog, "name" | "breed" | "imu" | "aliases" | "site" | "birth_date" | "remark">>) =>
  request.patch<never, Dog>(`/dogs/${id}`, body);

export const deleteDog = (id: number) => request.delete<never, null>(`/dogs/${id}`);

/** 一次称重/量围度。体重会变，所以按次记录，不是狗身上的一个字段 */
export interface DogMeasurement {
  id: number;
  dog_id: number;
  measured_on: string;
  weight_kg: number | null;
  neck_cm: number | null;
  note: string | null;
  created_at: string;
}

export const listMeasurements = (dogId: number) =>
  request.get<never, DogMeasurement[]>(`/dogs/${dogId}/measurements`);
export const addMeasurement = (
  dogId: number,
  body: { measured_on: string; weight_kg?: number | null; neck_cm?: number | null; note?: string }
) => request.post<never, DogMeasurement>(`/dogs/${dogId}/measurements`, body);
export const deleteMeasurement = (dogId: number, id: number) =>
  request.delete<never, null>(`/dogs/${dogId}/measurements/${id}`);

/** 一张照片或一段视频。token 是签名的，直接拼进 <img>/<video> 的 src 用 */
export interface DogPhoto {
  filename: string;
  kind: "image" | "video";
  size_bytes: number;
  uploaded_at: string;
  token: string;
}

export const listDogPhotos = (dogId: number) => request.get<never, DogPhoto[]>(`/dogs/${dogId}/photos`);

export const uploadDogPhoto = (dogId: number, file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  // 关掉超时：全局是 15s，几百 MB 的视频从局域网传上去也不止 15s，
  // 不关的话大文件必然在传到一半时被 axios 掐断
  return request.post<never, { filename: string; token: string }>(`/dogs/${dogId}/photos`, fd, { timeout: 0 });
};

export const deleteDogPhoto = (dogId: number, filename: string) =>
  request.delete<never, null>(`/dogs/${dogId}/photos/${encodeURIComponent(filename)}`);

/** <img>/<video> 带不了 Authorization 头，所以走 URL 里的签名 token；后端支持 Range，视频能拖进度条 */
export const dogPhotoUrl = (dogId: number, filename: string, token: string) =>
  `/api/v1/dogs/${dogId}/photos/${encodeURIComponent(filename)}/stream?token=${token}`;
