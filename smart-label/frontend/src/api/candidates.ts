import request from "@/utils/request";

/** 疑似抓挠候选：AI 低门槛抽出来的、正式片段里没有的段，给人工确认/排除 */
export interface AiCandidate {
  id: number;
  task_id: number;
  round_no: number;
  label_name: string;
  start_time_ms: number;
  end_time_ms: number;
  confidence: number | null;
  /** 陀螺仪 4–8Hz 能量占比，抓挠的独立物理证据 */
  spec: number | null;
  /** low_conf=模型低置信 / spectral=频谱像抓挠但模型没判 */
  reason: "low_conf" | "spectral";
  status: "pending" | "confirmed" | "rejected";
  /** 确认成了哪个类别；空 = 就是抓挠，有值 = 人看完判成别的动作 */
  decided_label_id: number | null;
  decided_by: number | null;
  decided_at: string | null;
}

export const listCandidates = (taskId: number) =>
  request.get<never, AiCandidate[]>("/candidates", { params: { task_id: taskId } });

export const decideCandidate = (id: number, decision: AiCandidate["status"], labelId?: number) =>
  request.post<never, AiCandidate>(`/candidates/${id}/decide`, { decision, label_id: labelId ?? null });
