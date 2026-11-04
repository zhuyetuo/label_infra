import { useEffect } from "react";
import { Badge, Layout, Menu, Space, Tag, Typography } from "antd";
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
  { key: "/tooth", label: "牙齿识别", roles: ["super_admin", "admin"], feature: "tooth" },
  // 非管理员（兽医 / 实习生）进来只看到「皮肤照片」评级那一块
  { key: "/skin", label: "皮肤评估", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/daily-stats", label: "日常统计", roles: ["super_admin", "admin"] },
  { key: "/annotator-stats", label: "标注统计", roles: ["super_admin", "admin"] },
  { key: "/workforce", label: "人力管理", roles: ["super_admin", "admin"] },
  { key: "/vision", label: "视觉标注", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/training", label: "模型训练", roles: ["super_admin", "admin"] },
  { key: "/label-definitions", label: "标签管理", roles: ["super_admin", "admin"] },
  { key: "/llm-providers", label: "模型服务", roles: ["super_admin", "admin"] },
  { key: "/users", label: "账号管理", roles: ["super_admin", "admin"] },
  { key: "/system", label: "系统监控", roles: ["super_admin", "admin"] },
] as { key: string; label: string; roles: string[]; feature?: string }[];

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
          {userInfo && <RoleTag role={userInfo.role} />}
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
                i.key === "/segment-review" && returned.total > 0 ? (
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
        <Content style={{ padding: 24, overflow: "auto" }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
