import { Col, Drawer, Image, Row, Steps, Table, Tag, Tooltip, Typography } from "antd";
import { create } from "zustand";
import { QuestionCircleOutlined } from "@ant-design/icons";

/**
 * 皮肤照片评级标准（兽医给的培训 PPT《犬只皮肤状态评估·标注员培训》Version 2026.11 整理）。
 * 点问号弹出：原则 → 四步流程 → 三档对照（带真实图例）→ 各信号分值 → 高频误区。
 * 图片在 public/skin-standard/，从 PPT 里取的、压到 480px。
 */

const IMG = (n: string) => `/skin-standard/${n}.jpg`;

const LEVELS = [
  {
    grade: "S0", name: "无明显问题", color: "green", action: "常规护理，不用特殊处理",
    signals: ["皮肤完整，颜色粉红 / 肉色", "没有秃毛，毛发光亮顺滑", "允许单项 ≤5 分的轻微表现（轻微泛红、少量干皮屑）"],
    pics: [["s0_pink", "正常粉红肉色"]],
  },
  {
    grade: "S1", name: "轻度 · 居家护理", color: "gold", action: "居家护理，持续观察变化",
    signals: ["皮肤屏障完整，没有破损", "10–15 分信号：成块皮屑、可擦掉的黑油脂、1–2 处小秃毛（直径 ≤2cm）、毛发油腻打结、小范围断毛",
      "没有任何 20 分红旗"],
    pics: [["s1_scale", "干燥、少量皮屑"], ["s1_a", "散在小红点，皮肤完整"], ["s1_c", "局部轻度泛红"],
      ["s1_d", "黑毛里成块皮屑"], ["s1_e", "趾间轻微泛红"], ["s1_b", "局部毛发稀疏"]],
  },
  {
    grade: "S2", name: "严重 · 需就医", color: "red", action: "就高不就低，尽快就医",
    signals: ["任一 20 分红旗，或皮肤鲜红", "糜烂 / 渗液 / 结痂 / 脓疱 / 丘疹 / 裂隙", "成片秃毛，或秃毛直径 >3cm",
      "毛发大部分干枯断裂"],
    pics: [["s2_red", "皮肤大面积鲜红"], ["s2_erosion", "糜烂、渗液"], ["s2_a", "耳廓红肿、结痂"], ["s2_b", "成片秃毛"],
      ["s2_c", "爪部糜烂结痂"], ["s2_d", "秃毛 + 皮肤鲜红"], ["s2_e", "全身毛发稀疏"], ["s2_f", "大片秃毛、发黑增厚"]],
  },
] as const;

// 各信号的分值 → 档位提示（PPT 第 7–9 页）。0/5 分偏 S0，10–15 分 S1，20 分（或鲜红）直接 S2
const SIGNALS: { item: string; s0: string; s1: string; s2: string }[] = [
  { item: "皮肤颜色", s0: "粉红 / 肉粉色（0）；轻微泛红（5）", s1: "黑 / 褐色素沉着（5）；分泌可擦掉的黑油脂（10）", s2: "鲜红，哪怕没破（15，红旗）" },
  { item: "皮损", s0: "完整（0）；单纯干燥、少量皮屑（5）", s1: "出现斑块、成块皮屑脱落（15）", s2: "糜烂 / 渗液 / 结痂 / 脓疱 / 丘疹 / 裂隙（20）" },
  { item: "秃毛部位", s0: "没有秃毛（0）", s1: "1–2 个小区域：爪、耳缘、局部腹部（10）；≥3 处明显秃斑（15）", s2: "连续成片 / 整体稀疏（20）" },
  { item: "秃毛面积（最大直径）", s0: "—", s1: "1–2cm（10）；2–3cm（15）", s2: ">3cm（20）" },
  { item: "毛发状态", s0: "光亮顺滑", s1: "油腻打结、小范围断裂", s2: "大部分干枯断裂" },
];

function Pic({ name, caption, color }: { name: string; caption: string; color: string }) {
  return (
    <div style={{ width: 132 }}>
      <Image src={IMG(name)} width={132} height={100} style={{ objectFit: "cover", borderRadius: 4 }} />
      <div style={{ fontSize: 12, marginTop: 2, borderLeft: `3px solid ${color}`, paddingLeft: 4 }}>{caption}</div>
    </div>
  );
}

export function SkinStandardContent() {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
      {/* 三条原则：PPT 里「必须遵守」 */}
      <Row gutter={12} style={{ marginBottom: 4, marginLeft: 0, marginRight: 0 }}>
        {[
          ["只分级，不诊断", "只判断皮肤状态到哪一档，不猜是什么病"],
          ["就高不就低", "拿不准、疑似红旗，按更严重的那档；宁可多送审，不能漏判"],
          ["看不清就选「看不清」", "模糊、遮挡、光线差、没拍到关键部位，不猜"],
        ].map(([t, d]) => (
          <Col xs={24} xl={8} key={t} style={{ marginBottom: 8 }}>
            <div style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 6, padding: "8px 10px", height: "100%" }}>
              <b>{t}</b>
              <div style={{ opacity: 0.75, fontSize: 12 }}>{d}</div>
            </div>
          </Col>
        ))}
      </Row>

      <Typography.Title level={5} style={{ marginTop: 4 }}>拿到一只狗的照片，按这四步走</Typography.Title>
      <Steps size="small" direction="vertical" style={{ marginBottom: 8 }} items={[
        { title: "查质量", description: "清晰、光线足、没遮挡；不行就选「看不清」" },
        { title: "看信号", description: "逐项看皮肤颜色、皮损、秃毛、毛发（照片闻不到味道，体味不管）" },
        { title: "找红旗", description: "有没有 20 分信号，或者皮肤鲜红" },
        { title: "定等级", description: "有红旗 → S2；有 10–15 分 → S1；基本正常 → S0" },
      ]} />

      <Typography.Title level={5}>三档怎么判（看这只狗这一次的全部照片，按最严重的部位定）</Typography.Title>
      {LEVELS.map((l) => (
        <div key={l.grade} style={{ border: "1px solid rgba(128,128,128,0.3)", borderLeft: `4px solid ${l.color === "gold" ? "#faad14" : l.color === "green" ? "#52c41a" : "#ff4d4f"}`,
          borderRadius: 6, padding: "8px 12px", marginBottom: 10 }}>
          <div style={{ marginBottom: 4 }}>
            <Tag color={l.color} style={{ fontSize: 13 }}>{l.grade}</Tag><b>{l.name}</b>
            <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>处理：{l.action}</Typography.Text>
          </div>
          <ul style={{ margin: "0 0 6px 18px", padding: 0 }}>
            {l.signals.map((s) => <li key={s}>{s}</li>)}
          </ul>
          <Image.PreviewGroup>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {l.pics.map(([n, c]) => <Pic key={n} name={n} caption={c} color={l.color === "gold" ? "#faad14" : l.color === "green" ? "#52c41a" : "#ff4d4f"} />)}
            </div>
          </Image.PreviewGroup>
        </div>
      ))}

      <Typography.Title level={5} style={{ marginTop: 12 }}>各项信号对应哪一档（括号里是评分表分值）</Typography.Title>
      <Table size="small" pagination={false} rowKey="item" dataSource={SIGNALS} bordered tableLayout="fixed"
        columns={[
          { title: "看什么", dataIndex: "item", width: 130, render: (v: string) => <b>{v}</b> },
          { title: <Tag color="green">S0</Tag>, dataIndex: "s0" },
          { title: <Tag color="gold">S1</Tag>, dataIndex: "s1" },
          { title: <Tag color="red">S2 红旗</Tag>, dataIndex: "s2", render: (v: string) => <span style={{ color: "#ff4d4f" }}>{v}</span> },
        ]} />
      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>任一项达到 20 分（或皮肤鲜红）就判 S2，其他项再轻也不往下拉。</div>

      <Typography.Title level={5} style={{ marginTop: 12 }}>这些错误不能犯</Typography.Title>
      <Row gutter={[12, 4]} style={{ marginLeft: 0, marginRight: 0 }}>
        {["凭照片猜气味、猜病名", "看到鲜红 / 破损还往低判成 S1", "照片模糊、遮挡还硬判", "把 ≤5 分的轻微表现（一点点红、一点干皮屑）判成 S1"].map((t) => (
          <Col xs={24} xl={12} key={t}><span style={{ color: "#ff4d4f", fontWeight: 600 }}>✕</span> {t}</Col>
        ))}
      </Row>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12 }}>来源：兽医《犬只皮肤状态评估 · 标注员培训》Version 2026.11。拿不准在两档之间的选重的那档，备注写一句哪里拿不准。</div>
    </div>
  );
}

/** 标准面板开没开：全局一份。开着时照片弹窗让到左边，一边看标准一边评 */
export const useSkinStandard = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** 标准开着时，照片弹窗 / 页面要让出的右边宽度 */
export const STANDARD_W = "min(46vw, 900px)";

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

/** 右边的标准面板：不加遮罩、压在弹窗上面，放在 AppLayout 里全站一份 */
export function SkinStandardDrawer() {
  const { open, setOpen } = useSkinStandard();
  return (
    <Drawer open={open} onClose={() => setOpen(false)} mask={false} placement="right" width={STANDARD_W} zIndex={1100}
      title="皮肤照片评级标准（S0 / S1 / S2）" styles={{ body: { overflowX: "hidden", padding: "12px 16px" } }}>
      <SkinStandardContent />
    </Drawer>
  );
}
