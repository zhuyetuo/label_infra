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
  parent_id: number | null;
  sort_order: number;
  is_active: boolean;
}

export interface Sample {
  id: number;
  sample_code: string;
  dog_id: string | null;
  session_date: string | null;
  video_cam1_path: string;
  video_cam2_path: string;
  video_cam3_path: string | null;
  imu_csv_path: string;
  video_duration_sec: number | null;
  video_resolution: string | null;
  import_status: "pending" | "verified" | "error";
  import_error: string | null;
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
  role: "super_admin" | "admin" | "annotator" | "reviewer";
  is_outsourced: boolean;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
}
