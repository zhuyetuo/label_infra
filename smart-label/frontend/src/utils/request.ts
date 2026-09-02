import axios, { type AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { message } from "antd";
import { useAuthStore } from "@/stores/authStore";

export interface ApiEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

const request = axios.create({ baseURL: "/api/v1", timeout: 15000 });

request.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
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
    const envelope = response.data as ApiEnvelope;
    if (envelope && typeof envelope === "object" && "code" in envelope && envelope.code !== 0) {
      message.error(envelope.msg || "请求失败");
      return Promise.reject(new Error(envelope.msg || "Error"));
    }
    return envelope?.data as unknown as AxiosResponse;
  },
  async (error: AxiosError<ApiEnvelope>) => {
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
    const msg = error.response?.data?.msg || error.message || "网络错误";
    message.error(msg);
    return Promise.reject(error);
  }
);

export default request;
