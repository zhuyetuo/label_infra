export type UserRole = "super_admin" | "admin" | "annotator" | "reviewer";

export interface Project {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
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
  sort_order: number;
  is_active: boolean;
}

export interface Sample {
  id: number;
  sample_code: string;
  dog_id: number | null;
  session_date: string | null;
  video_cam1_path: string;
  video_cam2_path: string;
  video_cam3_path: string | null;
  imu_csv_path: string;
  video_duration_sec: number | null;
  video_resolution: string | null;
  imu_row_count: number | null;
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
  /** 当前轮各类别段数 {label_id: {n, ai_pending}}，ai_pending = AI 给的还没人确认/改过的（只有列表接口会算） */
  label_counts?: Record<number, { n: number; ai_pending: number }>;
  /** 被驳回时审核员写的意见（只有 GET /tasks 列表接口会算这个） */
  review_comment?: string | null;
  /** 样本编号 / 指派人名字：列表接口带出来，非管理员拿不到 /samples、/users 也能显示 */
  sample_code?: string | null;
  video_duration_sec?: number | null;
  /** IMU CSV 数据行数，0 = 空文件，打开工作台会报"CSV 没有数据行" */
  imu_row_count?: number | null;
  assigned_to_name?: string | null;
  assigned_to_role?: UserRole | null;
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
  created_by: number | null;
}

export interface Draft {
  round_no: number;
  items: LabelItem[];
}

export interface AppUser {
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
  created_at: string;
}
