import request from "@/utils/request";

export interface Dog {
  id: number;
  dog_code: string;
  name: string | null;
  breed: string | null;
  remark: string | null;
  created_at: string;
}

export const listDogs = () => request.get<never, Dog[]>("/dogs");

export const createDog = (body: { dog_code: string; name?: string; breed?: string; remark?: string }) =>
  request.post<never, Dog>("/dogs", body);

export const updateDog = (id: number, body: Partial<Pick<Dog, "name" | "breed" | "remark">>) =>
  request.patch<never, Dog>(`/dogs/${id}`, body);

export const deleteDog = (id: number) => request.delete<never, null>(`/dogs/${id}`);
