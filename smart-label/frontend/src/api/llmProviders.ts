import request from "@/utils/request";

/** 大模型 API 的一家：key 只写不读，接口只给"配没配 + 末四位" */
export interface LlmModel {
  name: string;
  /** $/百万 token，只用来估花费 */
  price_in: number;
  price_out: number;
}

export interface LlmProvider {
  provider: "anthropic" | "openai" | "doubao" | "gemini" | "local";
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
