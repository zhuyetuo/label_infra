import "./index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { applyThemeAttr, useThemeStore } from "./stores/themeStore";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

applyThemeAttr(useThemeStore.getState().mode);

// 服务器更新后，开着的旧页面去拿已经不存在的 js 分包会失败：自动刷新一次拿新版本
// （一分钟内只刷一次，免得真出问题时无限刷新）
window.addEventListener("vite:preloadError", (e) => {
  try {
    const last = Number(sessionStorage.getItem("reloadAfterDeploy") || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem("reloadAfterDeploy", String(Date.now()));
  } catch {
    /* 没 sessionStorage 也照样刷新 */
  }
  e.preventDefault();
  window.location.reload();
});

/** 明亮 / 暗黑两套：antd 自带的算法换整套颜色，主题紫不变 */
function Root() {
  const mode = useThemeStore((s) => s.mode);
  const dark = mode === "dark";
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        // 暗黑模式下 antd 默认的占位字 / 次要字太淡（白 0.25），「全部类别」「最低%」这种筛选框几乎看不见：提一档
        token: dark
          ? { colorPrimary: "#8b73d6", colorTextPlaceholder: "rgba(255,255,255,0.45)", colorTextQuaternary: "rgba(255,255,255,0.38)", colorTextDisabled: "rgba(255,255,255,0.38)" }
          : { colorPrimary: "#6a51b7" },
        // Layout 的 Header/Sider 背景不跟着 colorPrimary 走，是单独的 token，
        // 默认深色导航条（截图里的深色条）得在这里单独指定才会变成主题色
        components: { Layout: dark
          ? { headerBg: "#3b2f6b", siderBg: "#141414", bodyBg: "#000" }
          : { headerBg: "#6a51b7", siderBg: "#fff" } },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
