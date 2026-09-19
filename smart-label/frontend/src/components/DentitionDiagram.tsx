import { useState } from "react";
import { Segmented, Typography } from "antd";

const { Text } = Typography;

/**
 * 犬齿列示意图：按拍照的三个视角画——左颊、正面、右颊——跟标注时「视角」那一项一一对应。
 *
 * 掀唇拍左颊看到的是狗的左侧：上颌象限 2、下颌象限 3；右颊是 1 / 4；正面同时看到两侧的
 * 前牙。每颗牙按真实形状画（门齿小凿形、犬齿长弯尖、前臼齿双尖、上 4 前臼齿 / 下 1 臼齿
 * 是最大的裂齿、臼齿宽平），牙龈一整片粉红包着牙根，龈缘那条带就是标注时要框的。
 * 颜色跟标注类别一致，悬停一颗牙 / 一片牙龈 / 图例就说明它是什么。
 */

type ToothType = "incisor" | "canine" | "premolar" | "molar";

const TYPES: { code: ToothType | "gingiva"; name: string; color: string; hotkey: string; desc: string }[] = [
  { code: "incisor", name: "门齿", color: "#3b82f6", hotkey: "1", desc: "最前面一排小凿形的牙，上下各 6 颗（每侧 3 颗，牙号 01~03）。掀唇拍侧面时只露出靠近犬齿的一两颗。" },
  { code: "canine", name: "犬齿", color: "#f59e0b", hotkey: "2", desc: "门齿两侧最长最尖的那颗，上下各 2 颗（每侧 1 颗，牙号恒为 04）。下犬齿咬合时落在上门齿和上犬齿之间。推牙位的锚点。" },
  { code: "premolar", name: "前臼齿", color: "#10b981", hotkey: "3", desc: "犬齿后面尖尖的几颗，每侧 4 颗（牙号 05~08），从前往后一颗比一颗大。上颌第 4 前臼齿（108 / 208）最大，是裂齿，侧面照里最显眼的那颗。" },
  { code: "molar", name: "臼齿", color: "#a855f7", hotkey: "4", desc: "最里面宽平的牙。上颌每侧 2 颗（09、10），下颌每侧 3 颗（09~11）。下颌第 1 臼齿（309 / 409）是裂齿、最大；最后一颗很小，常被嘴角挡住。" },
  { code: "gingiva", name: "牙龈", color: "#e11d48", hotkey: "5", desc: "包着牙根的那片粉红软组织。标注时框**龈缘那条带**：贴着牙冠根部的那一条，上颌一整片、下颌一整片，别把牙圈进去。GI / 颜色 / 肿胀 / 出血都填在牙龈框上。" },
];
const COLOR: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.code, t.color]));
const NAME: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.code, t.name]));

type View = "left" | "front" | "right";
type Shape = "incisor" | "canine" | "premolar" | "carnassial" | "molar";

interface ToothSpec {
  no: number;         // 01~11
  type: ToothType;
  shape: Shape;
  x: number;          // 牙冠左边（视图坐标）
  w: number;
  h: number;
}

const W = 720;
const H = 320;
const UPPER_ROOT = 118;     // 上颌龈缘所在的 y
const LOWER_ROOT = 214;     // 下颌龈缘所在的 y

/** 侧面视角（鼻子在左）：一侧上颌 10 颗、下颌 11 颗。x 是从鼻子往后排 */
const SIDE_UPPER: ToothSpec[] = [
  { no: 1, type: "incisor", shape: "incisor", x: 34, w: 12, h: 15 },
  { no: 2, type: "incisor", shape: "incisor", x: 48, w: 13, h: 17 },
  { no: 3, type: "incisor", shape: "incisor", x: 63, w: 15, h: 20 },
  { no: 4, type: "canine", shape: "canine", x: 88, w: 30, h: 66 },
  { no: 5, type: "premolar", shape: "premolar", x: 134, w: 20, h: 20 },
  { no: 6, type: "premolar", shape: "premolar", x: 166, w: 30, h: 28 },
  { no: 7, type: "premolar", shape: "premolar", x: 208, w: 38, h: 34 },
  { no: 8, type: "premolar", shape: "carnassial", x: 260, w: 66, h: 46 },
  { no: 9, type: "molar", shape: "molar", x: 334, w: 44, h: 28 },
  { no: 10, type: "molar", shape: "molar", x: 384, w: 28, h: 20 },
];
const SIDE_LOWER: ToothSpec[] = [
  { no: 1, type: "incisor", shape: "incisor", x: 40, w: 11, h: 13 },
  { no: 2, type: "incisor", shape: "incisor", x: 53, w: 12, h: 15 },
  { no: 3, type: "incisor", shape: "incisor", x: 67, w: 13, h: 17 },
  { no: 4, type: "canine", shape: "canine", x: 76, w: 26, h: 56 },
  { no: 5, type: "premolar", shape: "premolar", x: 120, w: 16, h: 16 },
  { no: 6, type: "premolar", shape: "premolar", x: 148, w: 26, h: 24 },
  { no: 7, type: "premolar", shape: "premolar", x: 186, w: 32, h: 30 },
  { no: 8, type: "premolar", shape: "premolar", x: 228, w: 38, h: 34 },
  { no: 9, type: "molar", shape: "carnassial", x: 276, w: 62, h: 42 },
  { no: 10, type: "molar", shape: "molar", x: 344, w: 34, h: 24 },
  { no: 11, type: "molar", shape: "molar", x: 384, w: 20, h: 16 },
];

/** 一颗牙冠的轮廓。y 是龈缘，dir=1 往下长（上颌），-1 往上长（下颌） */
function crown(shape: Shape, x: number, y: number, w: number, h: number, dir: 1 | -1, lean = 0): string {
  const Y = (k: number) => y + dir * h * k;
  const X = (k: number) => x + w * k;
  switch (shape) {
    case "incisor":
      return `M ${X(0)} ${y} L ${X(1)} ${y} C ${X(1.02)} ${Y(0.6)} ${X(0.8)} ${Y(1)} ${X(0.5)} ${Y(1)} C ${X(0.2)} ${Y(1)} ${X(-0.02)} ${Y(0.6)} ${X(0)} ${y} Z`;
    case "canine":
      // 长弯尖：尖端往后（lean）弯一点
      return `M ${X(0)} ${y} L ${X(1)} ${y} C ${X(1)} ${Y(0.45)} ${X(0.85 + lean)} ${Y(0.8)} ${X(0.6 + lean)} ${Y(1)} C ${X(0.4 + lean)} ${Y(0.75)} ${X(0.05)} ${Y(0.4)} ${X(0)} ${y} Z`;
    case "premolar":
      // 主尖在中间，两边各一个小肩
      return `M ${X(0)} ${y} L ${X(1)} ${y} C ${X(1)} ${Y(0.35)} ${X(0.9)} ${Y(0.55)} ${X(0.8)} ${Y(0.55)} C ${X(0.7)} ${Y(0.75)} ${X(0.6)} ${Y(1)} ${X(0.5)} ${Y(1)} C ${X(0.4)} ${Y(1)} ${X(0.3)} ${Y(0.75)} ${X(0.2)} ${Y(0.55)} C ${X(0.1)} ${Y(0.55)} ${X(0)} ${Y(0.35)} ${X(0)} ${y} Z`;
    case "carnassial":
      // 裂齿：三个尖，中间最高，像一把刀
      return `M ${X(0)} ${y} L ${X(1)} ${y} C ${X(1)} ${Y(0.4)} ${X(0.95)} ${Y(0.7)} ${X(0.85)} ${Y(0.7)} C ${X(0.8)} ${Y(0.55)} ${X(0.75)} ${Y(0.5)} ${X(0.7)} ${Y(0.5)} C ${X(0.62)} ${Y(0.8)} ${X(0.55)} ${Y(1)} ${X(0.45)} ${Y(1)} C ${X(0.35)} ${Y(0.85)} ${X(0.3)} ${Y(0.6)} ${X(0.25)} ${Y(0.6)} C ${X(0.18)} ${Y(0.75)} ${X(0.1)} ${Y(0.8)} ${X(0.05)} ${Y(0.7)} C ${X(0)} ${Y(0.5)} ${X(0)} ${Y(0.3)} ${X(0)} ${y} Z`;
    case "molar":
    default:
      // 宽平，咬合面两个圆钝的小丘
      return `M ${X(0)} ${y} L ${X(1)} ${y} C ${X(1.02)} ${Y(0.7)} ${X(0.9)} ${Y(1)} ${X(0.75)} ${Y(1)} C ${X(0.62)} ${Y(1)} ${X(0.55)} ${Y(0.85)} ${X(0.5)} ${Y(0.85)} C ${X(0.45)} ${Y(0.85)} ${X(0.38)} ${Y(1)} ${X(0.25)} ${Y(1)} C ${X(0.1)} ${Y(1)} ${X(-0.02)} ${Y(0.7)} ${X(0)} ${y} Z`;
  }
}

interface Drawn {
  code: string;
  type: ToothType;
  path: string;
  cx: number;
  labelY: number;
  quadrant: number;
  no: number;
}

/** 侧面视角：mirror=true 是右颊（鼻子在右）。象限：左颊 2/3，右颊 1/4 */
// 侧面视角把一侧 21 颗牙铺满整个画面：坐标表按 1.6 倍放大，上下颌的龈缘也拉开一点
const SIDE_SCALE = 1.6;
const SIDE_UPPER_ROOT = 96;
const SIDE_LOWER_ROOT = 236;

function sideTeeth(mirror: boolean): Drawn[] {
  const S = SIDE_SCALE;
  const mx = (x: number, w: number) => (mirror ? W - x - w : x);
  const out: Drawn[] = [];
  const lean = mirror ? -0.15 : 0.15;
  for (const t of SIDE_UPPER) {
    const w = t.w * S;
    const x = mx(t.x * S + 8, w);
    out.push({
      code: `${mirror ? 1 : 2}${String(t.no).padStart(2, "0")}`, type: t.type, quadrant: mirror ? 1 : 2, no: t.no,
      path: crown(t.shape, x, SIDE_UPPER_ROOT, w, t.h * S, 1, t.shape === "canine" ? lean : 0), cx: x + w / 2, labelY: SIDE_UPPER_ROOT - 8,
    });
  }
  for (const t of SIDE_LOWER) {
    const w = t.w * S;
    const x = mx(t.x * S + 8, w);
    out.push({
      code: `${mirror ? 4 : 3}${String(t.no).padStart(2, "0")}`, type: t.type, quadrant: mirror ? 4 : 3, no: t.no,
      path: crown(t.shape, x, SIDE_LOWER_ROOT, w, t.h * S, -1, t.shape === "canine" ? lean : 0), cx: x + w / 2, labelY: SIDE_LOWER_ROOT + 16,
    });
  }
  return out;
}

/** 正面：左右两侧的门齿、犬齿都看得到，再往后只露一点前臼齿。画面左 = 狗的右（象限 1 / 4） */
function frontTeeth(): Drawn[] {
  const out: Drawn[] = [];
  const cx0 = W / 2;
  // 上门齿 6 颗，从中线往两边；越靠外越大一点
  const upperInc = [
    { no: 1, w: 20, h: 22 }, { no: 2, w: 22, h: 24 }, { no: 3, w: 24, h: 27 },
  ];
  const lowerInc = [
    { no: 1, w: 16, h: 16 }, { no: 2, w: 18, h: 18 }, { no: 3, w: 20, h: 21 },
  ];
  for (const side of [-1, 1] as const) {
    const qU = side === -1 ? 1 : 2;
    const qL = side === -1 ? 4 : 3;
    let off = 3;
    for (const t of upperInc) {
      const x = side === -1 ? cx0 - off - t.w : cx0 + off;
      out.push({ code: `${qU}0${t.no}`, type: "incisor", quadrant: qU, no: t.no, path: crown("incisor", x, UPPER_ROOT, t.w, t.h, 1), cx: x + t.w / 2, labelY: UPPER_ROOT - 8 });
      off += t.w + 3;
    }
    // 上犬齿：门齿再往外一点，长而弯
    const cw = 34, ch = 78;
    // 上犬齿要落在下犬齿的外侧（咬合时下犬齿在上门齿和上犬齿之间），所以往外挪得多一点
    const cxx = side === -1 ? cx0 - off - 24 - cw : cx0 + off + 24;
    out.push({ code: `${qU}04`, type: "canine", quadrant: qU, no: 4, path: crown("canine", cxx, UPPER_ROOT, cw, ch, 1, side === -1 ? -0.08 : 0.08), cx: cxx + cw / 2, labelY: UPPER_ROOT - 8 });
    // 再往外只露前臼齿的一角
    const pw = 26, ph = 22;
    const px = side === -1 ? cxx - 10 - pw : cxx + cw + 10;
    out.push({ code: `${qU}05`, type: "premolar", quadrant: qU, no: 5, path: crown("premolar", px, UPPER_ROOT + 6, pw, ph, 1), cx: px + pw / 2, labelY: UPPER_ROOT - 2 });
    const pw2 = 30, ph2 = 26;
    const px2 = side === -1 ? px - 8 - pw2 : px + pw + 8;
    out.push({ code: `${qU}06`, type: "premolar", quadrant: qU, no: 6, path: crown("premolar", px2, UPPER_ROOT + 12, pw2, ph2, 1), cx: px2 + pw2 / 2, labelY: UPPER_ROOT + 4 });

    let off2 = 3;
    for (const t of lowerInc) {
      const x = side === -1 ? cx0 - off2 - t.w : cx0 + off2;
      out.push({ code: `${qL}0${t.no}`, type: "incisor", quadrant: qL, no: t.no, path: crown("incisor", x, LOWER_ROOT, t.w, t.h, -1), cx: x + t.w / 2, labelY: LOWER_ROOT + 16 });
      off2 += t.w + 3;
    }
    // 下犬齿：咬合时落在上门齿和上犬齿之间，所以比上犬齿更靠中线
    const lw = 28, lh = 62;
    const lx = side === -1 ? cx0 - off2 - 10 - lw : cx0 + off2 + 10;
    out.push({ code: `${qL}04`, type: "canine", quadrant: qL, no: 4, path: crown("canine", lx, LOWER_ROOT, lw, lh, -1, side === -1 ? -0.08 : 0.08), cx: lx + lw / 2, labelY: LOWER_ROOT + 16 });
    const lpw = 22, lph = 18;
    const lpx = side === -1 ? lx - 22 - lpw : lx + lw + 22;
    out.push({ code: `${qL}05`, type: "premolar", quadrant: qL, no: 5, path: crown("premolar", lpx, LOWER_ROOT - 6, lpw, lph, -1), cx: lpx + lpw / 2, labelY: LOWER_ROOT + 10 });
  }
  return out;
}

const VIEW_META: Record<View, { label: string; sub: string; quadrants: string; note: string }> = {
  left: { label: "左颊", sub: "掀开左边嘴唇拍，鼻子在画面左", quadrants: "上颌象限 2 · 下颌象限 3", note: "推牙位就是按这个方向数的：犬齿 04 在前，往后 05~08 前臼齿、09 起臼齿。最显眼的大牙是上 4 前臼齿 208 和下 1 臼齿 309。" },
  front: { label: "正面", sub: "从正前方拍，画面左是狗的右侧", quadrants: "同时看到 1 / 2（上）和 4 / 3（下）", note: "正面照看得到 12 颗门齿和 4 颗犬齿，再往后就被嘴唇挡住。一张图跨两个象限，所以正面不推牙位，视角选「正面」。" },
  right: { label: "右颊", sub: "掀开右边嘴唇拍，鼻子在画面右", quadrants: "上颌象限 1 · 下颌象限 4", note: "跟左颊镜像。最显眼的大牙是上 4 前臼齿 108 和下 1 臼齿 409。分不清左右就把视角选「看不出」，别猜。" },
};

export default function DentitionDiagram() {
  const [view, setView] = useState<View>("left");
  const [hover, setHover] = useState<{ kind: "type"; code: string } | { kind: "tooth"; tooth: Drawn } | null>(null);
  const activeType = hover?.kind === "type" ? hover.code : hover?.kind === "tooth" ? hover.tooth.type : null;
  const dim = (code: string) => (activeType && activeType !== code ? 0.3 : 1);
  const teeth = view === "front" ? frontTeeth() : sideTeeth(view === "right");
  const info = TYPES.find((t) => t.code === activeType);
  const meta = VIEW_META[view];
  const gumOn = activeType === "gingiva";
  const UR = view === "front" ? UPPER_ROOT : SIDE_UPPER_ROOT;
  const LR = view === "front" ? LOWER_ROOT : SIDE_LOWER_ROOT;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <Segmented value={view} onChange={(v) => setView(v as View)} options={(["left", "front", "right"] as View[]).map((v) => ({ value: v, label: VIEW_META[v].label }))} />
        <Text type="secondary" style={{ fontSize: 12 }}>{meta.sub} · {meta.quadrants}</Text>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", userSelect: "none", borderRadius: 8 }} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="dd-tooth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fffdf6" />
            <stop offset="1" stopColor="#ece4cc" />
          </linearGradient>
          <linearGradient id="dd-tooth-lo" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#fffdf6" />
            <stop offset="1" stopColor="#ece4cc" />
          </linearGradient>
          <linearGradient id="dd-gum-up" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4a3b1" />
            <stop offset="1" stopColor="#e27a90" />
          </linearGradient>
          <linearGradient id="dd-gum-lo" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#f4a3b1" />
            <stop offset="1" stopColor="#e27a90" />
          </linearGradient>
          <linearGradient id="dd-lip" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a2b31" />
            <stop offset="1" stopColor="#2b171b" />
          </linearGradient>
          <filter id="dd-shadow" x="-10%" y="-10%" width="120%" height="130%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.2" floodColor="#000" floodOpacity="0.25" />
          </filter>
        </defs>
        {/* 口腔背景：深色的口腔 + 上下两片嘴唇被掀开 */}
        <rect x="0" y="0" width={W} height={H} rx="8" fill="#3a2226" />
        <path d={`M 0 0 H ${W} V 44 Q ${W / 2} 62 0 44 Z`} fill="url(#dd-lip)" />
        <path d={`M 0 ${H} H ${W} V ${H - 40} Q ${W / 2} ${H - 58} 0 ${H - 40} Z`} fill="url(#dd-lip)" />
        {/* 牙龈：上颌一片、下颌一片。龈缘沿着牙根走 */}
        <path
          d={`M 0 40 Q ${W / 2} 56 ${W} 40 L ${W} ${UR + 10} Q ${W / 2} ${UR + 4} 0 ${UR + 10} Z`}
          fill="url(#dd-gum-up)" opacity={dim("gingiva")}
          onMouseEnter={() => setHover({ kind: "type", code: "gingiva" })} style={{ cursor: "help" }}
        />
        <path
          d={`M 0 ${H - 36} Q ${W / 2} ${H - 52} ${W} ${H - 36} L ${W} ${LR - 10} Q ${W / 2} ${LR - 4} 0 ${LR - 10} Z`}
          fill="url(#dd-gum-lo)" opacity={dim("gingiva")}
          onMouseEnter={() => setHover({ kind: "type", code: "gingiva" })} style={{ cursor: "help" }}
        />
        {/* 龈缘那条带：悬停牙龈时亮出来，标注时框的就是它 */}
        <path d={`M 0 ${UR + 10} Q ${W / 2} ${UR + 4} ${W} ${UR + 10}`} fill="none" stroke={COLOR.gingiva} strokeWidth={gumOn ? 5 : 0} strokeDasharray="8 5" opacity={0.95} />
        <path d={`M 0 ${LR - 10} Q ${W / 2} ${LR - 4} ${W} ${LR - 10}`} fill="none" stroke={COLOR.gingiva} strokeWidth={gumOn ? 5 : 0} strokeDasharray="8 5" opacity={0.95} />
        {gumOn && (
          <>
            <rect x={W / 2 - 150} y={(UR + LR) / 2 - 9} width={300} height={18} rx={9} fill={COLOR.gingiva} opacity={0.9} />
            <text x={W / 2} y={(UR + LR) / 2 + 4} fontSize={12} fill="#fff" textAnchor="middle">标牙龈就框这条龈缘带：上颌一整片、下颌一整片</text>
          </>
        )}
        {/* 牙：先画下颌再画上颌（上犬齿压在下犬齿前面） */}
        {[...teeth.filter((t) => t.quadrant >= 3), ...teeth.filter((t) => t.quadrant <= 2)].map((t) => {
          const on = hover?.kind === "tooth" && hover.tooth.code === t.code;
          const upper = t.quadrant <= 2;
          return (
            <g key={t.code} onMouseEnter={() => setHover({ kind: "tooth", tooth: t })} style={{ cursor: "help" }} opacity={dim(t.type)}>
              <path d={t.path} fill={on ? COLOR[t.type] : upper ? "url(#dd-tooth)" : "url(#dd-tooth-lo)"} fillOpacity={on ? 0.35 : 1} stroke={COLOR[t.type]} strokeWidth={on ? 3 : 1.6} strokeLinejoin="round" filter="url(#dd-shadow)" />
              <path d={t.path} fill={on ? COLOR[t.type] : "none"} fillOpacity={on ? 0.35 : 0} stroke="none" />
              <text x={t.cx} y={t.labelY} fontSize={10} textAnchor="middle" fill={on ? "#fff" : "#7a1f33"} fontWeight={on ? 700 : 500} pointerEvents="none">{t.code}</text>
            </g>
          );
        })}
        {/* 方向提示 */}
        <text x={12} y={H / 2 + 4} fontSize={12} fill="#f3d3da" opacity={0.85}>{view === "left" ? "← 鼻子" : view === "right" ? "← 嘴角" : "← 狗的右侧"}</text>
        <text x={W - 12} y={H / 2 + 4} fontSize={12} fill="#f3d3da" opacity={0.85} textAnchor="end">{view === "left" ? "嘴角 →" : view === "right" ? "鼻子 →" : "狗的左侧 →"}</text>
      </svg>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0 6px" }}>
        {TYPES.map((t) => (
          <span
            key={t.code}
            onMouseEnter={() => setHover({ kind: "type", code: t.code })}
            onMouseLeave={() => setHover(null)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px", borderRadius: 14, border: `1.5px solid ${t.color}`, background: activeType === t.code ? t.color : "transparent", color: activeType === t.code ? "#fff" : undefined, cursor: "help", fontSize: 13 }}
          >
            <b>{t.hotkey}</b> {t.name}
          </span>
        ))}
      </div>
      <div style={{ minHeight: 48, fontSize: 13, lineHeight: 1.6 }}>
        {hover?.kind === "tooth" ? (
          <span>
            <b style={{ color: COLOR[hover.tooth.type] }}>{hover.tooth.code} · {NAME[hover.tooth.type]}</b>
            <Text type="secondary">
              {" "}{hover.tooth.quadrant <= 2 ? "上颌" : "下颌"}{hover.tooth.quadrant === 1 || hover.tooth.quadrant === 4 ? "右侧" : "左侧"}第 {hover.tooth.no} 号（象限 {hover.tooth.quadrant}）。
              {TYPES.find((t) => t.code === hover.tooth.type)!.desc}
            </Text>
          </span>
        ) : info ? (
          <span>
            <b style={{ color: info.color }}>{info.name}</b> <Text type="secondary">{info.desc}</Text>
          </span>
        ) : (
          <Text type="secondary">{meta.note}</Text>
        )}
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        牙号 = 象限 + 序号。象限按狗自己的左右：右上 1、左上 2、左下 3、右下 4；序号从中线往后数，门齿 01~03、犬齿 04、前臼齿 05~08、臼齿 09 起。
        恒牙 42 颗：上颌每侧 3-1-4-2，下颌每侧 3-1-4-3。乳牙约 3 周开始长、6 周长齐 28 颗；4~6 个月换恒牙，8 个月前后换完。
      </Text>
    </div>
  );
}
