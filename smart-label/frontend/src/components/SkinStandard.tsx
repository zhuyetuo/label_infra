import { Button, Drawer, Image, Table, Tooltip, theme } from "antd";
import { create } from "zustand";
import { QuestionCircleOutlined } from "@ant-design/icons";

/**
 * 皮肤照片评级标准（兽医给的培训 PPT《犬只皮肤状态评估·标注员培训》Version 2026.11 整理）。
 * 点问号在右边打开：口诀 → 原则 → 四步 → 三档对照（带真实图例）→ 每项看什么 → 别犯的错。
 * 图片在 public/skin-standard/，从 PPT 里取的、压到 480px。
 */

const IMG = (n: string) => `/skin-standard/${n}.jpg`;

// 三档：颜色、一句话结论、关键信号（短词）、处理方式、真实图例
const LEVELS = [
  {
    grade: "S0", name: "正常", hex: "#52c41a", action: "常规护理",
    rule: "皮肤完整、粉红肉色，没有秃毛",
    keys: ["粉红 / 肉色", "毛发光亮", "允许一点点泛红、少量干皮屑"],
    pics: [["s0_pink", "正常粉红肉色"]],
  },
  {
    grade: "S1", name: "轻度 · 居家护理", hex: "#faad14", action: "居家护理，观察变化",
    rule: "皮肤没破，有中等信号，没有红旗",
    keys: ["成块皮屑", "可擦掉的黑油脂", "1–2 处小秃毛（≤2cm）", "毛发油腻打结", "小范围断毛"],
    pics: [["s1_scale", "干燥皮屑"], ["s1_a", "散在小红点"], ["s1_c", "局部轻度泛红"],
      ["s1_d", "成块皮屑"], ["s1_e", "趾间轻微泛红"], ["s1_b", "局部毛稀"]],
  },
  {
    grade: "S2", name: "严重 · 需就医", hex: "#ff4d4f", action: "就高不就低，尽快就医",
    rule: "任一红旗就是 S2",
    keys: ["皮肤鲜红", "糜烂 / 渗液", "结痂 / 脓疱 / 丘疹 / 裂隙", "成片秃毛或 >3cm", "毛发大片干枯断裂"],
    pics: [["s2_red", "大面积鲜红"], ["s2_erosion", "糜烂渗液"], ["s2_a", "耳廓红肿结痂"], ["s2_b", "成片秃毛"],
      ["s2_c", "爪部糜烂结痂"], ["s2_d", "秃毛 + 鲜红"], ["s2_e", "全身毛稀"], ["s2_f", "大片秃毛发黑"]],
  },
] as const;

// 各项信号对应哪一档（PPT 第 7–9 页，括号里是评分表分值）
const SIGNALS: { item: string; s0: string; s1: string; s2: string }[] = [
  { item: "皮肤颜色", s0: "粉红、轻微泛红", s1: "色素沉着、可擦黑油脂", s2: "鲜红（哪怕没破）" },
  { item: "皮损", s0: "完整、少量干皮屑", s1: "斑块、成块皮屑", s2: "糜烂 渗液 结痂 脓疱 丘疹 裂隙" },
  { item: "秃毛", s0: "没有", s1: "1–3 处小块，直径 ≤3cm", s2: "连续成片 / 整体稀疏 / >3cm" },
  { item: "毛发", s0: "光亮顺滑", s1: "油腻打结、小范围断", s2: "大部分干枯断裂" },
];

const STEPS: [string, string][] = [
  ["查质量", "模糊、遮挡、太暗 → 选「看不清」"],
  ["看信号", "皮肤颜色、皮损、秃毛、毛发"],
  ["找红旗", "有没有鲜红、破损、成片秃毛"],
  ["定等级", "有红旗 S2 · 有中等信号 S1 · 正常 S0"],
];

const H = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 15, fontWeight: 700, margin: "22px 0 10px" }}>{children}</div>
);

function Pic({ name, caption, color }: { name: string; caption: string; color: string }) {
  return (
    <div style={{ width: 120 }}>
      <Image src={IMG(name)} width={120} height={90} style={{ objectFit: "cover", borderRadius: 6 }} />
      <div style={{ fontSize: 12, marginTop: 3, borderLeft: `3px solid ${color}`, paddingLeft: 5, lineHeight: 1.4 }}>{caption}</div>
    </div>
  );
}

export function SkinStandardContent() {
  const { token } = theme.useToken();
  const card = { border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, background: token.colorFillQuaternary };
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      {/* 一句话口诀：先看这一行 */}
      <div style={{ ...card, padding: "12px 14px", display: "flex", flexWrap: "wrap", gap: "8px 18px", alignItems: "center", fontSize: 14 }}>
        <b>口诀</b>
        {LEVELS.slice().reverse().map((l) => (
          <span key={l.grade}>
            <span style={{ background: l.hex, color: l.grade === "S1" ? "#000" : "#fff", borderRadius: 4, padding: "1px 8px", fontWeight: 700, marginRight: 6 }}>{l.grade}</span>
            {l.rule}
          </span>
        ))}
        <span><span style={{ border: `1px solid ${token.colorBorder}`, borderRadius: 4, padding: "0 8px", fontWeight: 700, marginRight: 6 }}>看不清</span>不猜</span>
      </div>

      {/* 三条原则：一行三个短句 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {["只分级，不诊断", "拿不准就判重的", "看不清就选「看不清」"].map((t) => (
          <span key={t} style={{ ...card, padding: "4px 12px", fontWeight: 600 }}>✓ {t}</span>
        ))}
      </div>

      <H>四步走</H>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        {STEPS.map(([t, d], i) => (
          <div key={t} style={{ ...card, padding: "10px 12px", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ flex: "0 0 auto", width: 28, height: 28, borderRadius: 14, background: token.colorPrimary, color: "#fff",
              fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{t}</div>
              <div style={{ color: token.colorTextSecondary, fontSize: 12 }}>{d}</div>
            </div>
          </div>
        ))}
      </div>

      <H>三档对照（看这只狗这次全部照片，按最重的部位定）</H>
      {LEVELS.map((l) => (
        <div key={l.grade} style={{ border: `1px solid ${l.hex}`, borderRadius: 8, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ background: l.hex, color: l.grade === "S1" ? "#000" : "#fff", padding: "6px 12px", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{l.grade}</span>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{l.name}</span>
            <span style={{ fontSize: 12, opacity: 0.85 }}>→ {l.action}</span>
          </div>
          <div style={{ padding: "10px 12px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {l.keys.map((k) => (
                <span key={k} style={{ border: `1px solid ${l.hex}`, color: token.colorText, borderRadius: 12, padding: "1px 10px", fontSize: 12 }}>{k}</span>
              ))}
            </div>
            <Image.PreviewGroup>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {l.pics.map(([n, c]) => <Pic key={n} name={n} caption={c} color={l.hex} />)}
              </div>
            </Image.PreviewGroup>
          </div>
        </div>
      ))}

      <H>每一项看什么</H>
      <Table size="small" pagination={false} rowKey="item" dataSource={SIGNALS} bordered tableLayout="fixed"
        columns={[
          { title: "", dataIndex: "item", width: 84, render: (v: string) => <b>{v}</b> },
          { title: <b style={{ color: "#52c41a" }}>S0</b>, dataIndex: "s0" },
          { title: <b style={{ color: "#faad14" }}>S1</b>, dataIndex: "s1" },
          { title: <b style={{ color: "#ff4d4f" }}>S2 红旗</b>, dataIndex: "s2", render: (v: string) => <span style={{ color: "#ff4d4f", fontWeight: 600 }}>{v}</span> },
        ]} />

      <H>别犯这些错</H>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6 }}>
        {["凭照片猜气味、猜病名", "看到鲜红 / 破损还判 S1", "照片模糊还硬判", "一点点红、一点皮屑就判 S1"].map((t) => (
          <div key={t}><span style={{ color: "#ff4d4f", fontWeight: 800, marginRight: 6 }}>✕</span>{t}</div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: token.colorTextTertiary, marginTop: 16 }}>来源：兽医《犬只皮肤状态评估 · 标注员培训》2026.11。拿不准在两档之间的选重的，备注写一句哪里拿不准。</div>
    </div>
  );
}

/** 标准面板：开没开、多宽（拖左边那条边改宽窄，记在这台电脑上）。全局一份 */
const W_KEY = "smart-label:skin-standard-w";
const W_MIN = 360;
const loadW = () => {
  try {
    const v = Number(localStorage.getItem(W_KEY));
    if (v >= W_MIN) return v;
  } catch { /* 用默认 */ }
  return Math.min(Math.round(window.innerWidth * 0.42), 860);
};
export const useSkinStandard = create<{ open: boolean; width: number; setOpen: (v: boolean) => void; setWidth: (w: number) => void }>((set) => ({
  open: false,
  width: loadW(),
  setOpen: (open) => set({ open }),
  setWidth: (w) => {
    const width = Math.round(Math.max(W_MIN, Math.min(w, window.innerWidth - 480)));
    try { localStorage.setItem(W_KEY, String(width)); } catch { /* 存不了就算了 */ }
    set({ width });
  },
}));

/** 标准开着时要让出的右边宽度（px）：页面内容、照片弹窗都按它往左让 */
export function useStandardInset(): number {
  const { open, width } = useSkinStandard();
  return open ? width : 0;
}

/** 问号：点一下右边打开标准（再点收起）；不挡左边，照片照样能点、能评级 */
export function SkinStandardHelp({ text }: { text?: string }) {
  const { open, setOpen } = useSkinStandard();
  return (
    <Tooltip title={open ? "收起评级标准" : "评级标准（兽医版）：在右边打开，一边看一边评"}>
      <span onClick={(e) => { e.stopPropagation(); setOpen(!open); }} style={{ cursor: "pointer", color: open ? "#1677ff" : "#888" }}>
        <QuestionCircleOutlined />{text && <span style={{ marginLeft: 4, fontSize: 12 }}>{text}</span>}
      </span>
    </Tooltip>
  );
}

/** 右边的标准面板：不加遮罩、压在弹窗上面，放在 AppLayout 里全站一份。
 *  左边那条竖边可以拖宽拖窄；右上角「窄 / 中 / 宽」一键切 */
export function SkinStandardDrawer() {
  const { open, setOpen, width, setWidth } = useSkinStandard();
  const { token } = theme.useToken();
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setWidth(window.innerWidth - ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const presets: [string, number][] = [["窄", 400], ["中", Math.round(window.innerWidth * 0.36)], ["宽", Math.round(window.innerWidth * 0.5)]];
  return (
    <>
    {open && (
      <>
        {/* 拖这条边改宽窄（双击回到中等宽度） */}
        <Tooltip title="拖动改宽窄，双击恢复" placement="left">
          <div onMouseDown={startDrag} onDoubleClick={() => setWidth(presets[1][1])}
            style={{ position: "fixed", top: 0, bottom: 0, right: width - 3, width: 6, cursor: "col-resize", zIndex: 1200,
                background: `linear-gradient(to right, transparent 2px, ${token.colorBorder} 2px, ${token.colorBorder} 4px, transparent 4px)` }} />
        </Tooltip>
      </>
    )}
    <Drawer open={open} onClose={() => setOpen(false)} mask={false} placement="right" width={width} zIndex={1100}
      title="评级标准 S0 / S1 / S2"
      extra={
        <span style={{ display: "inline-flex", gap: 4 }}>
          {presets.map(([t, w]) => (
            <Button key={t} size="small" type={Math.abs(width - w) < 30 ? "primary" : "default"} onClick={() => setWidth(w)}>{t}</Button>
          ))}
        </span>
      }
      styles={{ body: { overflowX: "hidden", padding: "12px 16px", position: "relative" } }}>
      <SkinStandardContent />
    </Drawer>
    </>
  );
}
