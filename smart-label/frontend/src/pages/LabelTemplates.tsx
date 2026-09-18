import type React from "react";
import { useState } from "react";
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyLabelTemplate,
  createLabelTemplate,
  deleteLabelTemplate,
  listLabelTemplates,
  updateLabelTemplate,
  type LabelTemplate,
  type LabelTemplateItem,
} from "@/api/labelTemplates";
import { listProjects } from "@/api/projects";
import ColorSwatchPicker, { PRESET_COLORS } from "@/components/ColorSwatchPicker";

interface EditItem extends Omit<LabelTemplateItem, "id"> {
  key: number;
}

// 标签模板：常用的一套标签存下来，新项目直接套用，不用每次重新配。
// 显示名/排序是"拷贝"：套用后各自演进，互不影响。颜色例外：改这里的颜色会
// 同步到套用过它、且没在项目里被手动改过颜色的那些标签（后端 _replace_items）。
export default function LabelTemplates() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["label-templates"], queryFn: listLabelTemplates });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LabelTemplate | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<EditItem[]>([]);
  const [saving, setSaving] = useState(false);

  const [applyTarget, setApplyTarget] = useState<LabelTemplate | null>(null);
  const [applyProjectId, setApplyProjectId] = useState<number | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["label-templates"] });
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  const openCreate = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setItems([]);
    setOpen(true);
  };

  const openEdit = (t: LabelTemplate) => {
    setEditing(t);
    setName(t.name);
    setDescription(t.description ?? "");
    setItems(
      t.items.map((i, idx) => ({
        key: idx,
        code: i.code,
        display_name: i.display_name,
        color: i.color ?? PRESET_COLORS[idx % PRESET_COLORS.length],
        sort_order: i.sort_order,
        parent_code: i.parent_code ?? null,
      }))
    );
    setOpen(true);
  };

  // 新增的行放最前面：模板动辄十几条标签，加在末尾的话每次都要滚到底部才能填，很烦
  const addRow = () =>
    setItems((prev) => [
      {
        key: Date.now(),
        code: "",
        display_name: "",
        color: PRESET_COLORS[prev.length % PRESET_COLORS.length],
        sort_order: prev.length + 1,
        parent_code: null,
      },
      ...prev,
    ]);

  const patchRow = (key: number, patch: Partial<EditItem>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const handleSave = async () => {
    if (!name.trim()) {
      message.warning("请填模板名");
      return;
    }
    const bad = items.find((i) => !i.code.trim() || !i.display_name.trim());
    if (bad) {
      message.warning("每条标签的 code 和显示名都要填");
      return;
    }
    const payload = items.map(({ code, display_name, color, sort_order, parent_code }) => ({
      code: code.trim(),
      display_name: display_name.trim(),
      color,
      sort_order,
      parent_code: parent_code?.trim() || null,
    }));
    setSaving(true);
    try {
      if (editing) {
        await updateLabelTemplate(editing.id, { name, description, items: payload });
        message.success("模板已保存");
      } else {
        await createLabelTemplate({ name, description, items: payload });
        message.success("模板已创建");
      }
      setOpen(false);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    if (!applyTarget || applyProjectId == null) return;
    const r = await applyLabelTemplate(applyTarget.id, applyProjectId);
    if (r.created === 0 && r.skipped > 0) {
      message.warning(`该项目已有这些标签，全部跳过：${r.skipped_codes.join("、")}`);
    } else {
      message.success(
        `已添加 ${r.created} 个标签${r.skipped ? `，跳过已存在的 ${r.skipped} 个（${r.skipped_codes.join("、")}）` : ""}`
      );
    }
    setApplyTarget(null);
    setApplyProjectId(null);
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button type="primary" onClick={openCreate}>
          新建模板
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        把常用的一套标签存成模板，新建项目时直接套用，不用每次重新配一遍。
        显示名/排序这些是「拷贝」：套用之后各项目自己改不会影响模板，改项目标签也不会回写模板。
        颜色是例外——这里改了某个标签的颜色，会自动同步到所有套用过这个模板、且还没在项目里
        手动改过这个标签颜色的地方；项目自己手动改过颜色的会断开跟随，不再受这里影响。
        也可以在「标签管理」页把某个项目现有的标签一键存成模板（存的时候也会建立跟随关系）。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          { title: "模板名", dataIndex: "name", render: (n: string) => <strong>{n}</strong> },
          { title: "说明", dataIndex: "description", render: (d: string | null) => d || "-" },
          {
            title: "标签",
            render: (_, t: LabelTemplate) =>
              t.items.length ? (
                <TemplateItemsView items={t.items} />
              ) : (
                <Typography.Text type="secondary">（空模板）</Typography.Text>
              ),
          },
          {
            title: "操作",
            width: 220,
            render: (_, t: LabelTemplate) => (
              <Space>
                <Button size="small" type="link" onClick={() => setApplyTarget(t)}>
                  套用到项目
                </Button>
                <Button size="small" type="link" onClick={() => openEdit(t)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除模板"
                  description="只删模板本身，已经套用到项目里的标签不受影响"
                  okButtonProps={{ danger: true }}
                  onConfirm={async () => {
                    await deleteLabelTemplate(t.id);
                    message.success("模板已删除");
                    refresh();
                  }}
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
        title={editing ? `编辑模板 - ${editing.name}` : "新建模板"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        width={860}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input placeholder="模板名" value={name} onChange={(e) => setName(e.target.value)} />
          <Input.TextArea
            rows={2}
            placeholder="说明（这套标签用在什么场景）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Space>
            <Button size="small" onClick={addRow}>
              添加一条标签
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {items.length} 条
            </Typography.Text>
          </Space>
          <Table
            size="small"
            rowKey="key"
            dataSource={items}
            pagination={false}
            scroll={{ y: 320 }}
            locale={{ emptyText: "还没有标签，点上面的「添加一条标签」" }}
            columns={[
              {
                title: "code（英文）",
                width: 160,
                render: (_, r: EditItem) => (
                  <Input
                    size="small"
                    value={r.code}
                    placeholder="scratch"
                    onChange={(e) => patchRow(r.key, { code: e.target.value })}
                  />
                ),
              },
              {
                title: "显示名",
                width: 160,
                render: (_, r: EditItem) => (
                  <Input
                    size="small"
                    value={r.display_name}
                    placeholder="抓挠"
                    onChange={(e) => patchRow(r.key, { display_name: e.target.value })}
                  />
                ),
              },
              {
                title: "颜色",
                render: (_, r: EditItem) => (
                  <ColorSwatchPicker
                    value={r.color ?? undefined}
                    onChange={(c) => patchRow(r.key, { color: c })}
                  />
                ),
              },
              {
                title: (
                  <Tooltip title="层级标签的上级（按 code）。一般选模板里另一条；也可以填项目里已有的 code（比如「抓挠-头颈耳」挂到项目自己的「抓挠」下），套用时按项目里的标签找">
                    上级 code
                  </Tooltip>
                ),
                width: 170,
                render: (_, r: EditItem) => (
                  <Select
                    size="small"
                    style={{ width: "100%" }}
                    allowClear
                    showSearch
                    mode="tags"
                    maxCount={1}
                    placeholder="无"
                    value={r.parent_code ? [r.parent_code] : []}
                    onChange={(v: string[]) => patchRow(r.key, { parent_code: v.length ? v[v.length - 1].trim() : null })}
                    options={items
                      .filter((i) => i.key !== r.key && i.code.trim())
                      .map((i) => ({ value: i.code.trim(), label: `${i.display_name || i.code}（${i.code}）` }))}
                  />
                ),
              },
              {
                title: "",
                width: 60,
                render: (_, r: EditItem) => (
                  <Button
                    size="small"
                    danger
                    type="link"
                    onClick={() => setItems((prev) => prev.filter((i) => i.key !== r.key))}
                  >
                    删除
                  </Button>
                ),
              },
            ]}
          />
        </Space>
      </Modal>

      <Modal
        title={`套用模板 - ${applyTarget?.name ?? ""}`}
        open={applyTarget != null}
        onCancel={() => setApplyTarget(null)}
        onOk={handleApply}
        okText="套用"
        okButtonProps={{ disabled: applyProjectId == null }}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          会把模板里的 {applyTarget?.items.length ?? 0} 个标签添加到所选项目。
          项目里已经有同 code 的标签会跳过，不会覆盖（那些可能已经被标注引用了）。
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          placeholder="选择要套用到哪个项目"
          value={applyProjectId ?? undefined}
          onChange={(v) => setApplyProjectId(v)}
          options={projects?.map((p) => ({ value: p.id, label: p.name }))}
          showSearch
          optionFilterProp="label"
        />
      </Modal>
    </div>
  );
}


// 模板里的标签：有父子关系的按树摆（父在前，子缩进跟在后面一行），平级的照旧一排。
// 上级不在模板里的（「抓挠-部位」挂项目自己的「抓挠」）当一组，组头写成灰的。
function TemplateItemsView({ items }: { items: LabelTemplateItem[] }) {
  const codes = new Set(items.map((i) => i.code));
  const hasTree = items.some((i) => i.parent_code);
  if (!hasTree) {
    return (
      <Space size={4} wrap>
        {items.map((i) => (
          <Tag key={i.code} color={i.color ?? undefined}>
            {i.display_name}
          </Tag>
        ))}
      </Space>
    );
  }
  const kids = new Map<string, LabelTemplateItem[]>();
  const roots: { key: string; item: LabelTemplateItem | null }[] = [];
  const seenRoot = new Set<string>();
  for (const i of items) {
    const p = i.parent_code ?? null;
    if (p && codes.has(p)) {
      kids.set(p, [...(kids.get(p) ?? []), i]);
    } else if (p) {
      // 上级不在模板里：按上级 code 归一组
      kids.set(p, [...(kids.get(p) ?? []), i]);
      if (!seenRoot.has(p)) {
        seenRoot.add(p);
        roots.push({ key: p, item: null });
      }
    } else {
      roots.push({ key: i.code, item: i });
    }
  }
  const short = (i: LabelTemplateItem, rootName: string) =>
    i.display_name.startsWith(rootName + "-") ? i.display_name.slice(rootName.length + 1) : i.display_name;
  const renderKids = (code: string, rootName: string, depth: number): React.ReactNode =>
    (kids.get(code) ?? []).map((c) => (
      <span key={c.code} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        <span style={{ color: "#999", fontSize: 11 }}>{depth > 1 ? "··" : "›"}</span>
        <Tag color={c.color ?? undefined} style={{ marginRight: 0 }}>
          {short(c, rootName)}
        </Tag>
        {renderKids(c.code, rootName, depth + 1)}
      </span>
    ));
  const ROOT_NAMES: Record<string, string> = { scratch: "抓挠", lick_body: "舔", chew_body: "啃", rub_body: "蹭" };
  return (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      {roots.map((r) => {
        const name = r.item ? r.item.display_name : ROOT_NAMES[r.key] ?? r.key;
        return (
          <Space key={r.key} size={4} wrap>
            {r.item ? (
              <Tag color={r.item.color ?? undefined} style={{ fontWeight: 600 }}>
                {r.item.display_name}
              </Tag>
            ) : (
              <Tooltip title={`上级「${name}」不在模板里，套用时挂到项目里已有的「${name}」下（没有会建出来）`}>
                <Tag style={{ fontWeight: 600, borderStyle: "dashed" }}>{name}</Tag>
              </Tooltip>
            )}
            {renderKids(r.key, name, 1)}
          </Space>
        );
      })}
    </Space>
  );
}
