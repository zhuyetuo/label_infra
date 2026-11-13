export type UserRole = "super_admin" | "admin" | "annotator" | "reviewer" | "viewer";

export interface Project {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  /** 隐私遮罩开着：除超级管理员外只拿得到「狗框以外全黑」的视频 */
  privacy_mask?: boolean;
  /** 最近一次「一键遮罩」的时间：做过遮罩（开关可能关着） */
  privacy_mask_at?: string | null;
  created_by: number;
  created_at: string;
}

export interface LabelDefinition {
  id: number;
  project_id: number;
  code: string;
  display_name: string;
  color: string | null;
  /** 非空 = 颜色还跟着某个标签模板走；手动改过颜色之后会变成 null，改模板颜色就不再影响它了 */
  template_item_id: number | null;
  parent_id: number | null;
  /** 互斥轨：behavior / motion / posture / device；null = 没分轨（子标签沿用上级）。同轨互斥、跨轨可重叠 */
  track?: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface Sample {
  id: number;
  sample_code: string;
  dog_id: number | null;
  session_date: string | null;
  video_cam1_path: string;
  video_cam2_path: string | null;
  video_cam3_path: string | null;
  imu_csv_path: string;
  video_duration_sec: number | null;
  video_resolution: string | null;
  imu_row_count: number | null;
  /** 这份 CSV 的实际采样率（导入时量的）。8-11 之前是 16Hz，之后是 50Hz */
  sample_hz?: number | null;
  import_status: "pending" | "verified" | "error";
  import_error: string | null;
  /** 含敏感隐私信息：只有管理员/超级管理员能看能标 */
  is_sensitive: boolean;
  sensitive_note: string | null;
}

export type TaskStatus = "PENDING_ASSIGN" | "IN_PROGRESS" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type TaskType = "from_scratch" | "ai_assisted";

export interface Task {
  id: number;
  project_id: number;
  sample_id: number;
  task_type: TaskType;
  status: TaskStatus;
  round_no: number;
  /** 审核队列才带：这一轮什么时候交的、开始动手到提交用了多久、几段 */
  submitted_at?: string | null;
  started_at?: string | null;
  work_seconds?: number | null;
  item_count?: number | null;
  project_name?: string | null;
  /** 抓挠片段几段、其中 AI 给的还没人确认的几段；疑似候选几条、还没判的几条 */
  scratch_items?: number | null;
  scratch_pending?: number | null;
  cand_total?: number | null;
  segment_start_ms: number | null;
  segment_end_ms: number | null;
  assigned_to: number | null;
  reviewer_id: number | null;
  locked_by: number | null;
  lock_expires_at: string | null;
  created_at: string;
  /** 待认领状态下有没有上一个人留下的草稿（只有 GET /tasks 列表接口会算这个） */
  has_draft?: boolean;
  /** 当前轮草稿里已有多少段，0 = 认领了还没动手 */
  draft_item_count?: number;
  /** 打了标记的段数（当前轮） */
  mark_count?: number;
  /** 当前轮各类别段数 {label_id: {n, ai_pending}}，ai_pending = AI 给的还没人确认/改过的（只有列表接口会算） */
  label_counts?: Record<number, { n: number; ai_pending: number; approved?: number; returned?: number; max_ms?: number; ms?: number; pool?: number; uncertain?: number; /** 打了备忘、还没通过也没退回（先放着，不算还没审） */ marked?: number }>;
  /** 「疑似片段」候选：不在片段里，label_counts 统计不到，单独两个数（只有列表接口会算） */
  cand_count?: number;
  /** 同一轨上有重叠的片段数（同类重复 / 父子 / 类别冲突；只有列表接口会算） */
  overlap_count?: number;
  /** 按类别分：每类有多少段卷进了重叠 {label_id: n} */
  overlap_by_label?: Record<number, number>;
  cand_pending?: number;
  /** 候选按类别分 {类别名: {n, pending}}。候选存的是名字，不是 label_id。
   *  项目页的「含类别」要连候选一起算（不然一句话找画面刚写的那条在项目页上找不着），
   *  「疑似片段」的二级筛选选项也是它——只列实有的类别 */
  cand_labels?: Record<string, { n: number; pending: number }>;
  /** 被驳回时审核员写的意见（只有 GET /tasks 列表接口会算这个） */
  review_comment?: string | null;
  /** 样本编号 / 指派人名字：列表接口带出来，非管理员拿不到 /samples、/users 也能显示 */
  sample_code?: string | null;
  video_duration_sec?: number | null;
  /** IMU CSV 数据行数，0 = 空文件，打开工作台会报"CSV 没有数据行" */
  imu_row_count?: number | null;
  /** 这条样本是哪只狗的：「小满（IMU4）」。画面里同时有四只狗，不写清楚没法确认 */
  dog_label?: string | null;
  assigned_to_name?: string | null;
  assigned_to_role?: UserRole | null;
  /** 超时收回前指派给谁、什么时候收回的（重新认领 / 指派后清空） */
  reclaimed_from?: number | null;
  reclaimed_from_name?: string | null;
  reclaimed_at?: string | null;
}

export interface LabelItem {
  id: number;
  label_id: number;
  start_time_ms: number;
  end_time_ms: number;
  origin_item_id: number | null;
  source_type: "ai_generated" | "human_added";
  is_modified: boolean;
  ai_confidence: number | null;
  /** AI 片段是否已被人工确认为正确；人工画的恒为 false */
  ai_confirmed: boolean;
  /** 待定：看了拿不准（画面里没拍到、动作看不清），留着但不进训练集 */
  uncertain: boolean;
  /** 待定的哪一种：no_view = 画面里没拍到狗，ambiguous = 拍到了但看不准 */
  uncertain_reason: string | null;
  /** 标记（逗号分开）：compound 复合类别 / boundary 边界拿不准 / unclear 看不清狗 / av_mismatch 画面跟 IMU 对不上 / other 其它。只是记号，不影响导出 */
  marks?: string | null;
  mark_note?: string | null;
  /** 从哪条「疑似片段」候选确认上来的；有值才能「退回候选」重新判断 */
  from_candidate_id: number | null;
  created_by: number | null;
  /** AI 当初给的类别和起止（AI 生成时记下、之后不变）；人工画的、老数据为空 */
  ai_label_id?: number | null;
  ai_start_ms?: number | null;
  ai_end_ms?: number | null;
  /** 从疑似片段确认来的：那条候选当初猜的类别和来源 */
  cand_label_name?: string | null;
  cand_reason?: string | null;
  /** 审核标的「这条有问题」：原因；没有就是空 */
  review_note?: string | null;
  review_flag_by?: number | null;
  /** 起止调整记录，最早的在前：每次从哪改到哪、谁、什么时候 */
  boundary_edits?: BoundaryEdit[];
  /** 片段审核：空 = 还没审 / approved = 通过 / returned = 退回（原因在 review_note） */
  seg_status?: "approved" | "returned" | null;
  seg_reviewed_by?: number | null;
}

export interface BoundaryEdit {
  from: [number, number];
  to: [number, number];
  by?: number;
  by_name?: string;
  at?: string;
}

export interface Draft {
  round_no: number;
  items: LabelItem[];
  /** 服务器拉草稿时的时间（存草稿时带回去，防止旧版本覆盖别人刚改的） */
  server_time?: string | null;
}

export interface AppUser {
  /** 系统里存了他现在的密码（超级管理员能看） */
  has_temp_password?: boolean;
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  is_outsourced: boolean;
  is_active: boolean;
  must_change_password: boolean;
  /** 管理员之间的备注（外包/实习/入离职时间等），纯人事记录 */
  remark: string | null;
  /** 单独开的功能键（管理员不需要，什么都能用） */
  permissions: string[];
  created_at: string;
}

export interface FeatureDef {
  key: string;
  name: string;
  description: string;
}
