import { useMemo, useState } from "react";
import { Typography } from "antd";

const { Text } = Typography;

/**
 * 犬齿列示意图（恒牙 42 颗）：上颌每侧 门齿 3 · 犬齿 1 · 前臼齿 4 · 臼齿 2 = 10，
 * 下颌每侧 3 · 1 · 4 · 3 = 11。牙位按 modified Triadan：象限 1 右上、2 左上、3 左下、4 右下
 * （以狗自己的左右为准），牙号 01~03 门齿、04 犬齿、05~08 前臼齿、09 起臼齿。
 * 颜色跟标注类别一致，悬停一颗牙 / 一条牙龈就说明它是什么。
 */

type ToothType = "incisor" | "canine" | "premolar" | "molar";

const TYPES: { code: ToothType | "gingiva"; name: string; color: string; hotkey: string; desc: string }[] = [
  { code: "incisor", name: "门齿", color: "#3b82f6", hotkey: "1", desc: "最前面一排小牙，上下各 6 颗（每侧 3 颗，牙号 01~03）。切咬、啃骨头上的肉用。" },
  { code: "canine", name: "犬齿", color: "#f59e0b", hotkey: "2", desc: "门齿两侧最长最尖的那颗，上下各 2 颗（每侧 1 颗，牙号恒为 04）。推牙位时它是锚点。" },
  { code: "premolar", name: "前臼齿", color: "#10b981", hotkey: "3", desc: "犬齿后面尖尖的几颗，上下各 8 颗（每侧 4 颗，牙号 05~08）。上颌第 4 前臼齿（108/208）最大，是裂齿。" },
  { code: "molar", name: "臼齿", color: "#a855f7", hotkey: "4", desc: "最里面宽平的牙。上颌每侧 2 颗（09、10），下颌每侧 3 颗（09~11），下颌第 1 臼齿（309/409）是裂齿。" },
  { code: "gingiva", name: "牙龈", color: "#e11d48", hotkey: "5", desc: "包着牙根、贴着牙冠根部的那条粉红软组织。标注时框**龈缘那条带**（牙冠根部往上一条），上颌一整片、下颌一整片，不要把牙圈进去。GI / 颜色 / 肿胀 / 出血都填在牙龈框上。" },
];
const COLOR: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.code, t.color]));

/** 一个象限从中线往后：门齿 3、犬齿 1、前臼齿 4、臼齿 2（上）/ 3（下） */
function quadrant(upper: boolean): { type: ToothType; no: number }[] {
  const out: { type: ToothType; no: number }[] = [];
  for (let i = 1; i <= 3; i++) out.push({ type: "incisor", no: i });
  out.push({ type: "canine", no: 4 });
  for (let i = 5; i <= 8; i++) out.push({ type: "premolar", no: i });
  for (let i = 9; i <= (upper ? 10 : 11); i++) out.push({ type: "molar", no: i });
  return out;
}

/** 每颗牙在弓上的宽度（相对） */
const WIDTH: Record<ToothType, number> = { incisor: 0.55, canine: 0.9, premolar: 1.0, molar: 1.5 };
/** 每颗牙的高度（像素） */
const HEIGHT: Record<ToothType, number> = { incisor: 22, canine: 48, premolar: 28, molar: 22 };

interface Tooth {
  code: string;           // 三位牙位，如 104
  type: ToothType;
  upper: boolean;
  path: string;           // 牙冠轮廓
  cx: number;
  cy: number;
}

/** 牙弓的弧度：mid = 0 中线，1 最里面；返回往牙龈方向缩进多少像素 */
const sagAt = (mid: number) => Math.pow(Math.abs(mid), 1.6) * 40;

/** 牙龈那一片：外沿一条平缓的弧，内沿（龈缘）跟牙弓同一条弧，牙根就埋在里面 */
function gumPath(W: number, y: number, dir: 1 | -1): string {
  const half = W * 0.44;
  const pts: string[] = [];
  for (let i = -20; i <= 20; i++) {
    const mid = i / 20;
    pts.push(`${W / 2 + mid * half} ${y + dir * (sagAt(mid) + 4)}`);
  }
  const outer = `M ${W / 2 - half - 12} ${y - dir * 30} Q ${W / 2} ${y - dir * 44} ${W / 2 + half + 12} ${y - dir * 30}`;
  return `${outer} L ${W / 2 + half + 12} ${y + dir * 48} L ${pts.reverse().join(" L ")} L ${W / 2 - half - 12} ${y + dir * 48} Z`;
}

/** 把一排牙沿一条弧摆开：中线在 x=W/2，往两边越来越靠后、越来越往下（上颌）/ 往上（下颌） */
function layout(W: number, upper: boolean, gumY: number): Tooth[] {
  const q = quadrant(upper);
  const total = q.reduce((a, t) => a + WIDTH[t.type], 0);
  const half = W * 0.44;
  const dir = upper ? 1 : -1;
  const teeth: Tooth[] = [];
  for (const side of [1, -1] as const) {
    // 象限号：狗自己的右 = 画面左（面对狗看）。上右 1、上左 2、下左 3、下右 4
    const quad = upper ? (side === -1 ? 1 : 2) : side === -1 ? 4 : 3;
    let acc = 0;
    for (const t of q) {
      const w = WIDTH[t.type];
      const mid = (acc + w / 2) / total;      // 0 = 中线, 1 = 最里面
      acc += w;
      const x = W / 2 + side * mid * half;
      // 弓形：越往后越往牙龈的方向缩一点（透视感），门齿最靠外
      const sag = sagAt(mid);
      // 牙根埋进牙龈 6 像素，别悬空
      const y0 = gumY + dir * (sag - 6);
      const h = HEIGHT[t.type] * (1 - mid * 0.25);
      const bw = (w / total) * half * 0.86;
      const tip = y0 + dir * h;
      let path: string;
      if (t.type === "canine") {
        path = `M ${x - bw / 2} ${y0} Q ${x - bw * 0.2} ${y0 + dir * h * 0.5} ${x + side * bw * 0.1} ${tip} Q ${x + bw * 0.35} ${y0 + dir * h * 0.5} ${x + bw / 2} ${y0} Z`;
      } else if (t.type === "premolar") {
        path = `M ${x - bw / 2} ${y0} L ${x - bw * 0.15} ${tip} L ${x + bw * 0.15} ${tip} L ${x + bw / 2} ${y0} Z`;
      } else if (t.type === "molar") {
        path = `M ${x - bw / 2} ${y0} L ${x - bw * 0.45} ${tip} L ${x - bw * 0.15} ${tip - dir * 5} L ${x} ${tip} L ${x + bw * 0.15} ${tip - dir * 5} L ${x + bw * 0.45} ${tip} L ${x + bw / 2} ${y0} Z`;
      } else {
        path = `M ${x - bw / 2} ${y0} L ${x - bw * 0.4} ${tip} Q ${x} ${tip + dir * 4} ${x + bw * 0.4} ${tip} L ${x + bw / 2} ${y0} Z`;
      }
      teeth.push({ code: `${quad}${String(t.no).padStart(2, "0")}`, type: t.type, upper, path, cx: x, cy: y0 + dir * h * 0.5 });
    }
  }
  return teeth;
}

export default function DentitionDiagram() {
  const W = 680;
  const upperGum = 120;
  const lowerGum = 300;
  const upper = useMemo(() => layout(W, true, upperGum), []);
  const lower = useMemo(() => layout(W, false, lowerGum), []);
  const [hover, setHover] = useState<{ kind: "type"; code: string } | { kind: "tooth"; tooth: Tooth } | null>(null);
  const activeType = hover?.kind === "type" ? hover.code : hover?.kind === "tooth" ? hover.tooth.type : null;
  const dim = (code: string) => (activeType && activeType !== code ? 0.25 : 1);

  const info = TYPES.find((t) => t.code === activeType);

  return (
    <div>
      <svg viewBox={`0 0 ${W} 420`} style={{ width: "100%", display: "block", userSelect: "none" }} onMouseLeave={() => setHover(null)}>
        {/* 上下颌的牙龈：一整片。悬停说明什么是牙龈 */}
        {[
          { y: upperGum, dir: 1 as const },
          { y: lowerGum, dir: -1 as const },
        ].map((g) => (
          <path
            key={g.y}
            d={gumPath(W, g.y, g.dir)}
            fill="#f9a8b8"
            stroke={activeType === "gingiva" ? COLOR.gingiva : "#e58a9c"}
            strokeWidth={activeType === "gingiva" ? 3 : 1.5}
            opacity={dim("gingiva")}
            onMouseEnter={() => setHover({ kind: "type", code: "gingiva" })}
            style={{ cursor: "help" }}
          />
        ))}
        {/* 龈缘那条带：标注时要框的就是这一条 */}
        {([[upperGum, 1], [lowerGum, -1]] as const).map(([y, dir]) => (
          <path
            key={`edge${y}`}
            d={"M " + Array.from({ length: 41 }, (_, i) => { const mid = (i - 20) / 20; return `${W / 2 + mid * W * 0.44} ${y + dir * (sagAt(mid) - 2)}`; }).join(" L ")}
            fill="none" stroke={COLOR.gingiva} strokeWidth={activeType === "gingiva" ? 4 : 0} strokeDasharray="6 4" opacity={0.9}
          />
        ))}
        {[...upper, ...lower].map((t) => {
          const on = hover?.kind === "tooth" && hover.tooth.code === t.code;
          return (
            <g key={t.code} onMouseEnter={() => setHover({ kind: "tooth", tooth: t })} style={{ cursor: "help" }} opacity={dim(t.type)}>
              <path d={t.path} fill="#fffdf5" stroke={COLOR[t.type]} strokeWidth={on ? 3 : 1.8} />
              <text x={t.cx} y={t.cy + 3} fontSize={8} textAnchor="middle" fill="#666" pointerEvents="none">{t.code}</text>
            </g>
          );
        })}
        {/* 中线 + 象限标注 */}
        <line x1={W / 2} y1={40} x2={W / 2} y2={380} stroke="#bbb" strokeDasharray="3 3" />
        <text x={W * 0.03} y={20} fontSize={12} fill="#888">狗的右侧（画面左）</text>
        <text x={W * 0.97} y={20} fontSize={12} fill="#888" textAnchor="end">狗的左侧（画面右）</text>
        <text x={W * 0.03} y={upperGum - 34} fontSize={12} fill="#c2415a">上颌 · 象限 1</text>
        <text x={W * 0.97} y={upperGum - 34} fontSize={12} fill="#c2415a" textAnchor="end">上颌 · 象限 2</text>
        <text x={W * 0.03} y={lowerGum + 44} fontSize={12} fill="#c2415a">下颌 · 象限 4</text>
        <text x={W * 0.97} y={lowerGum + 44} fontSize={12} fill="#c2415a" textAnchor="end">下颌 · 象限 3</text>
        <text x={W / 2} y={210} fontSize={12} fill="#888" textAnchor="middle">上 20 颗 + 下 22 颗 = 恒牙 42 颗</text>
      </svg>

      {/* 图例：悬停高亮同类 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}>
        {TYPES.map((t) => (
          <span
            key={t.code}
            onMouseEnter={() => setHover({ kind: "type", code: t.code })}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px", borderRadius: 14, border: `1.5px solid ${t.color}`, background: activeType === t.code ? t.color : "transparent", color: activeType === t.code ? "#fff" : undefined, cursor: "help", fontSize: 13 }}
          >
            <b>{t.hotkey}</b> {t.name}
          </span>
        ))}
      </div>
      <div style={{ minHeight: 44, fontSize: 13 }}>
        {hover?.kind === "tooth" ? (
          <span>
            <b style={{ color: COLOR[hover.tooth.type] }}>{hover.tooth.code} · {TYPES.find((t) => t.code === hover.tooth.type)!.name}</b>
            <Text type="secondary">
              {" "}{hover.tooth.upper ? "上颌" : "下颌"}{hover.tooth.code[0] === "1" || hover.tooth.code[0] === "4" ? "右侧" : "左侧"}第 {Number(hover.tooth.code.slice(1))} 号。
              {TYPES.find((t) => t.code === hover.tooth.type)!.desc}
            </Text>
          </span>
        ) : info ? (
          <span>
            <b style={{ color: info.color }}>{info.name}</b> <Text type="secondary">{info.desc}</Text>
          </span>
        ) : (
          <Text type="secondary">鼠标放到一颗牙、一片牙龈或图例上，看它是什么、牙号怎么编。</Text>
        )}
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        牙号 = 象限 + 序号：象限按狗自己的左右，右上 1、左上 2、左下 3、右下 4；序号从中线往后数，犬齿恒为 04、第一臼齿恒为 09。
        乳牙约 20 天开始长、6 周长齐（28 颗）；4~6 个月换恒牙，8 个月前后全部换完。
      </Text>
    </div>
  );
}
