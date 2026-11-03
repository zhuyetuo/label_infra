import { useMemo } from "react";
import { Divider, Tag, TreeSelect } from "antd";
import type { LabelDefinition } from "@/types";
import { byId, chainOf, childrenMap, shortName } from "@/utils/labelTree";

type L = Pick<LabelDefinition, "id" | "display_name" | "parent_id" | "color"> & { is_active?: boolean; track?: string | null };

interface Node {
  value: number;
  title: React.ReactNode;
  /** 搜索 / 选中后框里显示的全名（抓挠-左眼周/颊） */
  fullName: string;
  /** 选中后框里显示的样子（带颜色的 Tag 或纯文本） */
  shown: React.ReactNode;
  children?: Node[];
}

/**
 * 层级选类别：抓挠 → 头颈耳 / 肩胸 / 躯干 → 部位 → 左右。
 *
 * 平铺一百多条「抓挠-左眼周/颊」「抓挠-右颈侧/颈下」……要翻半天，而肉眼能分清的多半
 * 只到三大区域。所以默认只展开到当前类别所在的那一层（选的是「抓挠-肩胸」就看到
 * 抓挠底下的几个区域），更细的部位要点开才出来。可以直接输入搜，按全名匹配。
 * recent：最近用过的几条，摆在下拉顶上一点就选。
 */
export default function LabelTreeSelect({
  labels, value, onChange, recent, placeholder, style, size = "small", autoFocus, defaultOpen, listHeight = 320,
  variant, tagLabel, title,
}: {
  labels: L[];
  value?: number | null;
  onChange: (id: number) => void;
  recent?: number[];
  placeholder?: string;
  style?: React.CSSProperties;
  size?: "small" | "middle";
  autoFocus?: boolean;
  defaultOpen?: boolean;
  listHeight?: number;
  variant?: "outlined" | "borderless" | "filled";
  /** 选中后在框里显示成带颜色的 Tag（列表里那种窄框用） */
  tagLabel?: boolean;
  title?: string;
}) {
  const usable = useMemo(() => labels.filter((l) => l.is_active !== false || l.id === value), [labels, value]);
  const map = useMemo(() => byId(usable), [usable]);
  const treeData = useMemo(() => {
    const cm = childrenMap(usable);
    const build = (p: number | null): Node[] =>
      (cm.get(p) ?? []).map((l) => {
        const kids = build(l.id);
        return {
          value: l.id,
          fullName: l.display_name,
          shown: tagLabel ? (
            <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.display_name}</Tag>
          ) : (
            l.display_name
          ),
          title: (
            <span style={{ whiteSpace: "nowrap" }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 6, background: l.color || "#999" }} />
              {p == null ? l.display_name : shortName(map, l)}
            </span>
          ),
          ...(kids.length ? { children: kids } : {}),
        };
      });
    return build(null);
  }, [usable, map, tagLabel]);

  // 默认展开：当前类别的上级链（让它在树里看得见）；当前是大类本身就把它也展开，露出区域那一层
  const expanded = useMemo(() => {
    if (value == null || !map.has(value)) return [];
    const chain = chainOf(map, value).map((l) => l.id);
    return chain.length === 1 ? chain : chain.slice(0, -1);
  }, [value, map]);

  const recentOk = (recent ?? []).filter((id) => map.has(id) && id !== value).slice(0, 6);

  return (
    <TreeSelect<number>
      size={size}
      showSearch
      style={style}
      placeholder={placeholder}
      value={value ?? undefined}
      treeData={treeData}
      treeNodeFilterProp="fullName"
      treeNodeLabelProp="shown"
      variant={variant}
      title={title}
      treeDefaultExpandedKeys={expanded}
      treeLine
      popupMatchSelectWidth={false}
      listHeight={listHeight}
      autoFocus={autoFocus}
      defaultOpen={defaultOpen}
      onChange={(v) => v != null && onChange(Number(v))}
      popupRender={(menu) => (
        <>
          {recentOk.length > 0 && (
            <div style={{ padding: "4px 8px 0" }} onMouseDown={(e) => e.preventDefault()}>
              <span style={{ fontSize: 12, color: "#888", marginRight: 4 }}>最近：</span>
              {recentOk.map((id) => (
                <Tag
                  key={id}
                  color={map.get(id)?.color || undefined}
                  style={{ cursor: "pointer", marginBottom: 4 }}
                  onClick={() => onChange(id)}
                >
                  {map.get(id)?.display_name}
                </Tag>
              ))}
              <Divider style={{ margin: "2px 0 4px" }} />
            </div>
          )}
          {menu}
        </>
      )}
    />
  );
}
