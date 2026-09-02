import { useState } from "react";
import { Button, Form, Input, Popconfirm, Space, Switch, Table, Tag, Typography, message } from "antd";
import { Modal } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createProject, deleteProject, listProjects, updateProject } from "@/api/projects";
import { listTasks } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import { useAuthStore } from "@/stores/authStore";
import type { Project } from "@/types";

interface FormValues {
  name: string;
  description?: string;
}

export default function Projects() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // 列表里顺带显示每个项目下有多少任务/标签，方便判断能不能删
  const { data: allTasks } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });
  const { data: allLabels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form] = Form.useForm<FormValues>();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ name: "", description: "" });
    setOpen(true);
  };

  const openEdit = (p: Project) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, description: p.description ?? "" });
    setOpen(true);
  };

  const handleSubmit = async (values: FormValues) => {
    if (editing) {
      await updateProject(editing.id, values);
      message.success("已保存");
    } else {
      await createProject(values);
      message.success("项目已创建");
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteProject(id);
    message.success("项目已删除");
    refresh();
  };

  const countOf = (id: number) => ({
    tasks: allTasks?.filter((t) => t.project_id === id).length ?? 0,
    labels: allLabels?.filter((l) => l.project_id === id).length ?? 0,
  });

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        {role === "admin" && (
          <Button type="primary" onClick={openCreate}>
            新建项目
          </Button>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        同一批数据在不同业务下要标的东西不一样，所以先建项目，再在项目里建任务、配标签。
        项目之间的标签互不干扰，同一个样本可以同时出现在多个项目里。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          {
            title: "项目名",
            render: (_, p: Project) => (
              <Space>
                <strong>{p.name}</strong>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          { title: "说明", dataIndex: "description", render: (d: string | null) => d || "-" },
          {
            title: "任务数",
            width: 90,
            render: (_, p: Project) => countOf(p.id).tasks,
          },
          {
            title: "标签数",
            width: 90,
            render: (_, p: Project) => countOf(p.id).labels,
          },
          {
            title: "操作",
            width: 220,
            render: (_, p: Project) =>
              role === "admin" && (
                <Space>
                  <Button size="small" type="link" onClick={() => openEdit(p)}>
                    编辑
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    onClick={async () => {
                      await updateProject(p.id, { is_active: !p.is_active });
                      refresh();
                    }}
                  >
                    {p.is_active ? "停用" : "启用"}
                  </Button>
                  <Popconfirm
                    title="删除项目"
                    description="项目下还有任务或标签时不能删，需要先清空"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(p.id)}
                  >
                    <Button size="small" danger type="link">
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />

      <Modal
        title={editing ? `编辑项目 - ${editing.name}` : "新建项目"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="项目名" rules={[{ required: true }]}>
            <Input placeholder="如：狗行为标注 / 项圈佩戴检测" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} placeholder="这个项目要标什么、给谁用" />
          </Form.Item>
          {editing && (
            <Form.Item label="启用">
              <Switch
                checked={editing.is_active}
                onChange={async (v) => {
                  await updateProject(editing.id, { is_active: v });
                  setEditing({ ...editing, is_active: v });
                  refresh();
                }}
              />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block>
            {editing ? "保存" : "创建"}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
