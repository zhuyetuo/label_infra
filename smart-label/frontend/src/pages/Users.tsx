import { useState } from "react";
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createUser, deleteUser, getTempPassword, listFeatures, listUsers, resetUserPassword, updateUser } from "@/api/users";
import { useAuthStore } from "@/stores/authStore";
import { RoleTag } from "@/utils/taskStatus";
import type { AppUser } from "@/types";

const ROLE_OPTIONS = [
  { value: "super_admin", label: "超级管理员" },
  { value: "admin", label: "管理员" },
  { value: "annotator", label: "标注员" },
  { value: "reviewer", label: "审核员" },
  { value: "viewer", label: "访客（只能看）" },
];

/** 账号 + 密码 + 登录地址，一次复制好直接发给本人 */
function credentialText(username: string, password: string) {
  return `登录地址：${window.location.origin}\n账号：${username}\n密码：${password}`;
}

function Credential({ username, password, note }: { username: string; password: string; note?: string }) {
  const text = credentialText(username, password);
  return (
    <div>
      <div style={{ margin: "8px 0" }}>
        账号：<Typography.Text code copyable style={{ fontSize: 15 }}>{username}</Typography.Text>
      </div>
      <div style={{ margin: "8px 0" }}>
        密码：<Typography.Text code copyable style={{ fontSize: 15 }}>{password}</Typography.Text>
      </div>
      <Button
        type="primary"
        block
        style={{ margin: "8px 0" }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            // http 下没有 clipboard API：退回老办法
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          message.success("账号和密码已复制，直接粘贴发给本人");
        }}
      >
        复制账号和密码
      </Button>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {note ?? "以后忘了，超级管理员在账号列表里点「看密码」就能再拿到。"}
      </Typography.Text>
    </div>
  );
}

/** 离职（禁用）的排到最后，同组里新建的在前 */
function sortUsers(list: AppUser[] | undefined) {
  return [...(list ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.id - a.id);
}

export default function Users() {
  const qc = useQueryClient();
  const isSuperAdmin = useAuthStore((s) => s.userInfo?.role) === "super_admin";
  const { data, isLoading } = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const { data: features } = useQuery({ queryKey: ["user-features"], queryFn: listFeatures });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const handleCreate = async (values: {
    username: string;
    display_name: string;
    role: AppUser["role"];
    is_outsourced: boolean;
    remark?: string;
  }) => {
    const result = await createUser(values);
    setTempPassword({ username: result.user.username, password: result.temp_password });
    form.resetFields();
    refresh();
  };

  const toggleActive = async (u: AppUser) => {
    await updateUser(u.id, { is_active: !u.is_active });
    message.success(u.is_active ? "已禁用" : "已启用");
    refresh();
  };

  // 改密码：只有超级管理员能改，可以自己填，也可以留空随机生成
  const [pwdUser, setPwdUser] = useState<AppUser | null>(null);
  const [newPwd, setNewPwd] = useState("");
  const handleReset = async (u: AppUser, password?: string) => {
    const r = await resetUserPassword(u.id, password);
    setPwdUser(null);
    setNewPwd("");
    refresh();
    Modal.success({
      title: `已修改 ${u.display_name} 的密码`,
      width: 460,
      content: <Credential username={r.username} password={r.temp_password} />,
    });
  };

  const showPassword = async (u: AppUser) => {
    const r = await getTempPassword(u.id);
    if (!r.temp_password) {
      Modal.info({
        title: `看不到 ${u.display_name} 的密码`,
        content: "这个账号的密码是这次更新之前设的，系统里没存。点「改密码」设一个新的，之后就能一直看到。",
      });
      return;
    }
    Modal.info({
      title: `${u.display_name} 现在的密码`,
      width: 460,
      content: <Credential username={r.username} password={r.temp_password} />,
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

  // 用户名是登录名，只有超级管理员能改；显示名管理员就能改
  const handleNameChange = async (u: AppUser, field: "username" | "display_name", v: string) => {
    const trimmed = v.trim();
    if (!trimmed || trimmed === u[field]) return;
    await updateUser(u.id, { [field]: trimmed });
    message.success(field === "username" ? `用户名已改为 ${trimmed}，对方下次用它登录` : "显示名已更新");
    refresh();
  };

  // 单独开的功能：勾一项存一项，对方切回页面菜单就会出来，不用重新登录
  const handlePermissionsChange = async (u: AppUser, permissions: string[]) => {
    await updateUser(u.id, { permissions });
    message.success("功能权限已更新");
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
        dataSource={sortUsers(data)}
        rowClassName={(u: AppUser) => (u.is_active ? "" : "user-row-inactive")}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          {
            title: "用户名",
            dataIndex: "username",
            render: (name: string, u: AppUser) =>
              isSuperAdmin ? (
                <Typography.Text
                  editable={{
                    text: name,
                    tooltip: "改用户名（登录名）。改了之后对方要用新名字登录",
                    onChange: (v) => handleNameChange(u, "username", v),
                  }}
                >
                  {name}
                </Typography.Text>
              ) : (
                name
              ),
          },
          {
            title: "显示名",
            dataIndex: "display_name",
            render: (name: string, u: AppUser) => (
              <Typography.Text editable={{ text: name, onChange: (v) => handleNameChange(u, "display_name", v) }}>
                {name}
              </Typography.Text>
            ),
          },
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
            title: (
              <Tooltip title="在角色之外，单独给这个账号开几样功能（比如实习生只开狗档案和牙齿识别）。管理员本来就什么都能用，不用勾">
                额外功能
              </Tooltip>
            ),
            dataIndex: "permissions",
            width: 280,
            render: (keys: string[] | undefined, u: AppUser) =>
              u.role === "admin" || u.role === "super_admin" ? (
                <Typography.Text type="secondary">全部（管理员）</Typography.Text>
              ) : u.role === "viewer" ? (
                <Typography.Text type="secondary">全部页面只能看，不能改</Typography.Text>
              ) : (
                <Select
                  mode="multiple"
                  size="small"
                  allowClear
                  style={{ width: "100%" }}
                  placeholder="未开额外功能"
                  value={keys ?? []}
                  options={(features ?? []).map((f) => ({ value: f.key, label: f.name, title: f.description }))}
                  optionRender={(opt) => (
                    <div>
                      <div>{opt.label}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "normal" }}>
                        {features?.find((f) => f.key === opt.value)?.description}
                      </Typography.Text>
                    </div>
                  )}
                  onChange={(v: string[]) => handlePermissionsChange(u, v)}
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
            render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "启用" : "禁用（离职）"}</Tag>,
          },
          {
            title: "操作",
            width: 320,
            render: (_, u: AppUser) => (
              <Space>
                <Button size="small" onClick={() => toggleActive(u)}>
                  {u.is_active ? "禁用" : "启用"}
                </Button>
                {isSuperAdmin && (
                  <Button size="small" type="link" onClick={() => setPwdUser(u)}>
                    改密码
                  </Button>
                )}
                {isSuperAdmin && (
                  <Tooltip title={u.has_temp_password ? "看他现在的密码" : "密码是这次更新之前设的，系统里没存；改一次密码之后就能看"}>
                    <Button size="small" type="link" disabled={!u.has_temp_password} onClick={() => showPassword(u)}>
                      看密码
                    </Button>
                  </Tooltip>
                )}
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
        title={pwdUser ? `改 ${pwdUser.display_name}（${pwdUser.username}）的密码` : ""}
        open={!!pwdUser}
        okText="确定修改"
        onOk={() => pwdUser && handleReset(pwdUser, newPwd.trim() || undefined)}
        onCancel={() => {
          setPwdUser(null);
          setNewPwd("");
        }}
        destroyOnClose
      >
        <Input.Password
          autoFocus
          placeholder="新密码（至少 6 位）；留空就随机生成一个"
          value={newPwd}
          onChange={(e) => setNewPwd(e.target.value)}
          onPressEnter={() => pwdUser && handleReset(pwdUser, newPwd.trim() || undefined)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          改完原密码立即失效，对方已登录的会被踢下线。密码只有超级管理员能改，本人不能改自己的。
        </Typography.Text>
      </Modal>
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
            <Typography.Paragraph>账号创建成功，把下面的账号和密码发给本人：</Typography.Paragraph>
            <Credential username={tempPassword.username} password={tempPassword.password} />
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
