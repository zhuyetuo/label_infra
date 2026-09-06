import { useMemo, useState } from "react";
import { Button, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createDog, deleteDog, listDogs, updateDog, type Dog } from "@/api/dogs";
import { listSamples } from "@/api/samples";
import { listTasks } from "@/api/tasks";
import { TASK_STATUS_META } from "@/utils/taskStatus";
import type { Sample, TaskStatus } from "@/types";

interface FormValues {
  dog_code: string;
  name?: string;
  breed?: string;
  remark?: string;
}

// 狗档案：现在主要靠样本扫描时按文件名里的 dog 编号自动建档（采集端还没开始
// 带这个信息之前基本是空的），这里补一套手动管理 + 每只狗的样本总览（按
// 日期分组，能看出这只狗每天的数据处于哪个标注阶段）。
export default function Dogs() {
  const qc = useQueryClient();
  const { data: dogs, isLoading } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const { data: tasks } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Dog | null>(null);
  const [form] = Form.useForm<FormValues>();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dogs"] });
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  const samplesOf = (dogId: number) => samples?.filter((s) => s.dog_id === dogId) ?? [];
  const tasksOfSample = (sampleId: number) => tasks?.filter((t) => t.sample_id === sampleId) ?? [];

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (dog: Dog) => {
    setEditing(dog);
    form.setFieldsValue({
      dog_code: dog.dog_code,
      name: dog.name ?? undefined,
      breed: dog.breed ?? undefined,
      remark: dog.remark ?? undefined,
    });
    setOpen(true);
  };

  const handleSubmit = async (values: FormValues) => {
    if (editing) {
      await updateDog(editing.id, { name: values.name, breed: values.breed, remark: values.remark });
      message.success("已保存");
    } else {
      await createDog(values);
      message.success("已创建");
    }
    setOpen(false);
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteDog(id);
    message.success("已删除");
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button type="primary" onClick={openCreate}>
          新建狗档案
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        狗编号（dog_code）现在主要靠样本扫描时从文件名里自动识别建档，采集端还没开始带这个信息之前基本用不上；
        新建/手动关联样本是在文件名规则落地前的过渡办法。点左侧箭头能展开看这只狗每天的样本和标注进度。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={dogs}
        expandable={{
          expandRowByClick: true,
          rowExpandable: (d: Dog) => samplesOf(d.id).length > 0,
          expandedRowRender: (d: Dog) => <DogTimeline samples={samplesOf(d.id)} tasksOfSample={tasksOfSample} />,
        }}
        columns={[
          { title: "编号", dataIndex: "dog_code", width: 120 },
          { title: "名字", dataIndex: "name", render: (v: string | null) => v || "-" },
          { title: "品种", dataIndex: "breed", render: (v: string | null) => v || "-" },
          { title: "备注", dataIndex: "remark", render: (v: string | null) => v || "-" },
          {
            title: "样本数",
            width: 90,
            render: (_, d: Dog) => samplesOf(d.id).length,
          },
          {
            title: "操作",
            width: 160,
            render: (_, d: Dog) => (
              <Space onClick={(e) => e.stopPropagation()}>
                <Button size="small" type="link" onClick={() => openEdit(d)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除狗档案"
                  description="还有样本关联着的话删不掉"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleDelete(d.id)}
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
        title={editing ? `编辑 - ${editing.dog_code}` : "新建狗档案"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="dog_code" label="编号" rules={[{ required: true }]}>
            <Input disabled={!!editing} placeholder="跟文件名里 _dog 后面那段对应" />
          </Form.Item>
          <Form.Item name="name" label="名字">
            <Input />
          </Form.Item>
          <Form.Item name="breed" label="品种">
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {editing ? "保存" : "创建"}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}

// 这只狗的样本按日期分组，每个样本再列出关联任务当前的标注阶段——
// 就是"每只狗每天数据情况"看板的第一版：原始/AI预标注/已审核这几个阶段
// 直接复用现有的 Task.status（AI预标注对应的是还没真正接推理服务，
// 暂时不会出现，等接上了这里不用改，数据自然就会出现在这一档）。
function DogTimeline({
  samples,
  tasksOfSample,
}: {
  samples: Sample[];
  tasksOfSample: (sampleId: number) => { status: TaskStatus }[];
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of samples) {
      const key = s.session_date ?? "未知日期";
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [samples]);

  return (
    <Table
      size="small"
      rowKey={(g) => g[0]}
      dataSource={groups}
      pagination={groups.length > 10 ? { pageSize: 10 } : false}
      columns={[
        { title: "日期", render: (g: [string, Sample[]]) => g[0], width: 140 },
        { title: "样本数", render: (g: [string, Sample[]]) => g[1].length, width: 90 },
        {
          title: "标注进度",
          render: (g: [string, Sample[]]) => (
            <Space size={4} wrap>
              {g[1].map((s) => {
                const statuses = tasksOfSample(s.id);
                if (statuses.length === 0) {
                  return (
                    <Tag key={s.id} title={s.sample_code}>
                      {s.sample_code} 未建任务
                    </Tag>
                  );
                }
                return statuses.map((t, i) => (
                  <Tag key={`${s.id}-${i}`} color={TASK_STATUS_META[t.status]?.color} title={s.sample_code}>
                    {s.sample_code} {TASK_STATUS_META[t.status]?.label ?? t.status}
                  </Tag>
                ));
              })}
            </Space>
          ),
        },
      ]}
    />
  );
}
