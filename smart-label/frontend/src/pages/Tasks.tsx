import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bulkCreateTasks, claimTask, createTask, deleteTask, listTasks, reopenTask } from "@/api/tasks";
import { listProjects } from "@/api/projects";
import { listSamples } from "@/api/samples";
import { listLabels } from "@/api/labels";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import { TASK_STATUS_META, TASK_TYPE_LABEL, TaskStatusTag } from "@/utils/taskStatus";
import type { LabelDefinition, Project, Task, TaskStatus } from "@/types";

// 任务按项目分组展示：项目多起来之后，用一个下拉一次只能看一个项目太难用，
// 这里跟项目页一样列出项目、展开看它下面的任务，再配一个按名字搜索的框。
export default function Tasks() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  const isAdmin = role === "admin";

  const { data: projects, isLoading: loadingProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });
  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples, enabled: isAdmin });
  // /users 只对管理员开放，其他角色拿不到就退回显示ID
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: isAdmin });
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });

  const [keyword, setKeyword] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [createForProject, setCreateForProject] = useState<Project | null>(null);
  const [createForm] = Form.useForm();
  const [bulkForProject, setBulkForProject] = useState<Project | null>(null);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const [bulkTaskType, setBulkTaskType] = useState<"from_scratch" | "ai_assisted">("from_scratch");
  const [bulkAssignee, setBulkAssignee] = useState<number | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [workspaceTask, setWorkspaceTask] = useState<Task | null>(null);
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  // 打开工作台时把该任务所属项目的标签带进去
  const [workspaceLabels, setWorkspaceLabels] = useState<LabelDefinition[]>([]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const handleCreateTask = async (values: {
    sample_id: number;
    task_type: "from_scratch" | "ai_assisted";
  }) => {
    if (!createForProject) return;
    await createTask({ ...values, project_id: createForProject.id });
    message.success("任务已创建");
    setCreateForProject(null);
    createForm.resetFields();
    refresh();
  };

  const handleClaim = async (id: number) => {
    await claimTask(id);
    message.success("认领成功");
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteTask(id);
    message.success("任务已删除");
    refresh();
  };

  const handleReopen = async (id: number) => {
    await reopenTask(id);
    message.success("已退回重标，上一轮内容已带到新一轮");
    refresh();
  };

  const openWorkspace = (task: Task, readOnly: boolean) => {
    setWorkspaceReadOnly(readOnly);
    setWorkspaceTask(task);
  };

  const sampleCode = (id: number) => samples?.find((s) => s.id === id)?.sample_code ?? id;
  const userName = (id: number) => {
    const u = users?.find((x) => x.id === id);
    return u ? u.display_name || u.username : `#${id}`;
  };

  const tasksOf = (projectId: number) => {
    const rows = tasks?.filter((t) => t.project_id === projectId) ?? [];
    return onlyMine ? rows.filter((t) => t.assigned_to === userId) : rows;
  };
  // 标注工作台的标签按钮要取任务所属项目的标签，不能把别的项目的混进来
  const labelsOf = (projectId: number): LabelDefinition[] =>
    labels?.filter((l) => l.project_id === projectId) ?? [];

  // 样本按日期分组，导入任务时按天批量选，跟样本页的分组方式保持一致
  const samplesByDate = useMemo(() => {
    const groups = new Map<string, typeof samples>();
    for (const s of samples ?? []) {
      const key = s.session_date ?? "未知日期";
      (groups.get(key) ?? groups.set(key, []).get(key)!)!.push(s);
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [samples]);

  const alreadyImportedIds = useMemo(
    () => new Set(bulkForProject ? tasksOf(bulkForProject.id).map((t) => t.sample_id) : []),
    [bulkForProject, tasks]
  );

  const openBulkImport = (p: Project) => {
    setBulkForProject(p);
    setBulkSelected(new Set());
    setBulkTaskType("from_scratch");
    setBulkAssignee(null);
  };

  const toggleDate = (dateSamples: typeof samples, checked: boolean) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      for (const s of dateSamples ?? []) {
        if (alreadyImportedIds.has(s.id)) continue;
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  };

  const handleBulkImport = async () => {
    if (!bulkForProject || bulkSelected.size === 0) return;
    setBulkSubmitting(true);
    try {
      const r = await bulkCreateTasks({
        project_id: bulkForProject.id,
        sample_ids: [...bulkSelected],
        task_type: bulkTaskType,
        assigned_to: bulkAssignee ?? undefined,
      });
      message.success(`已导入 ${r.created} 个任务${r.skipped ? `，跳过已导入过的 ${r.skipped} 个` : ""}`);
      setBulkForProject(null);
      refresh();
    } finally {
      setBulkSubmitting(false);
    }
  };

  const visibleProjects = useMemo(() => {
    let list = projects ?? [];
    const kw = keyword.trim().toLowerCase();
    if (kw) list = list.filter((p) => p.name.toLowerCase().includes(kw));
    // 勾了"只看我的"就把没有我的任务的项目整个收起来
    if (onlyMine) list = list.filter((p) => tasksOf(p.id).length > 0);
    return list;
  }, [projects, keyword, onlyMine, tasks, userId]);

  const statusSummary = (projectId: number) => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasksOf(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  };

  const renderTaskTable = (p: Project) => {
    const rows = tasksOf(p.id);
    const projLabels = labelsOf(p.id);
    return (
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        locale={{ emptyText: onlyMine ? "这个项目下没有指派给你的任务" : "这个项目下还没有任务" }}
        columns={[
          { title: "任务ID", dataIndex: "id", width: 80 },
          { title: "样本", dataIndex: "sample_id", render: (id: number) => sampleCode(id) },
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
            width: 110,
            render: (s: TaskStatus) => <TaskStatusTag status={s} />,
          },
          {
            title: "指派给",
            dataIndex: "assigned_to",
            width: 130,
            render: (id: number | null) =>
              id == null ? <Typography.Text type="secondary">未指派</Typography.Text> : userName(id),
          },
          {
            title: "操作",
            render: (_, task: Task) => {
              // 自己锁着的进行中任务才能改，其余情况（已提交/别人在标/管理员旁观）只读
              const editable = task.status === "IN_PROGRESS" && task.locked_by === userId;
              return (
                <Space>
                  {task.status === "PENDING_ASSIGN" && (
                    <Button size="small" onClick={() => handleClaim(task.id)}>
                      认领
                    </Button>
                  )}
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      setWorkspaceLabels(projLabels);
                      openWorkspace(task, !editable);
                    }}
                  >
                    {editable ? "编辑标注" : "查看标注"}
                  </Button>
                  {(isAdmin || role === "reviewer") &&
                    (task.status === "APPROVED" || task.status === "REJECTED") && (
                      <Popconfirm
                        title="退回重标"
                        description="轮次+1，这一轮的标注内容会原样带到新一轮，任务回到待认领"
                        onConfirm={() => handleReopen(task.id)}
                      >
                        <Button size="small" type="link">
                          退回重标
                        </Button>
                      </Popconfirm>
                    )}
                  {isAdmin && (
                    <Popconfirm
                      title="删除任务"
                      description="会一并删掉该任务下的标注草稿和审核记录，不可恢复"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDelete(task.id)}
                    >
                      <Button size="small" danger type="link">
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
    );
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="按项目名搜索"
          allowClear
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button type={onlyMine ? "primary" : "default"} onClick={() => setOnlyMine((v) => !v)}>
          只看指派给我的
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          展开项目就能看到它下面的任务；项目多的时候用上面的搜索框找。
        </Typography.Text>
      </Space>

      <Table
        rowKey="id"
        loading={loadingProjects || isLoading}
        dataSource={visibleProjects}
        pagination={visibleProjects.length > 20 ? { pageSize: 20 } : false}
        locale={{
          emptyText: (
            <Empty description={onlyMine ? "没有指派给你的任务" : keyword ? "没有匹配的项目" : "还没有项目"} />
          ),
        }}
        expandable={{
          expandedRowRender: renderTaskTable,
          // 只有一个项目时默认展开，省一次点击
          defaultExpandedRowKeys: visibleProjects.length === 1 ? [visibleProjects[0].id] : [],
        }}
        columns={[
          { title: "项目ID", dataIndex: "id", width: 80 },
          {
            title: "项目",
            render: (_, p: Project) => (
              <Space>
                <strong>{p.name}</strong>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          { title: "说明", dataIndex: "description", render: (d: string | null) => d || "-" },
          {
            title: "任务",
            width: 300,
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
            title: "操作",
            width: 200,
            render: (_, p: Project) =>
              isAdmin && (
                <Space>
                  <Button size="small" type="link" onClick={() => setCreateForProject(p)}>
                    新建任务
                  </Button>
                  <Button size="small" type="link" onClick={() => openBulkImport(p)}>
                    批量导入
                  </Button>
                </Space>
              ),
          },
        ]}
      />

      <Modal
        title={`新建任务 - ${createForProject?.name ?? ""}`}
        open={createForProject != null}
        onCancel={() => setCreateForProject(null)}
        footer={null}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreateTask}>
          <Form.Item name="sample_id" label="样本" rules={[{ required: true }]}>
            <Select
              options={samples?.map((s) => ({ value: s.id, label: `#${s.id} ${s.sample_code}` }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="task_type" label="标注模式" rules={[{ required: true }]} initialValue="from_scratch">
            <Select
              options={[
                { value: "from_scratch", label: "从零标注" },
                { value: "ai_assisted", label: "AI预标注+人工修改" },
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`批量导入样本到任务 - ${bulkForProject?.name ?? ""}`}
        open={bulkForProject != null}
        onCancel={() => setBulkForProject(null)}
        onOk={handleBulkImport}
        okText={`导入选中的 ${bulkSelected.size} 个`}
        okButtonProps={{ disabled: bulkSelected.size === 0 }}
        confirmLoading={bulkSubmitting}
        width={640}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          按天勾选整批样本，一次性各建一个覆盖整个样本的任务，不用一个个点「新建任务」。
          已经在这个项目下建过任务的样本会自动跳过（灰色，勾不了）。
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text>标注模式</Typography.Text>
          <Select
            style={{ width: 200 }}
            value={bulkTaskType}
            onChange={setBulkTaskType}
            options={[
              { value: "from_scratch", label: "从零标注" },
              { value: "ai_assisted", label: "AI预标注+人工修改" },
            ]}
          />
          <Typography.Text>指派给</Typography.Text>
          <Select
            style={{ width: 160 }}
            allowClear
            placeholder="不指派（进公共池）"
            value={bulkAssignee ?? undefined}
            onChange={(v) => setBulkAssignee(v ?? null)}
            options={users
              ?.filter((u) => u.is_active && u.role !== "reviewer")
              .map((u) => ({ value: u.id, label: u.display_name || u.username }))}
          />
        </Space>
        <Collapse
          size="small"
          items={samplesByDate.map(([date, dateSamples]) => {
            const selectable = (dateSamples ?? []).filter((s) => !alreadyImportedIds.has(s.id));
            const selectedCount = selectable.filter((s) => bulkSelected.has(s.id)).length;
            const allSelected = selectable.length > 0 && selectedCount === selectable.length;
            return {
              key: date,
              label: (
                <Space onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    indeterminate={selectedCount > 0 && !allSelected}
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={(e) => toggleDate(dateSamples, e.target.checked)}
                  />
                  <span>
                    {date}（{dateSamples?.length ?? 0} 个样本
                    {selectable.length < (dateSamples?.length ?? 0) && `，${selectable.length} 个可导入`}）
                  </span>
                </Space>
              ),
              children: (
                <Space direction="vertical" size={2}>
                  {(dateSamples ?? []).map((s) => {
                    const imported = alreadyImportedIds.has(s.id);
                    return (
                      <Checkbox
                        key={s.id}
                        disabled={imported}
                        checked={bulkSelected.has(s.id)}
                        onChange={(e) =>
                          setBulkSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            return next;
                          })
                        }
                      >
                        {s.sample_code}
                        {imported && (
                          <Typography.Text type="secondary" style={{ marginLeft: 6 }}>
                            （已导入）
                          </Typography.Text>
                        )}
                      </Checkbox>
                    );
                  })}
                </Space>
              ),
            };
          })}
        />
      </Modal>

      <AnnotationWorkspace
        task={workspaceTask}
        labels={workspaceLabels}
        readOnly={workspaceReadOnly}
        onClose={() => setWorkspaceTask(null)}
        onSubmitted={refresh}
      />
    </div>
  );
}
