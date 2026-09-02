import { ColorPicker, Space, Tooltip, Typography } from "antd";

// 一排常用色直接点选，覆盖大部分场景；实在要别的颜色再用右边的取色器。
// 挑的是彼此区分度高、在白底上画半透明色块也看得清的颜色。
export const PRESET_COLORS = [
  "#f5222d", // 红
  "#fa541c", // 橙红
  "#fa8c16", // 橙
  "#faad14", // 黄
  "#a0d911", // 青柠
  "#52c41a", // 绿
  "#13c2c2", // 青
  "#1677ff", // 蓝
  "#2f54eb", // 深蓝
  "#722ed1", // 紫
  "#eb2f96", // 品红
  "#8c8c8c", // 灰
];

interface Props {
  value?: string;
  onChange?: (color: string) => void;
}

export default function ColorSwatchPicker({ value, onChange }: Props) {
  return (
    <Space wrap size={6} align="center">
      {PRESET_COLORS.map((c) => {
        const selected = value?.toLowerCase() === c.toLowerCase();
        return (
          <Tooltip key={c} title={c}>
            <div
              role="button"
              aria-label={c}
              onClick={() => onChange?.(c)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 4,
                background: c,
                cursor: "pointer",
                // 选中的加一圈描边，比单纯打勾更好认
                boxShadow: selected ? `0 0 0 2px #fff inset, 0 0 0 2px ${c}` : "none",
                border: "1px solid rgba(0,0,0,0.12)",
              }}
            />
          </Tooltip>
        );
      })}
      <ColorPicker
        value={value}
        onChangeComplete={(c) => onChange?.(c.toHexString())}
        presets={[{ label: "常用", colors: PRESET_COLORS }]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {value ?? "未选择"}
      </Typography.Text>
    </Space>
  );
}
