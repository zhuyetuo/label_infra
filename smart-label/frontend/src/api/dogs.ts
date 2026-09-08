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
