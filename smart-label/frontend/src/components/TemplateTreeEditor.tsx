import { useMemo, useState } from "react";
import { Button, Input, Popconfirm, Popover, Space, Tooltip, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import ColorSwatchPicker, { PRESET_COLORS } from "@/components/ColorSwatchPicker";
import "./TemplateTreeEditor.css";

export interface TreeItem {
  key: number;
  code: string;
  display_name: string;
  color?: string | null;
  sort_order: number;
  parent_code?: string | null;
}

interface Props {
  items: TreeItem[];
  onChange: (items: TreeItem[]) => void;
}

// 内置四个大类的名字：上级不在模板里时（老模板的「抓挠-部位」）组头写它
const KNOWN_ROOT_NAMES: Record<string, string> = { scratch: "抓挠", lick_body: "舔", chew_body: "啃", rub_body: "蹭" };

type Zone = "child" | "before" | "after";

// 标签模板的树状编辑：像 xmind 那样，大类在左、子类往右展开。
//   拖一个节点放到另一个节点上 → 变成它的子类；放到节点上沿 / 下沿 → 排到它前面 / 后面（同级）；
//   拖到最下面的虚线区 → 变成大类。点节点改 code / 显示名 / 颜色，加子项，删除（子类上提）。
// 顺序就是画面上的顺序：保存时按从上到下重排 sort_order。items 数组的顺序就是兄弟之间的顺序。
export default function TemplateTreeEditor({ items, onChange }: Props) {
  const [dragKey, setDragKey] = useState<number | null>(null);
  const [hover, setHover] = useState<{ key: number | string; zone: Zone } | null>(null);
  const [editingKey, setEditingKey] = useState<number | null>(null);

  const codes = useMemo(() => new Set(items.filter((i) => i.code.trim()).map((i) => i.code.trim())), [items]);
  const byCode = useMemo(() => new Map(items.filter((i) => i.code.trim()).map((i) => [i.code.trim(), i])), [items]);
  const childrenOf = (code: string | null) =>
    items.filter((i) => {
      const p = i.parent_code?.trim() || null;
      if (code === null) return !p || !codes.has(p) ? !p : false;
      return p === code;
    });
  // 上级不在模板里的：按上级 code 归组，当"外来大类"画在最上面
  const ghostRoots = useMemo(() => {
    const out: string[] = [];
    for (const i of items) {
      const p = i.parent_code?.trim();
      if (p && !codes.has(p) && !out.includes(p)) out.push(p);
    }
    return out;
  }, [items, codes]);

  const descendants = (key: number): Set<number> => {
    const out = new Set<number>([key]);
    const walk = (k: number) => {
      const me = items.find((i) => i.key === k);
      if (!me?.code.trim()) return;
      for (const c of items.filter((i) => i.parent_code?.trim() === me.code.trim())) {
        if (!out.has(c.key)) {
          out.add(c.key);
          walk(c.key);
        }
      }
    };
    walk(key);
    return out;
  };

  const patch = (key: number, p: Partial<TreeItem>) => onChange(items.map((i) => (i.key === key ? { ...i, ...p } : i)));

  /** 把 dragged 挪到 target 的某个位置 */
  const drop = (target: TreeItem | string, zone: Zone) => {
    if (dragKey == null) return;
    const me = items.find((i) => i.key === dragKey);
    if (!me) return;
    const targetItem = typeof target === "string" ? null : target;
    if (targetItem && descendants(dragKey).has(targetItem.key)) return; // 不能拖到自己的子孙下面
    let parent: string | null;
    if (typeof target === "string") parent = target; // 外来大类
    else if (zone === "child") parent = target.code.trim() || null;
    else parent = target.parent_code?.trim() || null;
    if (zone === "child" && !parent && targetItem) return; // 目标还没填 code，挂不上
    const rest = items.filter((i) => i.key !== dragKey);
    const moved = { ...me, parent_code: parent };
    let at: number;
    if (typeof target === "string" || zone === "child") {
      // 放到目标的最后一个子类后面；没有子类就紧跟目标
      const kids = rest.filter((i) => (i.parent_code?.trim() || null) === parent);
      const anchor = kids.length ? kids[kids.length - 1] : targetItem;
      at = anchor ? rest.findIndex((i) => i.key === anchor.key) + 1 : rest.length;
    } else {
      const ti = rest.findIndex((i) => i.key === (target as TreeItem).key);
      at = zone === "before" ? ti : ti + 1;
    }
    rest.splice(at, 0, moved);
    onChange(rest);
  };

  const addChild = (parentCode: string | null) => {
    const key = Date.now();
    const parent = parentCode ? byCode.get(parentCode) : null;
    const item: TreeItem = {
      key,
      code: "",
      display_name: parent ? `${parent.display_name}-` : "",
      color: parent?.color ?? PRESET_COLORS[items.length % PRESET_COLORS.length],
      sort_order: items.length + 1,
      parent_code: parentCode,
    };
    // 紧跟在这个父的最后一个子类后面
    const kids = items.filter((i) => (i.parent_code?.trim() || null) === parentCode);
    const anchor = kids.length ? kids[kids.length - 1] : parent;
    const at = anchor ? items.findIndex((i) => i.key === anchor.key) + 1 : items.length;
    const next = [...items];
    next.splice(at, 0, item);
    onChange(next);
    setEditingKey(key);
  };

  const remove = (key: number) => {
    const me = items.find((i) => i.key === key);
    if (!me) return;
    // 子类上提到它的上级
    onChange(
      items
        .filter((i) => i.key !== key)
        .map((i) => (me.code.trim() && i.parent_code?.trim() === me.code.trim() ? { ...i, parent_code: me.parent_code ?? null } : i))
    );
  };

  const zoneOf = (e: React.DragEvent, el: HTMLElement): Zone => {
    const r = el.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "child";
  };

  const renderNode = (it: TreeItem, depth: number) => {
    const kids = it.code.trim() ? childrenOf(it.code.trim()) : [];
    const isDragging = dragKey === it.key;
    const h = hover?.key === it.key ? hover.zone : null;
    const editor = (
      <Space direction="vertical" size={6} style={{ width: 300 }}>
        <Input size="small" addonBefore="code" value={it.code} placeholder="英文，如 lick_body_fore" onChange={(e) => {
          const old = it.code.trim();
          const nw = e.target.value;
          // 改 code 时把子类的 parent_code 一起改，别断链
          onChange(items.map((i) => (i.key === it.key ? { ...i, code: nw } : old && i.parent_code?.trim() === old ? { ...i, parent_code: nw.trim() } : i)));
        }} />
        <Input size="small" addonBefore="显示名" value={it.display_name} placeholder="如 舔-前爪" onChange={(e) => patch(it.key, { display_name: e.target.value })} />
        <ColorSwatchPicker value={it.color ?? undefined} onChange={(c) => patch(it.key, { color: c })} />
        <Space>
          <Button size="small" icon={<PlusOutlined />} disabled={!it.code.trim()} onClick={() => addChild(it.code.trim())}>
            加子项
          </Button>
          <Popconfirm title="删掉这一条？它的子类会上提一级" okButtonProps={{ danger: true }} onConfirm={() => { setEditingKey(null); remove(it.key); }}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
          <Button size="small" type="link" onClick={() => setEditingKey(null)}>完成</Button>
        </Space>
      </Space>
    );
    return (
      <div className="tt-row" key={it.key}>
        <Popover open={editingKey === it.key} content={editor} trigger="click" placement="rightTop"
                 onOpenChange={(o) => setEditingKey(o ? it.key : null)}>
          <div
            className={`tt-node${isDragging ? " tt-node--dragging" : ""}${h ? ` tt-node--${h}` : ""}${depth === 0 ? " tt-node--root" : ""}`}
            style={{ background: it.color || "#999", borderColor: it.color || "#999" }}
            draggable
            onDragStart={(e) => { setDragKey(it.key); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => { setDragKey(null); setHover(null); }}
            onDragOver={(e) => { if (dragKey != null && dragKey !== it.key) { e.preventDefault(); setHover({ key: it.key, zone: zoneOf(e, e.currentTarget) }); } }}
            onDragLeave={() => setHover((prev) => (prev?.key === it.key ? null : prev))}
            onDrop={(e) => { e.preventDefault(); const z = zoneOf(e, e.currentTarget); setHover(null); drop(it, z); }}
            title="点一下改 code / 名字 / 颜色；拖到别的节点上变成它的子类，拖到上沿 / 下沿排到它前后"
          >
            <span className="tt-node__name">{it.display_name || <i style={{ opacity: 0.7 }}>（没名字）</i>}</span>
            <span className="tt-node__code">{it.code || "（没 code）"}</span>
          </div>
        </Popover>
        {(kids.length > 0 || it.code.trim()) && (
          <div className="tt-children">
            {kids.map((k) => renderNode(k, depth + 1))}
            <div className="tt-row">
              <Button size="small" type="dashed" className="tt-add" icon={<PlusOutlined />} disabled={!it.code.trim()} onClick={() => addChild(it.code.trim())} />
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tt">
      {ghostRoots.map((code) => (
        <div className="tt-row" key={`ghost:${code}`}>
          <Tooltip title={`上级「${KNOWN_ROOT_NAMES[code] ?? code}」不在模板里：套用时挂到项目里同名 / 同 code 的标签下，没有会建出来。点右边的 + 可以把它加进模板`}>
            <div
              className={`tt-node tt-node--root tt-node--ghost${hover?.key === `ghost:${code}` ? " tt-node--child" : ""}`}
              onDragOver={(e) => { if (dragKey != null) { e.preventDefault(); setHover({ key: `ghost:${code}`, zone: "child" }); } }}
              onDragLeave={() => setHover((prev) => (prev?.key === `ghost:${code}` ? null : prev))}
              onDrop={(e) => { e.preventDefault(); setHover(null); drop(code, "child"); }}
            >
              <span className="tt-node__name">{KNOWN_ROOT_NAMES[code] ?? code}</span>
              <span className="tt-node__code">{code} · 项目里的</span>
            </div>
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={() => {
              const key = Date.now();
              onChange([{ key, code, display_name: KNOWN_ROOT_NAMES[code] ?? code, color: PRESET_COLORS[0], sort_order: 0, parent_code: null }, ...items]);
              setEditingKey(key);
            }}
          >
            加进模板
          </Button>
          <div className="tt-children">{childrenOf(code).map((k) => renderNode(k, 1))}</div>
        </div>
      ))}
      {childrenOf(null).map((r) => renderNode(r, 0))}
      <div
        className={`tt-rootzone${hover?.key === "root" ? " tt-rootzone--over" : ""}`}
        onDragOver={(e) => { if (dragKey != null) { e.preventDefault(); setHover({ key: "root", zone: "child" }); } }}
        onDragLeave={() => setHover((prev) => (prev?.key === "root" ? null : prev))}
        onDrop={(e) => {
          e.preventDefault();
          setHover(null);
          if (dragKey == null) return;
          const me = items.find((i) => i.key === dragKey);
          if (!me) return;
          onChange([...items.filter((i) => i.key !== dragKey), { ...me, parent_code: null }]);
        }}
      >
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>拖到这里变成大类</Typography.Text>
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => addChild(null)}>
            加一个大类
          </Button>
        </Space>
      </div>
    </div>
  );
}
