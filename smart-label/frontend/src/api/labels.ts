import request from "@/utils/request";
import type { LabelDefinition } from "@/types";

export const listLabels = (projectId?: number, includeInactive = false) =>
  request.get<never, LabelDefinition[]>("/label-definitions", {
    params: {
      ...(projectId == null ? {} : { project_id: projectId }),
      ...(includeInactive ? { include_inactive: true } : {}),
    },
  });

export const createLabel = (body: {
  project_id: number;
  code: string;
  display_name: string;
  color?: string;
  sort_order?: number;
}) =>
  request.post<never, LabelDefinition>("/label-definitions", body);

export const updateLabel = (id: number, body: Partial<LabelDefinition>) =>
  request.patch<never, LabelDefinition>(`/label-definitions/${id}`, body);

export const deleteLabel = (id: number) => request.delete<never, null>(`/label-definitions/${id}`);
