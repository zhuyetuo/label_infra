import { useState } from "react";
import { Button, Form, Modal, Popconfirm, Select, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimTask, createTask, deleteTask, listTasks, reopenTask } from "@/api/tasks";
import { listSamples } from "@/api/samples";
import { listLabels } from "@/api/labels";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import ProjectPicker from "@/components/ProjectPicker";
import { useProjectStore } from "@/stores/projectStore";
import { useAuthStore } from "@/stores/authStore";
import type { Task, TaskStatus } from "@/types";

const statusColor: Record<TaskStatus, string> = {
  PENDING_ASSIGN: "default",
  IN_PROGRESS: "blue",
  SUBMITTED: "orange",
  APPROVED: "green",
  REJECTED: "red",
};

export default function Tasks() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  const projectId = useProjectStore((s) => s.currentProjectId);
  const setProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const { data: tasks, isLoading } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => listTasks(projectId ?? undefined),
  });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  // /users 只对管理员开放，其他角色拿不到就退回显示ID
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: role === "admin" });
  // 标注工作台里的标签按钮要按任务所属项目取，不能把别的项目的标签混进来
  const { data: labels } = useQuery({
    queryKey: ["labels", projectId],
    queryFn: () => listLabels(projectId ?? undefined),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [workspaceTask, setWorkspaceTask] = useState<Task | null>(null);
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks"] });

  const handleCreateTask = async (values: {
    sample_id: number;
    task_type: "from_scratch" | "ai_assisted";
  }) => {
    if (projectId == null) {
      message.warning("请先选择项目");
      return;
    }
    await createTask({ ...values, project_id: projectId });
    message.success("任务已创建");
    setCreateOpen(false);
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

  const sampleCode = (id: number) => samples?.find((s) => s.id === id)?.sample_code;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <ProjectPicker value={projectId} onChange={setProjectId} />
        {role === "admin" && (
          <Button type="primary" disabled={projectId == null} onClick={() => setCreateOpen(true)}>
            新建任务
          </Button>
        )}
      </Space>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={tasks}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          {
            title: "样本",
            dataIndex: "sample_id",
            render: (id: number) => sampleCode(id) ?? id,
          },
          { title: "类型", dataIndex: "task_type" },
          { title: "轮次", dataIndex: "round_no", width: 60 },
          {
            title: "状态",
            dataIndex: "status",
            render: (s: TaskStatus) => <Tag color={statusColor[s]}>{s}</Tag>,
          },
          {
            title: "指派给",
            dataIndex: "assigned_to",
            render: (id: number | null) => {
              if (id == null) return <span style={{ color: "#999" }}>未指派</span>;
              const u = users?.find((x) => x.id === id);
              return u ? u.display_name || u.username : `#${id}`;
            },
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
                  <Button size="small" type="link" onClick={() => openWorkspace(task, !editable)}>
                    {editable ? "编辑标注" : "查看标注"}
                  </Button>
                  {(role === "admin" || role === "reviewer") &&
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
                  {role === "admin" && (
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

      <Modal title="新建任务" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnClose>
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

      <AnnotationWorkspace
        task={workspaceTask}
        labels={labels ?? []}
        readOnly={workspaceReadOnly}
        onClose={() => setWorkspaceTask(null)}
        onSubmitted={refresh}
      />
    </div>
  );
}
