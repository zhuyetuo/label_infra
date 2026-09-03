import { useMemo, useState } from "react";
import { Button, Empty, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimTask, deleteTask, listTasks, releaseTask, reopenTask } from "@/api/tasks";
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
  const isAdmin = role === "admin" || role === "super_admin";

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
  const [workspaceTask, setWorkspaceTask] = useState<Task | null>(null);
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  // 打开工作台时把该任务所属项目的标签带进去
  const [workspaceLabels, setWorkspaceLabels] = useState<LabelDefinition[]>([]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
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

  const handleRelease = async (id: number) => {
    await releaseTask(id);
    message.success("已放弃，任务退回公共池，草稿已保留");
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
            width: 150,
            render: (s: TaskStatus, task: Task) => (
              <Space size={4}>
                <TaskStatusTag status={s} />
                {/* 之前有人标了一半又放弃了，草稿还在，接手的人不用从零开始 */}
                {s === "PENDING_ASSIGN" && task.has_draft && <Tag color="gold">有草稿</Tag>}
                {/* 被驳回时把审核意见带出来，不用另外去问审核员为什么 */}
                {s === "REJECTED" && task.review_comment && (
                  <Tooltip title={task.review_comment}>
                    <Tag color="red" style={{ cursor: "help" }}>
                      审核意见
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            ),
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
                  {editable && (
                    <Popconfirm
                      title="放弃任务"
                      description="退回公共池，别人可以接手；已经标的内容会保留成草稿，不会丢"
                      onConfirm={() => handleRelease(task.id)}
                    >
                      <Button size="small" type="link">
                        放弃
                      </Button>
                    </Popconfirm>
                  )}
                  {((isAdmin || role === "reviewer") &&
                    (task.status === "APPROVED" || task.status === "REJECTED")) ||
                  // 被驳回的任务，标注员本人不用等审核员/管理员，自己就能点着重标
                  (task.status === "REJECTED" && task.assigned_to === userId) ? (
                    <Popconfirm
                      title="退回重标"
                      description="轮次+1，这一轮的标注内容会原样带到新一轮，任务回到待认领"
                      onConfirm={() => handleReopen(task.id)}
                    >
                      <Button size="small" type="link">
                        退回重标
                      </Button>
                    </Popconfirm>
                  ) : null}
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
          // 点行内空白处就能展开，不用非得点最左边那个小箭头
          expandRowByClick: true,
          // 一个任务都没有的项目不给展开箭头，一眼就能看出哪些项目还没建任务
          rowExpandable: (p: Project) => tasksOf(p.id).length > 0,
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
        ]}
      />

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
