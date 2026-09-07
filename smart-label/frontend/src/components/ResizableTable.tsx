import { useCallback, useMemo, useState } from "react";
import { Table } from "antd";
import type { TableProps } from "antd";
import type { ColumnsType, ColumnType } from "antd/es/table";

/**
 * 表头可以左右拖动调整列宽、宽度记在 localStorage 里的 Table。
 * 用法跟 antd Table 一样，多传一个 storageKey（同一个 key 共用一套宽度，比如
 * 每个项目展开出来的任务表都传 "tasks"）。拖动手柄在每列表头右缘。
 */

const PREFIX = "colw:";
const MIN_WIDTH = 40;

function load(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function save(key: string, widths: Record<string, number>) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(widths));
  } catch {
    /* 隐私模式等情况下存不了就算了 */
  }
}

function keyOf<T>(col: ColumnType<T>, index: number): string {
  if (col.key != null) return String(col.key);
  if (col.dataIndex != null) return Array.isArray(col.dataIndex) ? col.dataIndex.join(".") : String(col.dataIndex);
  if (typeof col.title === "string") return col.title;
  return `#${index}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ResizableTitle(props: any) {
  const { onResize, width, children, style, ...rest } = props;
  const onMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => onResize?.(Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX)));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    <th {...rest} style={{ ...style, position: "relative", ...(width ? { width } : {}) }}>
      {children}
      {onResize && (
        <span
          onMouseDown={onMouseDown}
          onClick={(e) => e.stopPropagation()}
          title="拖动调整列宽"
          style={{
            position: "absolute", top: 0, right: -4, width: 9, height: "100%", cursor: "col-resize", zIndex: 1,
          }}
        />
      )}
    </th>
  );
}

export default function ResizableTable<T extends object>({ storageKey, columns, components, ...rest }: TableProps<T> & { storageKey: string }) {
  const [widths, setWidths] = useState<Record<string, number>>(() => load(storageKey));
  const setWidth = useCallback(
    (k: string, w: number) =>
      setWidths((prev) => {
        const next = { ...prev, [k]: w };
        save(storageKey, next);
        return next;
      }),
    [storageKey]
  );
  const cols = useMemo<ColumnsType<T>>(
    () =>
      (columns ?? []).map((c, i) => {
        const col = c as ColumnType<T>;
        const k = keyOf(col, i);
        const w = widths[k] ?? col.width;
        return {
          ...col,
          width: w,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onHeaderCell: (data: any) => ({
            ...((col.onHeaderCell as ((d: any) => object) | undefined)?.(data) ?? {}),
            width: w,
            onResize: (nw: number) => setWidth(k, nw),
          }),
        } as ColumnType<T>;
      }),
    [columns, widths, setWidth]
  );
  return (
    <Table<T>
      {...rest}
      columns={cols}
      components={{ ...components, header: { ...components?.header, cell: ResizableTitle } }}
    />
  );
}
