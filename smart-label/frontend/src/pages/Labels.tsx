import { useState } from "react";
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLabel, deleteLabel, listLabels, updateLabel } from "@/api/labels";
import ColorSwatchPicker, { PRESET_COLORS } from "@/components/ColorSwatchPicker";
import ProjectPicker from "@/components/ProjectPicker";
import { useProjectStore } from "@/stores/projectStore";
import type { LabelDefinition } from "@/types";

interface FormValues {
  code: string;
  display_name: string;
  color?: string;
  sort_order?: number;
}

export default function Labels() {
  const qc = useQueryClient();
  const projectId = useProjectStore((s) => s.currentProjectId);
  const setProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const { data, isLoading } = useQuery({
    queryKey: ["labels", projectId, "withInactive"],
    queryFn: () => listLabels(projectId ?? undefined, true),
    enabled: projectId != null,
  });
  const [editing, setEditing] = useState<LabelDefinition | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const refresh = () => qc.invalidateQueries({ queryKey: ["labels"] });

  const handleDelete = async (id: number) => {
    await deleteLabel(id);
    message.success("标签已删除");
    refresh();
  };

  const toggleActive = async (l: LabelDefinition) => {
    await updateLabel(l.id, { is_active: !l.is_active });
    message.success(l.is_active ? "已停用" : "已启用");
    refresh();
  };

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
      if (projectId == null) {
        message.warning("请先选择项目");
        return;
      }
      await createLabel({ ...values, project_id: projectId });
      message.success("创建成功");
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <ProjectPicker value={projectId} onChange={setProjectId} />
        <Button type="primary" disabled={projectId == null} onClick={openCreate}>
          新建标签
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        标签属于项目：不同项目要标的东西不一样，各自维护自己的标签，互不影响。
      </Typography.Paragraph>
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
              <Space>
                <Tag color={l.color ?? undefined} style={{ fontSize: 13 }}>
                  {l.display_name}
                </Tag>
                {!l.is_active && <Tag>已停用</Tag>}
              </Space>
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
            width: 220,
            render: (_, l: LabelDefinition) => (
              <Space>
                <Button size="small" type="link" onClick={() => openEdit(l)}>
                  编辑
                </Button>
                <Button size="small" type="link" onClick={() => toggleActive(l)}>
                  {l.is_active ? "停用" : "启用"}
                </Button>
                <Popconfirm
                  title="删除标签"
                  description="已经被标注用过的标签删不掉，那种情况请改成停用"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleDelete(l.id)}
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
