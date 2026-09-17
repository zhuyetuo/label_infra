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
  /** low_conf=模型低置信 / spectral=频谱像抓挠但模型没判 / grooming=姿态像舔啃（只靠加速度，跟模型无关）
   *  / vision=画面里看着像（视觉大模型看视频挑出来的，类别是项目里选的） */
  reason: "low_conf" | "spectral" | "grooming" | "vision" | "similar";
  /** 画面候选是哪家哪个模型给的，如 anthropic:claude-opus-5；IMU 来的为空 */
  model?: string | null;
  status: "pending" | "confirmed" | "rejected" | "uncertain";
  /** 确认成了哪个类别；空 = 就是抓挠，有值 = 人看完判成别的动作 */
  decided_label_id: number | null;
  /** 待定的哪一种：no_view = 画面里没拍到狗，ambiguous = 拍到了但看不准 */
  uncertain_reason: string | null;
  decided_by: number | null;
  decided_at: string | null;
}

export const listCandidates = (taskId: number) =>
  request.get<never, AiCandidate[]>("/candidates", { params: { task_id: taskId } });

/**
 * 补回「确认过但草稿里没有对应片段」的候选。
 * 曾经有一版前端的顺序把刚建的片段又删掉了，这个负责把丢的补回来；可以反复调。
 */
export const repairCandidateItems = (taskId: number) =>
  request.post<never, { repaired: number }>("/candidates/repair-items", null, { params: { task_id: taskId } });

export const decideCandidate = (
  id: number,
  decision: AiCandidate["status"],
  labelId?: number,
  uncertainReason?: string
) =>
  request.post<never, AiCandidate>(`/candidates/${id}/decide`, {
    decision,
    label_id: labelId ?? null,
    uncertain_reason: uncertainReason ?? null,
  });


/** 以图搜图 / 一句话搜（画面向量索引）→ 候选。t_s 和 text 二选一 */
export const findSimilarCandidates = (body: {
  task_id: number;
  label_name: string;
  cam?: "cam1" | "cam2" | "cam3";
  t_s?: number;
  text?: string;
  scope?: "project" | "task";
  top_k?: number;
  min_score?: number;
}) =>
  request.post<
    never,
    {
      written: number;
      hits: number;
      segments: number;
      searched: number;
      missing: number;
      per_task: { task_id: number; candidates: number }[];
      /** 落在多狗同场（影棚）任务上的候选数：画面里那只不一定是这条 IMU 的狗，确认时要看清 */
      multi_dog_candidates: number;
    }
  >("/candidates/similar", body, { timeout: 120000 });
