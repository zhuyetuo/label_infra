import { useState } from "react";
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLabel, deleteLabel, listLabels, updateLabel } from "@/api/labels";
import ColorSwatchPicker, { PRESET_COLORS } from "@/components/ColorSwatchPicker";
import {
  applyLabelTemplate,
  listLabelTemplates,
  saveProjectLabelsAsTemplate,
} from "@/api/labelTemplates";
import LabelTemplates from "@/pages/LabelTemplates";
import ProjectPicker from "@/components/ProjectPicker";
import { useProjectStore } from "@/stores/projectStore";
import type { LabelDefinition } from "@/types";

// 标签模板本来是单独一个导航项，并进这里做成第二个 Tab——它跟"标签"本来就是
// 同一件事（给标注用的标签），不用单独占一条侧边栏。
export default function Labels() {
  return (
    <Tabs
      items={[
        { key: "labels", label: "标签", children: <LabelDefinitionsPanel /> },
        { key: "templates", label: "标签模板", children: <LabelTemplates /> },
      ]}
    />
  );
}

interface FormValues {
  code: string;
  display_name: string;
  color?: string;
  sort_order?: number;
}

function LabelDefinitionsPanel() {
  const qc = useQueryClient();
  const projectId = useProjectStore((s) => s.currentProjectId);
  const setProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const { data, isLoading } = useQuery({
    queryKey: ["labels", projectId, "withInactive"],
    queryFn: () => listLabels(projectId ?? undefined, true),
    enabled: projectId != null,
  });
  const { data: templates } = useQuery({ queryKey: ["label-templates"], queryFn: listLabelTemplates });
  const [editing, setEditing] = useState<LabelDefinition | null>(null);
  const [open, setOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyTemplateId, setApplyTemplateId] = useState<number | null>(null);
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [form] = Form.useForm<FormValues>();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["labels"] });
    qc.invalidateQueries({ queryKey: ["label-templates"] });
  };

  const handleApplyTemplate = async () => {
    if (projectId == null || applyTemplateId == null) return;
    const r = await applyLabelTemplate(applyTemplateId, projectId);
    if (r.created === 0 && r.skipped > 0) {
      message.warning(`本项目已有这些标签，全部跳过：${r.skipped_codes.join("、")}`);
    } else {
      message.success(
        `已添加 ${r.created} 个标签${r.skipped ? `，跳过已存在的 ${r.skipped} 个` : ""}`
      );
    }
    setApplyOpen(false);
    setApplyTemplateId(null);
    refresh();
  };

  const handleSaveAsTemplate = async () => {
    if (projectId == null || !tplName.trim()) {
      message.warning("请填模板名");
      return;
    }
    await saveProjectLabelsAsTemplate({ project_id: projectId, name: tplName.trim() });
    message.success("已存为模板，之后新建项目可以直接套用");
    setSaveTplOpen(false);
    setTplName("");
    refresh();
  };

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
        <Button disabled={projectId == null} onClick={() => setApplyOpen(true)}>
          套用模板
        </Button>
        <Button disabled={projectId == null || !data?.length} onClick={() => setSaveTplOpen(true)}>
          存为模板
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
        title="套用标签模板"
        open={applyOpen}
        onCancel={() => setApplyOpen(false)}
        onOk={handleApplyTemplate}
        okText="套用"
        okButtonProps={{ disabled: applyTemplateId == null }}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          把模板里的标签添加到当前项目；已经有同 code 的会跳过，不会覆盖。
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          placeholder="选择模板"
          value={applyTemplateId ?? undefined}
          onChange={setApplyTemplateId}
          options={templates?.map((t) => ({
            value: t.id,
            label: `${t.name}（${t.items.length} 个标签）`,
          }))}
          showSearch
          optionFilterProp="label"
        />
      </Modal>

      <Modal
        title="把当前项目的标签存为模板"
        open={saveTplOpen}
        onCancel={() => setSaveTplOpen(false)}
        onOk={handleSaveAsTemplate}
        okText="保存"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          会把当前项目里启用中的 {data?.filter((l) => l.is_active).length ?? 0} 个标签存成一个模板，
          之后新建项目可以直接套用。
        </Typography.Paragraph>
        <Input placeholder="模板名" value={tplName} onChange={(e) => setTplName(e.target.value)} />
      </Modal>

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
