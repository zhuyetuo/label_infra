import { useState } from "react";
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createUser, deleteUser, listUsers, resetUserPassword, updateUser } from "@/api/users";
import { useAuthStore } from "@/stores/authStore";
import { RoleTag } from "@/utils/taskStatus";
import type { AppUser } from "@/types";

const ROLE_OPTIONS = [
  { value: "super_admin", label: "超级管理员" },
  { value: "admin", label: "管理员" },
  { value: "annotator", label: "标注员" },
  { value: "reviewer", label: "审核员" },
];

export default function Users() {
  const qc = useQueryClient();
  const isSuperAdmin = useAuthStore((s) => s.userInfo?.role) === "super_admin";
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
    remark?: string;
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

  const handleReset = async (u: AppUser) => {
    const r = await resetUserPassword(u.id);
    Modal.success({
      title: `已重置 ${r.username} 的密码`,
      content: (
        <div>
          <p>
            临时密码：<Typography.Text copyable strong>{r.temp_password}</Typography.Text>
          </p>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            请把它交给本人，登录后会强制修改。系统只保存密码的哈希值，
            所以任何人都看不到已有账号的原密码，只能这样重置。
          </Typography.Text>
        </div>
      ),
    });
  };

  const handleDelete = async (u: AppUser) => {
    await deleteUser(u.id);
    message.success("账号已删除");
    refresh();
  };

  const handleRemarkChange = async (u: AppUser, remark: string) => {
    const trimmed = remark.trim();
    if (trimmed === (u.remark ?? "")) return;
    await updateUser(u.id, { remark: trimmed === "" ? null : trimmed });
    refresh();
  };

  const handleRoleChange = (u: AppUser, role: AppUser["role"]) => {
    if (role === u.role) return;
    const roleLabel = ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
    Modal.confirm({
      title: "修改角色",
      content: `确定把 ${u.username} 的角色改为「${roleLabel}」？`,
      onOk: async () => {
        await updateUser(u.id, { role });
        message.success("角色已修改");
        refresh();
      },
    });
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
          {
            title: "角色",
            dataIndex: "role",
            render: (r: AppUser["role"], u: AppUser) => (
              <Select
                size="small"
                value={r}
                variant="borderless"
                // 不写死宽度：「超级管理员」比其他角色名长，写死会挤得跟下拉箭头叠在一起。
                // 交给内容自己撑开，最小留够放下箭头的空间即可。
                style={{ minWidth: 128 }}
                popupMatchSelectWidth={false}
                options={ROLE_OPTIONS}
                // 收起时显示的值、下拉列表里的每一项，都用跟表格其他地方一样的
                // 色块（RoleTag），而不是纯文字——色块比文字颜色更抓眼，一眼分清角色
                labelRender={() => <RoleTag role={r} />}
                optionRender={(opt) => <RoleTag role={opt.value as string} />}
                onChange={(role) => handleRoleChange(u, role)}
              />
            ),
          },
          {
            title: "外包",
            dataIndex: "is_outsourced",
            render: (v: boolean) => (v ? <Tag color="orange">外包</Tag> : "-"),
          },
          {
            title: "备注",
            dataIndex: "remark",
            render: (remark: string | null, u: AppUser) => (
              <Typography.Text
                type={remark ? undefined : "secondary"}
                editable={{
                  text: remark ?? "",
                  onChange: (v) => handleRemarkChange(u, v),
                  autoSize: { minRows: 1, maxRows: 4 },
                }}
                style={{ maxWidth: 220 }}
              >
                {remark || "点击填写备注"}
              </Typography.Text>
            ),
          },
          {
            title: "状态",
            dataIndex: "is_active",
            render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "启用" : "禁用"}</Tag>,
          },
          {
            title: "操作",
            width: 260,
            render: (_, u: AppUser) => (
              <Space>
                <Button size="small" onClick={() => toggleActive(u)}>
                  {u.is_active ? "禁用" : "启用"}
                </Button>
                <Popconfirm title="重置密码" description="会生成一个临时密码，原密码立即失效" onConfirm={() => handleReset(u)}>
                  <Button size="small" type="link">
                    重置密码
                  </Button>
                </Popconfirm>
                {isSuperAdmin && (
                  <Popconfirm
                    title="删除账号"
                    description="已经产生过工作记录的账号删不掉，那种情况请用「禁用」"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(u)}
                  >
                    <Button size="small" danger type="link">
                      删除
                    </Button>
                  </Popconfirm>
                )}
              </Space>
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
              <Select options={ROLE_OPTIONS} />
            </Form.Item>
            <Form.Item name="is_outsourced" label="外包账号" valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
            <Form.Item name="remark" label="备注（外包/实习/入离职时间等，仅管理员可见）">
              <Input.TextArea rows={2} placeholder="比如：外包，学生实习，2026-09入职" />
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
