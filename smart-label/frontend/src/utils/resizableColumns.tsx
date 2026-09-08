import { useCallback, useRef, useState } from "react";
import type { ColumnsType } from "antd/es/table";
import { sortKeyOf } from "@/utils/persistedSort";

/**
 * 可拖动调宽的表头 + 记住每个人调成什么样。
 *
 * 为什么需要：列宽是我们拍脑袋写死的，实际内容宽窄差很多——「人工复看」那种
 * 挂三四个标签的列常年挤成两行，「状态」那种只放一个小标签的列却空着半格。
 * 而且同一张表不同的人关心的列不一样，没有一套宽度能同时合适。与其继续猜，
 * 不如让人自己拖，拖完记住。
 *
 * 没有引入 react-resizable：就一个拖把手，自己写十几行比多一个依赖划算，
 * 也省得跟 antd 的表头结构打架。
 */

const MIN_WIDTH = 60;
const MAX_WIDTH = 900;

function load(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

type CellProps = React.ThHTMLAttributes<HTMLTableCellElement> & {
  width?: number;
  onResize?: (width: number) => void;
};

/** 表头单元格：右边缘一条看不见的把手，按住左右拖 */
function ResizableTitle({ width, onResize, children, style, ...rest }: CellProps) {
  const startX = useRef(0);
  const startW = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);

  if (!width || !onResize) return <th {...rest} style={style}>{children}</th>;

  const onMouseDown = (e: React.MouseEvent) => {
    // 别让这一下被当成"点表头排序"
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startW.current = width;
    setDragging(true);
    const move = (ev: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + ev.clientX - startX.current));
      onResize(next);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <th {...rest} style={{ ...style, position: "relative" }}>
      {children}
      <span
        onMouseDown={onMouseDown}
        onClick={(e) => e.stopPropagation()}
        // 鼠标扫过时把把手显出来：不给点反馈的话，没人知道这里能拖
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "absolute",
          top: 0,
          right: -4,
          width: 8,
          height: "100%",
          cursor: "col-resize",
          // 拖的时候给一条可见的线，不然完全没有反馈
          background: dragging ? "rgba(128,128,128,.55)" : hover ? "rgba(128,128,128,.28)" : "transparent",
          zIndex: 1,
          userSelect: "none",
        }}
      />
    </th>
  );
}

export function useResizableColumns(storageKey: string) {
  const [widths, setWidths] = useState<Record<string, number>>(() => load(storageKey));

  const save = useCallback(
    (key: string, w: number) => {
      setWidths((prev) => {
        const next = { ...prev, [key]: w };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // 存不了就算了，这一次拖的还是生效的
        }
        return next;
      });
    },
    [storageKey]
  );

  const reset = useCallback(() => {
    setWidths({});
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // 同上
    }
  }, [storageKey]);

  /** 挂到 Table 的 components 上 */
  const components = { header: { cell: ResizableTitle } };

  /**
   * 必须跟 components 一起挂到 Table 上，否则拖了看不出变化。
   *
   * rc-table 默认只有「固定表头 / 有省略号列 / 有固定列」时才用 table-layout: fixed，
   * 别的情况是 auto——auto 布局下列宽只是建议值，内容撑得开就撑，拖窄了没反应。
   */
  const tableLayout = "fixed" as const;

  /**
   * 给每列接上拖动。没写 width 的列跳过——它本来就是"剩下的宽度都给我"，
   * 给它一个固定值反而会把布局锁死。
   */
  const applyResize = <T,>(columns: ColumnsType<T>): ColumnsType<T> => {
    const sized = columns.map((c, i) => {
      // 很多列既没有 key 也没有 dataIndex（内容是 render 拼出来的，比如「人工复看」
      // 「疑似抓挠」）——恰恰是这些列最需要调宽。退回用列的位置当 key：
      // 这几张表的列是写死的，顺序不会变
      const key = sortKeyOf(c as never) ?? `#${i}`;
      const base = (c as { width?: number }).width;
      if (typeof base !== "number") return c;
      const width = widths[key] ?? base;
      return {
        ...c,
        width,
        onHeaderCell: () => ({ width, onResize: (w: number) => save(key, w) }) as never,
      };
    });
    // 末尾补一列没有宽度的空列专门吃剩余空间。
    // 不补的话：表格最小宽度是容器的 100%，而每列都写死了宽度，多出来的空间会
    // 按比例摊回到所有列上——于是把某一列拖窄，省下来的宽度立刻又被均摊回去，
    // 看起来就是"拖不动"。有这么一列兜着，缩窄才真的缩得下去。
    return [...sized, { key: "__slack__", title: "", render: () => null }] as ColumnsType<T>;
  };

  return { components, tableLayout, applyResize, reset, hasCustom: Object.keys(widths).length > 0 };
}
