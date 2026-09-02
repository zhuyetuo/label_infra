import {
  blue,
  cyan,
  geekblue,
  gold,
  green,
  grey,
  lime,
  magenta,
  orange,
  purple,
  red,
  volcano,
  yellow,
} from "@ant-design/colors";
import { ColorPicker, Space, Tooltip, Typography } from "antd";

// 13个色系 x 4个深浅 = 52 个可选色，够几十个标签一人一个还彼此分得开。
// 用的是 antd 自己的色板，同一行明度接近、同一列色相接近，找色方便。
const HUES = [red, volcano, orange, gold, yellow, lime, green, cyan, blue, geekblue, purple, magenta, grey];
// antd 色板 index：4≈亮、5≈标准、7≈深、8≈更深（0-3太浅，画半透明色块看不清）
const SHADE_INDEXES = [4, 5, 7, 8];

export const COLOR_GRID: string[][] = SHADE_INDEXES.map((shade) => HUES.map((hue) => hue[shade]));

// 默认按这一行顺序给新标签配色（明度适中、区分度最好的一档）
export const PRESET_COLORS = COLOR_GRID[1];

interface Props {
  value?: string;
  onChange?: (color: string) => void;
}

export default function ColorSwatchPicker({ value, onChange }: Props) {
  const current = value?.toLowerCase();

  return (
    <div>
      <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
        {COLOR_GRID.map((row, rowIdx) => (
          <div key={rowIdx} style={{ display: "flex", gap: 4 }}>
            {row.map((c) => {
              const selected = current === c.toLowerCase();
              return (
                <Tooltip key={c} title={c}>
                  <div
                    role="button"
                    aria-label={c}
                    onClick={() => onChange?.(c)}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      background: c,
                      cursor: "pointer",
                      // 选中的加一圈描边，比打勾更好认
                      boxShadow: selected ? `0 0 0 2px #fff inset, 0 0 0 2px ${c}` : "none",
                      border: "1px solid rgba(0,0,0,0.12)",
                    }}
                  />
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
      <Space align="center" style={{ marginTop: 8 }}>
        <ColorPicker
          value={value}
          onChangeComplete={(c) => onChange?.(c.toHexString())}
          presets={[{ label: "常用", colors: PRESET_COLORS }]}
          showText={() => <span>自定义颜色…</span>}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {value ?? "未选择"}
        </Typography.Text>
      </Space>
    </div>
  );
}
