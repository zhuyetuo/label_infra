import request from "@/utils/request";
import type { LabelDefinition } from "@/types";

export const listLabels = () => request.get<never, LabelDefinition[]>("/label-definitions");

export const createLabel = (body: { code: string; display_name: string; color?: string; sort_order?: number }) =>
  request.post<never, LabelDefinition>("/label-definitions", body);

export const updateLabel = (id: number, body: Partial<LabelDefinition>) =>
  request.patch<never, LabelDefinition>(`/label-definitions/${id}`, body);
