import request from "@/utils/request";

export interface LabelTemplateItem {
  id?: number;
  code: string;
  display_name: string;
  color?: string | null;
  sort_order: number;
  /** 上级标签的 code（层级：舔 → 前爪 → 前左爪）。可以是模板里另一条，也可以是项目里已有的 code */
  parent_code?: string | null;
  /** 互斥轨（behavior / motion / posture / device），空 = 没分轨。同轨互斥、跨轨可以同时标 */
  track?: string | null;
}

export interface LabelTemplate {
  id: number;
  name: string;
  description: string | null;
  created_by: number;
  created_at: string;
  items: LabelTemplateItem[];
}

export const listLabelTemplates = () => request.get<never, LabelTemplate[]>("/label-templates");

export const createLabelTemplate = (body: {
  name: string;
  description?: string;
  items?: Omit<LabelTemplateItem, "id">[];
}) => request.post<never, LabelTemplate>("/label-templates", body);

/** 把某个项目现有的标签原样存成模板 */
export const saveProjectLabelsAsTemplate = (body: {
  project_id: number;
  name: string;
  description?: string;
}) => request.post<never, LabelTemplate>("/label-templates/from-project", body);

export const updateLabelTemplate = (
  id: number,
  body: { name?: string; description?: string; items?: Omit<LabelTemplateItem, "id">[] }
) => request.patch<never, LabelTemplate>(`/label-templates/${id}`, body);

export const deleteLabelTemplate = (id: number) => request.delete<never, null>(`/label-templates/${id}`);

/** 把模板套用到项目；项目里已有同 code 的标签会被跳过 */
export const applyLabelTemplate = (templateId: number, projectId: number) =>
  request.post<never, { created: number; skipped: number; skipped_codes: string[]; linked: number }>(
    `/label-templates/${templateId}/apply-to/${projectId}`
  );
