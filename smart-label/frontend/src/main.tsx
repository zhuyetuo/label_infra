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

/** 明亮 / 暗黑两套：antd 自带的算法换整套颜色，主题紫不变 */
function Root() {
  const mode = useThemeStore((s) => s.mode);
  const dark = mode === "dark";
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: dark ? "#8b73d6" : "#6a51b7" },
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
