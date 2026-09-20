import request from "@/utils/request";

/** 大模型 API 的一家：key 只写不读，接口只给"配没配 + 末四位" */
export interface LlmModel {
  name: string;
  /** $/百万 token，只用来估花费 */
  price_in: number;
  price_out: number;
}

export interface LlmProvider {
  provider: "anthropic" | "openai" | "doubao" | "gemini" | "zhipu" | "local";
  display_name: string;
  has_key: boolean;
  /** 本地服务这种不需要 key */
  key_optional: boolean;
  key_hint: string | null;
  base_url: string | null;
  models: LlmModel[];
  default_model: string | null;
  enabled: boolean;
  updated_at: string | null;
}

export const listLlmProviders = () => request.get<never, LlmProvider[]>("/llm-providers");

/** 没传的字段不动；api_key 传空串 = 清掉 */
export const updateLlmProvider = (
  provider: string,
  body: Partial<{ api_key: string; base_url: string; models: LlmModel[]; default_model: string; enabled: boolean }>
) => request.put<never, LlmProvider>(`/llm-providers/${provider}`, body);

export interface LlmTestResult {
  ok: boolean;
  latency_ms: number;
  reply: string | null;
  error: string | null;
}

/** 用存着的 key 发一句最短的话，看 key 和模型名对不对（几乎不花钱） */
export const testLlmProvider = (provider: string, model?: string) =>
  request.post<never, LlmTestResult>(`/llm-providers/${provider}/test`, { model: model ?? null }, { timeout: 90000 });

/** 一段时间内的调用汇总（总 / 某家某模型 / 某一天共用这个形状） */
export interface LlmCallSummary {
  calls: number;
  ok: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_tokens_per_call: number;
  avg_input_per_call: number;
  avg_output_per_call: number;
  est_usd: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p90_latency_ms: number;
  max_latency_ms: number;
  total_latency_s: number;
}

export interface LlmCallRow {
  id: number;
  provider: string;
  model: string;
  purpose: "seek" | "test" | string;
  project_id: number | null;
  task_id: number | null;
  input_tokens: number;
  output_tokens: number;
  est_usd: number;
  latency_ms: number;
  ok: boolean;
  error: string | null;
  created_at: string | null;
}

export interface LlmCallStats {
  days: number;
  since: string;
  total: LlmCallSummary;
  /** 这段日期里最近一次调用的时刻（ISO）；一次都没有是 null */
  last_at: string | null;
  all_time: { calls: number; total_tokens: number; est_usd: number };
  by_model: (LlmCallSummary & { provider: string; model: string; last_at: string | null })[];
  by_day: (LlmCallSummary & { day: string })[];
  recent: LlmCallRow[];
}

/** 调用统计：次数、token（总 / 单次）、花费、耗时，按家/模型、按天、最近几次 */
export const getLlmCallStats = (days: number) =>
  request.get<never, LlmCallStats>("/llm-providers/stats", { params: { days } });

/** 算法机上的一个本地模型（狗检测 / SAM / 画面向量 / 姿态） */
export interface LocalModel {
  key: string;
  name: string;
  purpose: string;
  available: boolean;
  error: string | null;
  device: string | null;
  weights: string | null;
  warm?: boolean;
  loading?: boolean;
  progress?: { pct: number | null; done_mb: number; total_mb: number | null; speed_mbps?: number; eta_s: number | null } | null;
  /** vLLM 那一行才有：进程 / 端口 / 权重 / 日志 */
  vllm?: {
    installed: boolean;
    model: string;
    weights_ready: boolean;
    downloading: boolean;
    running: boolean;
    pid: number | null;
    port: number;
    port_open: boolean;
    ready: boolean;
    uptime_s: number | null;
    log_tail: string[];
    download_log: string[];
    download_error: string | null;
    /** 起过但退出了 */
    exited?: boolean;
    exit_code?: number | null;
    /** 从这次启动的日志里挑出来的报错行 */
    log_errors?: string[];
    /** docker（默认，官方镜像）/ process（pip 装的 vllm） */
    backend?: "docker" | "process";
    image?: string | null;
    pulling?: boolean;
    pull_log?: string[];
  };
  /** vLLM 那一行才有：进程起来后模型加载的进度（从日志里程碑估） */
  startup?: { pct: number; stage: string; elapsed_s: number } | null;
  /** 最近一次「测试」的结果（视觉服务进程内存，重启归零） */
  last_test?: { at: number; ok: boolean; latency_ms: number; detail: string | null; error: string | null } | null;
  /** 视觉服务进程内存里的调用计数（重启归零） */
  meter: { calls: number; frames: number; total_ms: number; max_ms: number; errors: number; last_at: number | null; avg_ms: number; avg_ms_per_frame: number };
}

export interface LocalModelsOverview {
  available: boolean;
  error: string | null;
  uptime_s?: number;
  gpu?: { cuda_available: boolean | null; gpu: string | null; torch: string | null; why: string | null } | null;
  models: LocalModel[];
}

export const listLocalModels = () => request.get<never, LocalModelsOverview>("/llm-providers/local-models");

export const actLocalModel = (key: string, action: "load" | "unload" | "test") =>
  request.post<never, { ok: boolean; error: string | null; latency_ms?: number; detail?: string | null; status: Partial<LocalModel> }>(
    `/llm-providers/local-models/${key}`,
    { action },
    { timeout: 320000 }
  );

export const resetLocalModelMeter = () => request.post<never, { ok: boolean }>("/llm-providers/local-models/meter/reset");

/** vLLM 这次启动的日志（最后 n 行）和挑出来的报错行 */
export const getVllmLog = (n = 300) =>
  request.get<never, { lines: string[]; errors: string[] }>("/llm-providers/local-models/vllm/log", { params: { n } });

/** 本地模型（算法机上）最近 N 天的调用量：平台每 5 分钟从视觉服务采一次计数按小时落表 */
export interface LocalModelDay {
  day: string;
  calls: number;
  frames: number;
  errors: number;
  total_ms: number;
}
export interface LocalModelStat {
  key: string;
  name: string;
  calls: number;
  frames: number;
  errors: number;
  total_ms: number;
  avg_ms: number;
  avg_ms_per_frame: number;
  /** 最近一次调用的时刻（ISO）。不受所选时间范围影响——问的是"上次什么时候用的" */
  last_call_at: string | null;
  by_day: LocalModelDay[];
}
export const getLocalModelStats = (days: number) =>
  request.get<never, { days: number; since: string; models: LocalModelStat[] }>("/llm-providers/local-models/stats", { params: { days } });

/** IMU 预测模型（AI 预标注）的使用量：每个模型 / 版本按天跑了几份样本、多少窗口 */
export interface ImuModelDay {
  day: string;
  samples: number;
  windows: number;
  segments: number;
  candidates: number;
}
export interface ImuModelStat {
  model_tag: string;
  mode: string;
  /** server = 服务器上的 sklearn；edge = 烧进项圈那份 C（端侧服务跑的） */
  kind: "server" | "edge";
  samples: number;
  windows: number;
  segments: number;
  candidates: number;
  /** 这段日期里最近一次跑预标注的时刻（ISO） */
  last_at: string | null;
  by_day: ImuModelDay[];
}
export const getImuModelStats = (days: number) =>
  request.get<never, { days: number; since: string; models: ImuModelStat[] }>("/llm-providers/imu-models/stats", { params: { days } });
