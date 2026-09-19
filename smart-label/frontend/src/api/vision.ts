import request from "@/utils/request";

/** 相册跟 material 路由同名：oral=口腔验证，skin=皮肤问诊 */
export type VisionAlbum = "oral" | "skin";

export interface VisionLabel {
  code: string;
  name: string;
  color: string;
  hotkey: string;
}

export interface VisionAttrOption {
  value: number | string;
  label: string;
}

export interface VisionAttrDef {
  key: string;
  name: string;
  /** grade = 0-3 单选；select = 枚举；tooth_code = 牙位选择器 */
  type: "grade" | "select" | "tooth_code";
  options?: VisionAttrOption[];
  help?: string;
  /** 只对这些类别显示；不填 = 所有类别都显示 */
  only_for?: string[];
  /** 属于口腔评估打分表的三项之一（面板上单独成一段，带总分） */
  score_item?: boolean;
}

/** 口腔评估的打分口径。**只有后端这一份**，前端照着渲染，不另抄那些数字 */
export interface VisionScoreScheme {
  name: string;
  max: number;
  items: { key: string; name: string; points: number[] }[];
  note?: string;
  todo?: string;
}

export interface VisionCatalog {
  album: VisionAlbum;
  domain: "tooth" | "skin";
  labels: VisionLabel[];
  item_attrs: VisionAttrDef[];
  asset_attrs: VisionAttrDef[];
  /** 只有 tooth 域有 */
  score_scheme?: VisionScoreScheme;
}

export type VisionAssetState = "todo" | "done" | "skipped";

export interface VisionPhoto {
  rel_path: string;
  filename: string;
  size_bytes: number;
  n_boxes: number;
  state: VisionAssetState;
  /** 口腔评估总分。三项没填全 = null（「未评」），**不是 0** */
  oral_score?: number | null;
}

export type VisionAssignmentState = "open" | "submitted" | "approved" | "rejected";

export interface VisionAssignment {
  id: number;
  album: VisionAlbum;
  group_key: string;
  assignee_id: number;
  assignee_name?: string;
  state: VisionAssignmentState;
  review_note: string | null;
  reviewed_at: string | null;
  updated_at: string | null;
}

export interface VisionDogFolder {
  name: string;
  photos: VisionPhoto[];
  group_key: string;
  assignment: VisionAssignment | null;
}

export interface VisionDateFolder {
  folder: string;
  date: string | null;
  ok: boolean;
  dogs: VisionDogFolder[];
}

/** 归一化到 0-1 的框，左上角原点 */
export type VisionBox = [number, number, number, number];

export interface VisionItem {
  id?: number;
  label_code: string;
  bbox: VisionBox;
  /** SAM 出的掩膜轮廓，归一化 [[x,y],...]；手画的框没有，为 null */
  polygon?: number[][] | null;
  attrs: Record<string, number | string>;
  source?: string;
}

export interface VisionAsset {
  album: VisionAlbum;
  rel_path: string;
  state: VisionAssetState;
  skip_reason: string | null;
  attrs: Record<string, number | string>;
  width: number | null;
  height: number | null;
  updated_at: string | null;
}

export const getVisionLabels = (album: VisionAlbum) =>
  request.get<never, VisionCatalog>("/vision/labels", { params: { album } });

export const listVisionPhotos = (album: VisionAlbum) =>
  request.get<never, { album: VisionAlbum; folders: VisionDateFolder[]; can_review: boolean; is_manager: boolean }>(
    "/vision/photos", { params: { album } },
  );

/** 图片流的 token。走 vision 自己的接口而不是 /material 的——那个是管理员专属，
 *  标注员拿不到；这里按「这张图在不在你被指派的组里」发。 */
export const getVisionPhotoToken = (album: VisionAlbum, path: string) =>
  request.post<never, { token: string }>("/vision/photos/token", { album, path });

export const listVisionAssignments = (album: VisionAlbum) =>
  request.get<never, VisionAssignment[]>("/vision/assignments", { params: { album } });

export const createVisionAssignments = (body: { album: VisionAlbum; group_keys: string[]; assignee_id: number }) =>
  request.post<never, { created: number; moved: number; locked: string[] }>("/vision/assignments", body);

export const submitVisionAssignment = (id: number) =>
  request.post<never, VisionAssignment>(`/vision/assignments/${id}/submit`);

export const reviewVisionAssignment = (id: number, body: { approve: boolean; note?: string | null }) =>
  request.post<never, VisionAssignment>(`/vision/assignments/${id}/review`, body);

export const deleteVisionAssignment = (id: number) =>
  request.delete<never, { deleted: number }>(`/vision/assignments/${id}`);

/** 给这张照片上已画好的框推 Triadan 牙位。纯几何后处理，不调模型。
 *  返回的是**建议**：界面上默认逐颗确认，不批量套用。 */
export const suggestToothCodes = (body: {
  album: VisionAlbum;
  path: string;
  view_code: string;
  jaw?: string | null;
  boxes: { label_code: string; bbox: VisionBox }[];
}) =>
  request.post<never, {
    suggestions: { index: number; tooth_code: number }[];
    verdict: "ok" | "partial" | "no_anchor" | "too_few" | "bad_view";
    reason: string;
    per_jaw: Record<string, { quadrant: number; verdict: string; reason: string; n: number; jaw_guessed: boolean }>;
  }>("/vision/tooth/suggest-codes", body);

/** SAM 辅助开着没有。没配 VISION_SERVICE_URL / 连不上 / 没装权重，都会是 available=false */
export const getSamStatus = () =>
  request.get<never, { available: boolean; error?: string | null; device?: string }>("/vision/sam/status");

/**
 * SAM 辅助分割。坐标全部归一化 0-1。
 *
 * 两种提示，**优先用框**：
 *   box    拖一个粗框，SAM 在框里收紧成贴合的轮廓
 *   points 点一下（label 1=正点 0=负点）
 *
 * 2026-09-15 实测：单点在牙齿上给不出牙齿粒度。20 张真实照片、点自动落在牙上、
 * 且已改成挑三个候选里最小的，中位数 area_ratio 仍是 0.111（整个嘴），落在
 * "一颗牙"那一档的 0 张。相邻牙同色、边界连着，SAM 没依据分"这颗"和"这排"。
 */
export const samSegment = (body: {
  album: VisionAlbum;
  path: string;
  points: { x: number; y: number; label: number }[];
  /** [x, y, w, h] 归一化。给了框就以框为准，点只作辅助 */
  box?: VisionBox;
  /** gingiva = 牙龈专用修整：SAM 的掩膜里只留粉红那部分（去掉连带的牙和嘴唇），轮廓更细 */
  refine?: "gingiva";
  /** 这张图上已经标好的别的东西的轮廓（框给四个角）：从结果里挖掉。标牙龈时传牙 */
  exclude?: number[][][];
}) =>
  request.post<never, {
    bbox: VisionBox;
    polygon: number[][] | null;
    score: number;
    /** 三个候选的大小和分数，用来判断挑得对不对 */
    candidates?: { area_ratio: number; score: number }[];
    chosen?: number;
  }>("/vision/sam/segment", body, { timeout: 60_000 });

export const listVisionAnnotators = () =>
  request.get<never, { id: number; name: string; role: string }[]>("/vision/annotators");

export const getVisionAnnotations = (album: VisionAlbum, path: string) =>
  request.get<never, { items: VisionItem[]; asset: VisionAsset }>("/vision/annotations", { params: { album, path } });

export const saveVisionAnnotations = (body: {
  album: VisionAlbum;
  path: string;
  items: { label_code: string; bbox: VisionBox; polygon?: number[][] | null; attrs: Record<string, number | string> }[];
  state: VisionAssetState;
  skip_reason?: string | null;
  asset_attrs?: Record<string, number | string>;
  width?: number;
  height?: number;
}) => request.put<never, { saved: number; state: VisionAssetState }>("/vision/annotations", body);

export interface VisionDatasetMeta {
  kind: string;
  name: string;
  album: VisionAlbum;
  domain: string;
  task: string;
  class_names: string[];
  counts: { train: number; val: number };
  negatives: { train: number; val: number };
  boxes_per_class: Record<string, number>;
  total_boxes: number;
  excluded: Record<string, number>;
  val_ratio: number;
  n_images: number;
  copied_bytes: number;
  warnings: string[];
  exported_at: string;
  exported_by: string | null;
}

/** 导出 YOLO 检测数据集，落 nas_root/data_train_vision/<name>/ */
export const exportVisionDataset = (body: { album: VisionAlbum; name: string; val_ratio: number; only_approved?: boolean }) =>
  request.post<never, VisionDatasetMeta>("/vision/export", body, { timeout: 600_000 });

export const listVisionDatasets = () => request.get<never, VisionDatasetMeta[]>("/vision/datasets");

export const deleteVisionDataset = (name: string) =>
  request.delete<never, { deleted: string }>(`/vision/datasets/${encodeURIComponent(name)}`);

export const getVisionStats = (album: VisionAlbum) =>
  request.get<never, {
    by_label: { label_code: string; n: number }[];
    by_state: { state: string; n: number }[];
    total_boxes: number;
  }>("/vision/stats", { params: { album } });
