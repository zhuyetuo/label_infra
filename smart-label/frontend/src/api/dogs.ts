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
  remark: string | null;
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
  remark?: string;
}) =>
  request.post<never, Dog>("/dogs", body);

export const updateDog = (id: number, body: Partial<Pick<Dog, "name" | "breed" | "imu" | "aliases" | "site" | "remark">>) =>
  request.patch<never, Dog>(`/dogs/${id}`, body);

export const deleteDog = (id: number) => request.delete<never, null>(`/dogs/${id}`);
