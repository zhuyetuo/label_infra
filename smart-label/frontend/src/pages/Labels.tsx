import { useState } from "react";
import { Button, Form, Input, InputNumber, Modal, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLabel, listLabels, updateLabel } from "@/api/labels";
import ColorSwatchPicker, { PRESET_COLORS } from "@/components/ColorSwatchPicker";
import type { LabelDefinition } from "@/types";

interface FormValues {
  code: string;
  display_name: string;
  color?: string;
  sort_order?: number;
}

export default function Labels() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["labels"], queryFn: listLabels });
  const [editing, setEditing] = useState<LabelDefinition | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const refresh = () => qc.invalidateQueries({ queryKey: ["labels"] });

  const openCreate = () => {
    setEditing(null);
    // 新建时按已有标签数量顺延一个预设色，省得每次都自己挑
    const nextColor = PRESET_COLORS[(data?.length ?? 0) % PRESET_COLORS.length];
    form.setFieldsValue({
      code: "",
      display_name: "",
      color: nextColor,
      sort_order: (data?.length ?? 0) + 1,
    });
    setOpen(true);
  };

  const openEdit = (label: LabelDefinition) => {
    setEditing(label);
    form.setFieldsValue({
      code: label.code,
      display_name: label.display_name,
      color: label.color ?? PRESET_COLORS[0],
      sort_order: label.sort_order,
    });
    setOpen(true);
  };

  const handleSubmit = async (values: FormValues) => {
    if (editing) {
      await updateLabel(editing.id, {
        display_name: values.display_name,
        color: values.color,
        sort_order: values.sort_order,
      });
      message.success("已保存");
    } else {
      await createLabel(values);
      message.success("创建成功");
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreate}>
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
          {
            title: "显示名",
            render: (_, l: LabelDefinition) => (
              <Tag color={l.color ?? undefined} style={{ fontSize: 13 }}>
                {l.display_name}
              </Tag>
            ),
          },
          {
            title: "颜色",
            dataIndex: "color",
            render: (c: string | null) =>
              c ? (
                <Space size={6}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 18,
                      height: 18,
                      borderRadius: 3,
                      background: c,
                      border: "1px solid rgba(0,0,0,0.12)",
                      verticalAlign: "middle",
                    }}
                  />
                  <span>{c}</span>
                </Space>
              ) : (
                "-"
              ),
          },
          { title: "排序", dataIndex: "sort_order", width: 80 },
          {
            title: "操作",
            width: 100,
            render: (_, l: LabelDefinition) => (
              <Button size="small" type="link" onClick={() => openEdit(l)}>
                编辑
              </Button>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? `编辑标签 - ${editing.display_name}` : "新建标签"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="code" label="code（英文，如 scratch）" rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="display_name" label="显示名（如 抓挠）" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="color" label="颜色（标注色块和标签按钮都用这个颜色）">
            <ColorSwatchPicker />
          </Form.Item>
          <Form.Item name="sort_order" label="排序（越小越靠前）">
            <InputNumber min={0} style={{ width: 120 }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {editing ? "保存" : "创建"}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
