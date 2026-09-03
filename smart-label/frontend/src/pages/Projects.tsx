import { useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { assignProject, createProject, deleteProject, listProjects, updateProject } from "@/api/projects";
import { listTasks } from "@/api/tasks";
import { listLabels } from "@/api/labels";
import { applyLabelTemplate, listLabelTemplates } from "@/api/labelTemplates";
import { listSamples } from "@/api/samples";
import { listUsers } from "@/api/users";
import { useAuthStore } from "@/stores/authStore";
import { ROLE_META, TASK_STATUS_META, TASK_TYPE_LABEL, TaskStatusTag } from "@/utils/taskStatus";
import type { Project, Task, TaskStatus } from "@/types";

interface FormValues {
  name: string;
  description?: string;
  templateId?: number;
}

export default function Projects() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const isAdmin = role === "admin" || role === "super_admin";

  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const { data: allTasks } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });
  const { data: allLabels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples, enabled: isAdmin });
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: isAdmin });
  const { data: templates } = useQuery({
    queryKey: ["label-templates"],
    queryFn: listLabelTemplates,
    enabled: isAdmin,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form] = Form.useForm<FormValues>();

  const [assignTarget, setAssignTarget] = useState<Project | null>(null);
  const [assignUserId, setAssignUserId] = useState<number | null>(null);
  const [includeClaimed, setIncludeClaimed] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ name: "", description: "", templateId: undefined });
    setOpen(true);
  };

  const openEdit = (p: Project) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, description: p.description ?? "", templateId: undefined });
    setOpen(true);
  };

  const handleSubmit = async ({ templateId, ...values }: FormValues) => {
    let projectId = editing?.id;
    if (editing) {
      await updateProject(editing.id, values);
      message.success("已保存");
    } else {
      const created = await createProject(values);
      projectId = created.id;
      message.success("项目已创建");
    }
    if (templateId != null && projectId != null) {
      const r = await applyLabelTemplate(templateId, projectId);
      message.success(`已套用模板，添加 ${r.created} 个标签${r.skipped ? `，跳过已存在的 ${r.skipped} 个` : ""}`);
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteProject(id);
    message.success("项目及其任务、标签已删除");
    refresh();
  };

  const openAssign = (p: Project) => {
    setAssignTarget(p);
    setAssignUserId(null);
    setIncludeClaimed(false);
  };

  const handleAssign = async () => {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      const r = await assignProject(assignTarget.id, assignUserId, includeClaimed);
      message.success(`已指派 ${r.assigned} 个任务${r.skipped ? `，跳过 ${r.skipped} 个` : ""}`);
      setAssignTarget(null);
      refresh();
    } finally {
      setAssigning(false);
    }
  };

  const tasksOf = (projectId: number) => allTasks?.filter((t) => t.project_id === projectId) ?? [];
  const labelCount = (projectId: number) =>
    allLabels?.filter((l) => l.project_id === projectId).length ?? 0;
  const userName = (id: number | null) => {
    if (id == null) return null;
    const u = users?.find((x) => x.id === id);
    return u ? u.display_name || u.username : `#${id}`;
  };
  const sampleCode = (id: number) => samples?.find((s) => s.id === id)?.sample_code ?? id;

  // 项目下任务按状态汇总，一眼看出进度
  const statusSummary = (projectId: number) => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasksOf(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  };

  // 项目下这些任务都指派给谁了
  const assigneeSummary = (projectId: number) => {
    const ids = new Set(tasksOf(projectId).map((t) => t.assigned_to));
    const named = [...ids].filter((i): i is number => i != null).map(userName);
    const hasUnassigned = ids.has(null);
    return { named, hasUnassigned };
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        {isAdmin && (
          <Button type="primary" onClick={openCreate}>
            新建项目
          </Button>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        同一批数据在不同业务下要标的东西不一样，所以先建项目，再在项目里建任务、配标签。
        项目之间的标签互不干扰，同一个样本可以同时出现在多个项目里。
        点左侧箭头可以展开看项目下的任务；「指派」可以把整个项目的任务一次性分给某个人。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        expandable={{
          // 点行内空白处就能展开，不用非得点最左边那个小箭头
          expandRowByClick: true,
          // 展开就能看到这个项目下都有哪些任务、分给谁了、做到哪一步了
          expandedRowRender: (p: Project) => {
            const rows = tasksOf(p.id);
            return (
              <Table
                size="small"
                rowKey="id"
                dataSource={rows}
                pagination={rows.length > 10 ? { pageSize: 10 } : false}
                locale={{ emptyText: "这个项目下还没有任务" }}
                columns={[
                  { title: "任务ID", dataIndex: "id", width: 80 },
                  {
                    title: "样本",
                    dataIndex: "sample_id",
                    render: (id: number) => sampleCode(id),
                  },
                  {
                    title: "类型",
                    dataIndex: "task_type",
                    width: 150,
                    render: (t: string) => TASK_TYPE_LABEL[t] ?? t,
                  },
                  { title: "轮次", dataIndex: "round_no", width: 60 },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 140,
                    render: (s: TaskStatus) => <TaskStatusTag status={s} />,
                  },
                  {
                    title: "指派给",
                    dataIndex: "assigned_to",
                    render: (id: number | null) =>
                      id == null ? <Typography.Text type="secondary">未指派</Typography.Text> : userName(id),
                  },
                ]}
              />
            );
          },
        }}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          {
            title: "项目名",
            width: 160,
            ellipsis: true,
            render: (_, p: Project) => (
              <Space>
                <strong>{p.name}</strong>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          {
            title: "说明",
            dataIndex: "description",
            width: 180,
            ellipsis: true,
            render: (d: string | null) => d || "-",
          },
          {
            title: "任务",
            width: 240,
            render: (_, p: Project) => {
              const counts = statusSummary(p.id);
              const total = tasksOf(p.id).length;
              if (!total) return <Typography.Text type="secondary">0</Typography.Text>;
              return (
                <Space size={4} wrap>
                  <span>共 {total}</span>
                  {(Object.keys(counts) as TaskStatus[]).map((s) => (
                    <Tag key={s} color={TASK_STATUS_META[s]?.color}>
                      {TASK_STATUS_META[s]?.label ?? s} {counts[s]}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: "指派给",
            width: 180,
            render: (_, p: Project) => {
              const { named, hasUnassigned } = assigneeSummary(p.id);
              if (!named.length && !hasUnassigned) return "-";
              return (
                <Space size={4} wrap>
                  {named.map((n) => (
                    <Tag key={n} color="blue">
                      {n}
                    </Tag>
                  ))}
                  {hasUnassigned && <Tag>有未指派</Tag>}
                </Space>
              );
            },
          },
          { title: "标签数", width: 80, render: (_, p: Project) => labelCount(p.id) },
          {
            title: "操作",
            width: 260,
            render: (_, p: Project) =>
              isAdmin && (
                // 整行点击展开后，操作按钮得挡住这个冒泡，不然点"编辑"之类的
                // 按钮会连带把行展开/收起，体验很怪
                <Space onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="link" onClick={() => openAssign(p)}>
                    指派
                  </Button>
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
                    description={
                      <div style={{ maxWidth: 320 }}>
                        会连同该项目下的 <b>{tasksOf(p.id).length}</b> 个任务（含它们的标注结果和审核记录）
                        和 <b>{labelCount(p.id)}</b> 个标签一起删掉，不可恢复。
                        只是暂时不用的话建议改成「停用」。
                      </div>
                    }
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
          <Form.Item
            name="templateId"
            label="标签模板（可选）"
            extra={
              editing
                ? "套用会把模板里的标签添加进来，已有同 code 的会跳过，不会覆盖"
                : "创建后立即套用该模板的标签，不用另外去标签管理页配一遍"
            }
          >
            <Select
              allowClear
              placeholder="不选则不套用，之后可以去「标签管理」页再套"
              options={templates?.map((t) => ({
                value: t.id,
                label: `${t.name}（${t.items.length} 个标签）`,
              }))}
              showSearch
              optionFilterProp="label"
            />
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

      <Modal
        title={`指派项目 - ${assignTarget?.name ?? ""}`}
        open={assignTarget != null}
        onCancel={() => setAssignTarget(null)}
        onOk={handleAssign}
        okText="指派"
        confirmLoading={assigning}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          把这个项目下的任务一次性分给一个人，不用一个一个点。默认只改还没被认领的任务，
          已经有人在标或已提交的不动，免得把别人做了一半的活儿抢走。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Select
            style={{ width: "100%" }}
            placeholder="选择标注员（留空 = 收回指派，回到公共池）"
            allowClear
            value={assignUserId ?? undefined}
            onChange={(v) => setAssignUserId(v ?? null)}
            options={users
              ?.filter((u) => u.is_active && u.role !== "reviewer")
              .map((u) => ({
                value: u.id,
                label: `${u.display_name || u.username}（${ROLE_META[u.role]?.label ?? u.role}）`,
              }))}
            showSearch
            optionFilterProp="label"
          />
          <Checkbox checked={includeClaimed} onChange={(e) => setIncludeClaimed(e.target.checked)}>
            连已被认领/已提交的任务一起改派（会退回待认领状态，已通过的不受影响）
          </Checkbox>
          {assignTarget && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该项目共 {tasksOf(assignTarget.id).length} 个任务，其中待认领{" "}
              {tasksOf(assignTarget.id).filter((t: Task) => t.status === "PENDING_ASSIGN").length} 个
            </Typography.Text>
          )}
        </Space>
      </Modal>
    </div>
  );
}
