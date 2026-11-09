import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { message } from "antd";
import { useAuthStore } from "@/stores/authStore";

export interface ApiEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

// 默认等 60 秒。原来 15 秒：服务器一忙（有人在跑重新拉取 / 大批量操作、数据库在等锁），
// 平时一两秒的请求偶尔要十几秒，页面上就到处弹英文的 "timeout of 15000ms exceeded"
const request = axios.create({ baseURL: "/api/v1", timeout: 60000 });

// 访客能发的非 GET 请求，跟后端 app/core/deps.py 的 VIEWER_ALLOWED_POSTS 一致
const VIEWER_ALLOWED = ["/auth/logout", "/model-eval/compare", "/data-pool/compare-preview",
  "/skin/ml/preview", "/candidates/similar/preview"];

request.interceptors.request.use((config) => {
  const { accessToken: token, userInfo } = useAuthStore.getState();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // 访客：修改类请求不发了，提示一次（同一个 key，连点也只显示一条）
  const method = (config.method ?? "get").toLowerCase();
  if (userInfo?.readOnly && !["get", "head", "options"].includes(method)
      && !VIEWER_ALLOWED.some((p) => config.url?.split("?")[0].endsWith(p))) {
    message.warning({ content: "访客账号只能查看，不能修改", key: "read-only" });
    return Promise.reject(new axios.Cancel("read-only"));
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;
  try {
    const resp = await axios.post<ApiEnvelope<{ access_token: string; refresh_token: string }>>(
      "/api/v1/auth/refresh",
      { refresh_token: refreshToken }
    );
    const { access_token, refresh_token } = resp.data.data;
    useAuthStore.getState().setAuth(access_token, refresh_token, useAuthStore.getState().userInfo);
    return access_token;
  } catch {
    return null;
  }
}

request.interceptors.response.use(
  (response) => {
    // 下载文件（zip 之类）：不是信封，原样交出 Blob
    if (response.config.responseType === "blob") return response.data;
    const envelope = response.data as ApiEnvelope;
    if (envelope && typeof envelope === "object" && "code" in envelope && envelope.code !== 0) {
      message.error(envelope.msg || "请求失败");
      return Promise.reject(new Error(envelope.msg || "Error"));
    }
    return envelope?.data as unknown as AxiosResponse;
  },
  async (error: AxiosError<ApiEnvelope>) => {
    if (axios.isCancel(error)) return Promise.reject(error); // 访客被拦下的，上面已经提示过
    const original = error.config as InternalAxiosRequestConfig & { _retried?: boolean };
    if (error.response?.status === 401 && original && !original._retried && !original.url?.includes("/auth/")) {
      original._retried = true;
      refreshing ??= doRefresh().finally(() => {
        refreshing = null;
      });
      const newToken = await refreshing;
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return request(original);
      }
      useAuthStore.getState().clearAuth();
      message.error("登录已过期，请重新登录");
      window.location.href = "/login";
      return Promise.reject(error);
    }
    let msg = error.response?.data?.msg || error.message || "网络错误";
    if (error.code === "ECONNABORTED" || /timeout/i.test(error.message)) {
      const sec = Math.round((error.config?.timeout ?? 60000) / 1000);
      msg = `服务器 ${sec} 秒没响应，可能正忙（有人在跑大计算 / 数据库卡住），稍后再试；「系统监控」里能看到慢在哪`;
      // 同时好几个请求超时只弹一条
      if (!(error.config as { silent?: boolean } | undefined)?.silent) message.error({ content: msg, key: "timeout" });
      return Promise.reject(error);
    }
    // responseType=blob 时出错，后端的 JSON 报错也被装成了 Blob，读出来才看得到原因
    const blobData = error.response?.data as unknown;
    if (blobData instanceof Blob) {
      try {
        const j = JSON.parse(await blobData.text());
        msg = j.msg || j.detail || msg;
      } catch {
        /* 不是 JSON，就用默认的 */
      }
    }
    // silent：调用方自己在页面上显示错误（比如定时自动跑的），不要每次都在顶上弹一个
    if (!(error.config as { silent?: boolean } | undefined)?.silent) message.error(msg);
    return Promise.reject(error);
  }
);

/** 从请求报错里取后端给的那句话（没有就用 axios 的「Request failed with status code 502」） */
export function errMsg(e: unknown): string {
  const ax = e as AxiosError<ApiEnvelope>;
  return ax?.response?.data?.msg || (e instanceof Error ? e.message : String(e));
}

export default request;
