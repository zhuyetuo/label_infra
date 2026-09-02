import { useState } from "react";
import { Button, Form, Input, Modal, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLabel, listLabels } from "@/api/labels";

export default function Labels() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["labels"], queryFn: listLabels });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const handleCreate = async (values: { code: string; display_name: string; color?: string }) => {
    await createLabel(values);
    message.success("创建成功");
    setOpen(false);
    form.resetFields();
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => setOpen(true)}>
          新建标签
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          { title: "code", dataIndex: "code" },
          { title: "显示名", dataIndex: "display_name" },
          {
            title: "颜色",
            dataIndex: "color",
            render: (c: string | null) => (c ? <Tag color={c}>{c}</Tag> : "-"),
          },
          { title: "排序", dataIndex: "sort_order" },
        ]}
      />
      <Modal title="新建标签" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="code" label="code（英文，如 scratch）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="display_name" label="显示名（如 抓挠）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="color" label="颜色（如 #F44336）">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
