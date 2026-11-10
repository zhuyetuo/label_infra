import { getLabelReview } from "@/api/tasks";
import { SkinStandardDrawer, useStandardInset } from "@/components/SkinStandard";
import { useEffect } from "react";
import { Badge, Layout, Menu, Space, Tag, Tooltip, Typography } from "antd";
import { useThemeStore } from "@/stores/themeStore";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getMe } from "@/api/auth";
import { hasFeature, useAuthStore } from "@/stores/authStore";
import { RoleTag } from "@/utils/taskStatus";
import { useReturnedSegments } from "@/hooks/useReturnedSegments";

const { Header, Content, Sider } = Layout;

const ALL_ITEMS = [
  { key: "/projects", label: "项目", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/tasks", label: "任务", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/reviews", label: "审核", roles: ["super_admin", "admin", "reviewer"] },
  // 片段审核在「审核」页里（第二个标签页）；标注员进不了审核页，单独给一个入口看退回给自己的片段
  { key: "/segment-review", label: "退回的片段", roles: ["annotator"] },
  { key: "/samples", label: "样本", roles: ["super_admin", "admin"] },
  // feature：不是这几个角色的账号，单独开了这项功能也能看到（账号管理里勾）
  { key: "/dogs", label: "狗档案", roles: ["super_admin", "admin"], feature: "dogs_view" },
  // 两个标签页：牙齿检测（要「牙齿识别」权限）+ 口腔实例分割（原「视觉标注」，标注员 / 审核员也能进）
  { key: "/tooth", label: "牙齿识别", roles: ["super_admin", "admin", "annotator", "reviewer"], feature: "tooth" },
  // 非管理员（兽医 / 实习生）进来只看到「皮肤照片」评级那一块
  { key: "/skin", label: "皮肤评估", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/daily-stats", label: "日常统计", roles: ["super_admin", "admin"] },
  { key: "/annotator-stats", label: "标注统计", roles: ["super_admin", "admin"] },
  { key: "/workforce", label: "人力管理", roles: ["super_admin", "admin"] },
  { key: "/training", label: "模型训练", roles: ["super_admin", "admin"] },
  { key: "/label-definitions", label: "标签管理", roles: ["super_admin", "admin"] },
  { key: "/llm-providers", label: "模型服务", roles: ["super_admin", "admin"] },
  { key: "/users", label: "账号管理", roles: ["super_admin", "admin"] },
  // 用这台电脑的蓝牙直接连 IMU（自制项圈 / WitMotion）看波形、采样率、行为
  { key: "/device-debug", label: "设备调试", roles: ["super_admin", "admin"] },
  { key: "/system", label: "系统监控", roles: ["super_admin", "admin"] },
] as { key: string; label: string; roles: string[]; feature?: string }[];

/** 右上角：明亮 / 暗黑 切换，记在本机 */
function ThemeSwitch() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const dark = mode === "dark";
  return (
    <Tooltip title={dark ? "切换到明亮模式" : "切换到暗黑模式"}>
      <a style={{ color: "#fff", fontSize: 16, padding: "0 4px" }} onClick={() => setMode(dark ? "light" : "dark")}>
        {dark ? "☀" : "🌙"}
      </a>
    </Tooltip>
  );
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { accessToken, userInfo, clearAuth, setUserInfo } = useAuthStore();

  // 账号信息登录时取一次就存下了；管理员后来给开了功能，不重新拿的话菜单不会变，
  // 人只能退出重登才看得到。切回这个页面时顺手刷一下
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    enabled: !!accessToken,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (me) setUserInfo(me);
  }, [me, setUserInfo]);

  const returned = useReturnedSegments();
  const standardInset = useStandardInset();
  // 左边「项目」上标抓挠还有多少没通过 / 没审（管理员、审核员看）
  const reviewer = userInfo?.role === "admin" || userInfo?.role === "super_admin" || userInfo?.role === "reviewer";
  const { data: scratch } = useQuery({
    queryKey: ["label-review", "抓挠"], queryFn: () => getLabelReview("抓挠"),
    enabled: !!accessToken && reviewer, refetchInterval: 60_000, staleTime: 20_000,
  });
  const scratchNotPassed = scratch ? scratch.total.n - scratch.total.approved : 0;

  if (!accessToken) return <Navigate to="/login" replace />;

  const items = ALL_ITEMS.filter(
    (i) => !userInfo || i.roles.includes(userInfo.role) || (i.feature && hasFeature(userInfo, i.feature)),
  );

  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Text strong style={{ color: "#fff", fontSize: 18 }}>
          smart-label
        </Typography.Text>
        <Space>
          <ThemeSwitch />
          {userInfo && <RoleTag role={userInfo.readOnly ? "viewer" : userInfo.role} />}
          <Typography.Text style={{ color: "#fff" }}>{userInfo?.display_name}</Typography.Text>
          <a
            style={{ color: "#fff" }}
            onClick={() => {
              clearAuth();
              navigate("/login");
            }}
          >
            退出
          </a>
        </Space>
      </Header>
      <Layout>
        <Sider width={180}>
          <Menu
            mode="inline"
            style={{ height: "100%" }}
            selectedKeys={[location.pathname]}
            onClick={(e) => navigate(e.key)}
            items={items.map((i) => ({
              key: i.key,
              // 退回给我的片段：红色数字，有多少条没改好
              label:
                i.key === "/projects" && scratch && scratchNotPassed > 0 ? (
                  <Tooltip placement="right"
                    title={`抓挠：未通过 ${scratchNotPassed} 段（其中退回待改 ${scratch.total.returned}、还没审 ${scratch.total.unreviewed}），共 ${scratch.total.n} 段`}>
                    <Space size={4}>
                      {i.label}
                      <span style={{ fontSize: 11, color: "#ff4d4f" }}>抓挠</span>
                      <Badge count={scratchNotPassed} overflowCount={9999} size="small" />
                      {scratch.total.unreviewed > 0 && (
                        <Badge count={scratch.total.unreviewed} overflowCount={9999} size="small" color="#fa8c16" />
                      )}
                    </Space>
                  </Tooltip>
                ) : i.key === "/segment-review" && returned.total > 0 ? (
                  <Space size={6}>
                    {i.label}
                    <Badge count={returned.total} overflowCount={999} size="small" />
                  </Space>
                ) : (
                  i.label
                ),
            }))}
          />
        </Sider>
        {/* 评级标准在右边开着时，整个页面往左让，不被盖住 */}
        <Content style={{ padding: 24, overflow: "auto", marginRight: standardInset }}>
          <Outlet />
        </Content>
        <SkinStandardDrawer />
      </Layout>
    </Layout>
  );
}
