import { useEffect, useState } from "react";
import { Button, Card, Form, Input, Typography, message } from "antd";
import { useNavigate } from "react-router-dom";
import { bootstrapAdmin, bootstrapStatus, getMe, login } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";

export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setUserInfo = useAuthStore((s) => s.setUserInfo);
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    bootstrapStatus()
      .then((r) => setNeedsBootstrap(r.needs_bootstrap))
      .catch(() => setNeedsBootstrap(false));
  }, []);

  const handleBootstrap = async (values: { username: string; display_name: string; password: string }) => {
    setLoading(true);
    try {
      await bootstrapAdmin(values.username, values.display_name, values.password);
      message.success("首个管理员创建成功，请登录");
      setNeedsBootstrap(false);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const tokens = await login(values.username, values.password);
      setAuth(tokens.access_token, tokens.refresh_token, null);
      const me = await getMe();
      setUserInfo(me);
      navigate("/tasks");
    } finally {
      setLoading(false);
    }
  };

  if (needsBootstrap === null) return null;

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", background: "#f0f2f5" }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: "center" }}>
          smart-label
        </Typography.Title>
        {needsBootstrap ? (
          <>
            <Typography.Paragraph type="secondary" style={{ textAlign: "center" }}>
              还没有管理员账号，创建第一个（仅本次有效，创建后此表单永久失效）
            </Typography.Paragraph>
            <Form layout="vertical" onFinish={handleBootstrap}>
              <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                <Input autoComplete="username" />
              </Form.Item>
              <Form.Item name="display_name" label="显示名" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, min: 8, message: "至少8位" }]}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                创建管理员
              </Button>
            </Form>
          </>
        ) : (
          <Form layout="vertical" onFinish={handleLogin}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );
}
