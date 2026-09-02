import { Layout, Menu, Space, Tag, Typography } from "antd";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

const { Header, Content, Sider } = Layout;

const ALL_ITEMS = [
  { key: "/projects", label: "项目", roles: ["admin", "annotator", "reviewer"] },
  { key: "/tasks", label: "任务", roles: ["admin", "annotator", "reviewer"] },
  { key: "/reviews", label: "审核", roles: ["admin", "reviewer"] },
  { key: "/samples", label: "样本", roles: ["admin"] },
  { key: "/label-definitions", label: "标签管理", roles: ["admin"] },
  { key: "/users", label: "账号管理", roles: ["admin"] },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { accessToken, userInfo, clearAuth } = useAuthStore();

  if (!accessToken) return <Navigate to="/login" replace />;

  const items = ALL_ITEMS.filter((i) => !userInfo || i.roles.includes(userInfo.role));

  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Text strong style={{ color: "#fff", fontSize: 18 }}>
          smart-label
        </Typography.Text>
        <Space>
          <Tag color="blue">{userInfo?.role}</Tag>
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
            items={items.map((i) => ({ key: i.key, label: i.label }))}
          />
        </Sider>
        <Content style={{ padding: 24, overflow: "auto" }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
