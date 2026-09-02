import { useState } from "react";
import {
  Button,
  Drawer,
  Form,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
  Popconfirm,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimTask, createTask, getDraft, listTasks, saveDraft, submitTask } from "@/api/tasks";
import { listSamples } from "@/api/samples";
import { listLabels } from "@/api/labels";
import { useAuthStore } from "@/stores/authStore";
import type { LabelItem, Task, TaskStatus } from "@/types";

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
  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: listTasks });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: listLabels });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();

  const [draftTaskId, setDraftTaskId] = useState<number | null>(null);
  const [draftItems, setDraftItems] = useState<LabelItem[]>([]);
  const [itemForm] = Form.useForm();

  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks"] });

  const handleCreateTask = async (values: {
    sample_id: number;
    task_type: "from_scratch" | "ai_assisted";
  }) => {
    await createTask(values);
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

  const openDraft = async (id: number) => {
    setDraftTaskId(id);
    const draft = await getDraft(id);
    setDraftItems(draft.items);
  };

  const addDraftItem = (values: { label_id: number; start_time_ms: number; end_time_ms: number }) => {
    setDraftItems((prev) => [
      ...prev,
      {
        id: -Date.now(),
        label_id: values.label_id,
        start_time_ms: values.start_time_ms,
        end_time_ms: values.end_time_ms,
        origin_item_id: null,
        source_type: "human_added",
        is_modified: false,
        ai_confidence: null,
        created_by: userId ?? null,
      },
    ]);
    itemForm.resetFields();
  };

  const removeDraftItem = (id: number) => setDraftItems((prev) => prev.filter((i) => i.id !== id));

  const handleSaveDraft = async () => {
    if (draftTaskId == null) return;
    await saveDraft(
      draftTaskId,
      draftItems.map((i) => ({
        label_id: i.label_id,
        start_time_ms: i.start_time_ms,
        end_time_ms: i.end_time_ms,
        origin_item_id: i.origin_item_id ?? undefined,
      }))
    );
    message.success("草稿已保存");
  };

  const handleSubmit = async () => {
    if (draftTaskId == null) return;
    await handleSaveDraft();
    await submitTask(draftTaskId);
    message.success("已提交，等待审核");
    setDraftTaskId(null);
    refresh();
  };

  const labelName = (id: number) => labels?.find((l) => l.id === id)?.display_name ?? id;

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        {role === "admin" && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
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
          { title: "样本ID", dataIndex: "sample_id" },
          { title: "类型", dataIndex: "task_type" },
          { title: "轮次", dataIndex: "round_no", width: 60 },
          {
            title: "状态",
            dataIndex: "status",
            render: (s: TaskStatus) => <Tag color={statusColor[s]}>{s}</Tag>,
          },
          { title: "认领人ID", dataIndex: "assigned_to" },
          {
            title: "操作",
            render: (_, task: Task) => (
              <Space>
                {task.status === "PENDING_ASSIGN" && (
                  <Button size="small" onClick={() => handleClaim(task.id)}>
                    认领
                  </Button>
                )}
                {task.status === "IN_PROGRESS" && task.locked_by === userId && (
                  <Button size="small" type="link" onClick={() => openDraft(task.id)}>
                    编辑标注
                  </Button>
                )}
              </Space>
            ),
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

      <Drawer
        title={`编辑标注 - 任务 #${draftTaskId}`}
        open={draftTaskId != null}
        onClose={() => setDraftTaskId(null)}
        width={520}
        extra={
          <Space>
            <Button onClick={handleSaveDraft}>存草稿</Button>
            <Popconfirm title="确认提交？提交后进入审核队列" onConfirm={handleSubmit}>
              <Button type="primary">提交</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Form form={itemForm} layout="inline" onFinish={addDraftItem} style={{ marginBottom: 16 }}>
          <Form.Item name="label_id" rules={[{ required: true }]}>
            <Select
              placeholder="标签"
              style={{ width: 120 }}
              options={labels?.map((l) => ({ value: l.id, label: l.display_name }))}
            />
          </Form.Item>
          <Form.Item name="start_time_ms" rules={[{ required: true }]}>
            <InputNumber placeholder="开始(ms)" style={{ width: 110 }} />
          </Form.Item>
          <Form.Item name="end_time_ms" rules={[{ required: true }]}>
            <InputNumber placeholder="结束(ms)" style={{ width: 110 }} />
          </Form.Item>
          <Button htmlType="submit">添加</Button>
        </Form>

        <Table
          size="small"
          rowKey="id"
          dataSource={draftItems}
          pagination={false}
          columns={[
            { title: "标签", render: (_, i: LabelItem) => labelName(i.label_id) },
            { title: "开始(ms)", dataIndex: "start_time_ms" },
            { title: "结束(ms)", dataIndex: "end_time_ms" },
            { title: "来源", dataIndex: "source_type" },
            {
              title: "",
              render: (_, i: LabelItem) => (
                <Button size="small" danger type="link" onClick={() => removeDraftItem(i.id)}>
                  删除
                </Button>
              ),
            },
          ]}
        />
      </Drawer>
    </div>
  );
}
