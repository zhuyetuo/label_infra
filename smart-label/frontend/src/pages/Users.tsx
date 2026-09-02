import { useState } from "react";
import { Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createUser, listUsers, updateUser } from "@/api/users";
import type { AppUser } from "@/types";

export default function Users() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const handleCreate = async (values: {
    username: string;
    display_name: string;
    role: AppUser["role"];
    is_outsourced: boolean;
  }) => {
    const result = await createUser(values);
    setTempPassword(result.temp_password);
    form.resetFields();
    refresh();
  };

  const toggleActive = async (u: AppUser) => {
    await updateUser(u.id, { is_active: !u.is_active });
    message.success(u.is_active ? "已禁用" : "已启用");
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => setOpen(true)}>
          新建账号
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          { title: "用户名", dataIndex: "username" },
          { title: "显示名", dataIndex: "display_name" },
          { title: "角色", dataIndex: "role" },
          {
            title: "外包",
            dataIndex: "is_outsourced",
            render: (v: boolean) => (v ? <Tag color="orange">外包</Tag> : "-"),
          },
          {
            title: "状态",
            dataIndex: "is_active",
            render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "启用" : "禁用"}</Tag>,
          },
          {
            title: "操作",
            render: (_, u: AppUser) => (
              <Button size="small" onClick={() => toggleActive(u)}>
                {u.is_active ? "禁用" : "启用"}
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title="新建账号"
        open={open}
        onCancel={() => {
          setOpen(false);
          setTempPassword(null);
        }}
        footer={null}
        destroyOnClose
      >
        {tempPassword ? (
          <>
            <Typography.Paragraph>
              账号创建成功，临时密码只显示这一次，请通过其他渠道告知本人：
            </Typography.Paragraph>
            <Typography.Text code copyable style={{ fontSize: 16 }}>
              {tempPassword}
            </Typography.Text>
            <Button block style={{ marginTop: 16 }} onClick={() => setTempPassword(null)}>
              关闭
            </Button>
          </>
        ) : (
          <Form form={form} layout="vertical" onFinish={handleCreate}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="display_name" label="显示名" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="role" label="角色" rules={[{ required: true }]} initialValue="annotator">
              <Select
                options={[
                  { value: "admin", label: "管理员" },
                  { value: "annotator", label: "标注员" },
                  { value: "reviewer", label: "审核员" },
                ]}
              />
            </Form.Item>
            <Form.Item name="is_outsourced" label="外包账号" valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>
              创建
            </Button>
          </Form>
        )}
      </Modal>
    </div>
  );
}
