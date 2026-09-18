import { useState } from "react";
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
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
import { TRACKS, TRACK_NAME, byId, descendantIds, flatten, trackOf } from "@/utils/labelTree";

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
  parent_id?: number | null;
  track?: string | null;
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
    const linked = r.linked ? `，给已有的 ${r.linked} 个补上了上级` : "";
    if (r.created === 0 && r.skipped > 0) {
      if (r.linked) message.success(`标签都已经有了${linked}`);
      else message.warning(`本项目已有这些标签，全部跳过：${r.skipped_codes.join("、")}`);
    } else {
      message.success(
        `已添加 ${r.created} 个标签${r.skipped ? `，跳过已存在的 ${r.skipped} 个` : ""}${linked}`
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
      parent_id: null,
      track: null,
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
      parent_id: label.parent_id,
      track: label.track ?? null,
    });
    setOpen(true);
  };

  const handleSubmit = async (values: FormValues) => {
    if (editing) {
      await updateLabel(editing.id, {
        display_name: values.display_name,
        color: values.color,
        sort_order: values.sort_order,
        parent_id: values.parent_id ?? null,
        track: values.track || null,
      });
      message.success("已保存");
    } else {
      if (projectId == null) {
        message.warning("请先选择项目");
        return;
      }
      await createLabel({ ...values, parent_id: values.parent_id ?? null, track: values.track || null, project_id: projectId });
      message.success("创建成功");
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  const labelMap = byId(data ?? []);
  const flat = flatten(data ?? []);
  const rows = flat.map((f) => f.label);
  const depthOf = new Map(flat.map((f) => [f.label.id, f.depth]));
  // 上级候选：同项目里除了自己和自己子孙以外的标签，带缩进
  const excluded = editing ? descendantIds(data ?? [], [editing.id]) : new Set<number>();
  const parentOptions = flat
    .filter((f) => !excluded.has(f.label.id))
    .map((f) => ({
      value: f.label.id,
      label: `${"　".repeat(f.depth)}${f.depth ? "└ " : ""}${f.label.display_name}`,
    }));

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
        套用模板来的标签，颜色会跟着模板走——去「标签模板」页改了某个标签的颜色，
        这里同 code 的标签会跟着变；自己在这里手动改过颜色之后就不再跟随，改模板不会再覆盖回来。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        loading={isLoading}
        // 按层级排：父在前、子缩进跟在后面，一眼看出谁挂在谁下面
        dataSource={rows}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          { title: "code", dataIndex: "code" },
          {
            title: "显示名",
            render: (_, l: LabelDefinition) => (
              <Space style={{ paddingLeft: (depthOf.get(l.id) ?? 0) * 18 }}>
                {(depthOf.get(l.id) ?? 0) > 0 && <span style={{ color: "#bbb" }}>└</span>}
                <Tag color={l.color ?? undefined} style={{ fontSize: 13 }}>
                  {l.display_name}
                </Tag>
                {!l.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          {
            title: (
              <Tooltip title="层级标签：看得清标最细的（舔-前左爪），看不清停在上级（舔-前爪 / 舔）。标了细的自动算进上级：统计、导出都按树算">
                上级
              </Tooltip>
            ),
            width: 140,
            render: (_, l: LabelDefinition) =>
              l.parent_id != null && labelMap.get(l.parent_id) ? (
                <Tag color={labelMap.get(l.parent_id)!.color ?? undefined}>{labelMap.get(l.parent_id)!.display_name}</Tag>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: (
              <Tooltip title="互斥轨：同一轨的标签时间上互斥，不同轨的可以同时标（卧着 + 静止 + 舔前爪）。子标签沿用上级的轨。没分轨的标签互相互斥（老项目的行为）">
                互斥轨
              </Tooltip>
            ),
            width: 90,
            render: (_, l: LabelDefinition) => {
              const t = trackOf(labelMap, l.id);
              if (!t) return <Typography.Text type="secondary">—</Typography.Text>;
              return (
                <Typography.Text type={l.track ? undefined : "secondary"} style={{ fontSize: 12 }}>
                  {TRACK_NAME[t]}{l.track ? "" : "（沿用上级）"}
                </Typography.Text>
              );
            },
          },
          {
            title: "颜色",
            render: (_, l: LabelDefinition) =>
              l.color ? (
                <Space size={6}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 18,
                      height: 18,
                      borderRadius: 3,
                      background: l.color,
                      border: "1px solid rgba(0,0,0,0.12)",
                      verticalAlign: "middle",
                    }}
                  />
                  <span>{l.color}</span>
                  {l.template_item_id != null && (
                    <Tooltip title="颜色跟着标签模板走，去「标签模板」页改；这里手动改颜色会断开跟随">
                      <Tag color="default" style={{ marginLeft: 2 }}>
                        跟随模板
                      </Tag>
                    </Tooltip>
                  )}
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
          <Form.Item
            name="color"
            label="颜色（标注色块和标签按钮都用这个颜色）"
            extra={
              editing?.template_item_id != null
                ? "这条标签的颜色目前跟着标签模板走；在这里改颜色会断开跟随，之后改模板颜色就不会再影响它了"
                : undefined
            }
          >
            <ColorSwatchPicker />
          </Form.Item>
          <Form.Item name="sort_order" label="排序（越小越靠前）">
            <InputNumber min={0} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item
            name="parent_id"
            label="上级标签（可不填）"
            extra="层级标签：工作台第一行只显示没有上级的大类，选了大类才展开它的子类。看得清标最细的，看不清停在上级；标了细的自动算进上级"
          >
            <Select allowClear showSearch optionFilterProp="label" placeholder="没有上级" options={parentOptions} />
          </Form.Item>
          <Form.Item
            name="track"
            label="互斥轨（可不填）"
            extra="同一轨的标签时间上互斥，不同轨的可以同时标：狗可以卧着（姿态轨）、静止（运动轨）、同时舔前爪（行为轨）。有上级的标签沿用上级的轨，这里不用填。不填 = 没分轨，所有没分轨的标签互相互斥"
          >
            <Select allowClear placeholder="没分轨" options={TRACKS.map((t) => ({ value: t.key, label: `${t.name}轨 · ${t.hint}` }))} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {editing ? "保存" : "创建"}
          </Button>
        </Form>
      </Modal>
    </div>
  );
}
