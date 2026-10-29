import { Tag, Tooltip } from "antd";
import type { BoundaryEdit } from "@/types";

/** 00:56:24.724 */
const fmt = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))}.${p(t % 1000, 3)}`;
};

/** 「起止调过 N 次」：鼠标停上去看每一次从哪改到哪、谁改的（已标注片段、疑似片段共用） */
export default function BoundaryEditsTag({ edits }: { edits?: BoundaryEdit[] | null }) {
  if (!edits?.length) return null;
  return (
    <Tooltip
      title={
        <div style={{ fontSize: 12 }}>
          <div>起止调过 {edits.length} 次（最早的在上）：</div>
          {edits.map((e, k) => (
            <div key={k}>
              {k + 1}. {fmt(e.from[0])}~{fmt(e.from[1])} → {fmt(e.to[0])}~{fmt(e.to[1])}
              <span style={{ opacity: 0.7 }}>　{e.by_name ?? ""} {e.at?.replace("T", " ").slice(5, 16)}</span>
            </div>
          ))}
        </div>
      }
    >
      <Tag color="geekblue" style={{ marginLeft: 4 }}>起止调过 {edits.length} 次</Tag>
    </Tooltip>
  );
}
