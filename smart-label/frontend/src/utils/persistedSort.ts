import { useState } from "react";
import type { ColumnsType } from "antd/es/table";
import type { SorterResult } from "antd/es/table/interface";

/**
 * 记住表格排序，下次进这张表还按上次排的来。
 *
 * 为什么值得做：这些表都是"带着一个问题来找数据"的——今天抓挠最多的是哪天、
 * 哪一段还有最多候选没确认。排一次序才看得出来，而换个页面回来就重置成默认，
 * 等于每次都要重排一遍。排序是用户的看法，不是页面的初始状态。
 *
 * 只记 (列, 升降)：多列排序这些表都没用上，存了也没处使。
 */

export interface SortState {
  key: string;
  order: "ascend" | "descend";
}

/** 列的身份：优先 key，其次 dataIndex。两个都没有的列本来也排不了序 */
type ColumnLike = { key?: React.Key; dataIndex?: React.Key | readonly React.Key[]; sorter?: unknown };

export function sortKeyOf(c: ColumnLike): string | null {
  if (c.key != null) return String(c.key);
  if (c.dataIndex != null) return String(c.dataIndex);
  return null;
}

function load(storageKey: string): SortState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.key === "string" && (v.order === "ascend" || v.order === "descend") ? v : null;
  } catch {
    return null;
  }
}

export function usePersistedSort(storageKey: string) {
  const [sort, setSort] = useState<SortState | null>(() => load(storageKey));

  const save = (next: SortState | null) => {
    setSort(next);
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch {
      // 存不了就算了，这一次还是能正常排
    }
  };

  /** 直接挂到 Table 的 onChange 上 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onTableChange = (_p: any, _f: any, s: SorterResult<any> | SorterResult<any>[]) => {
    const one = Array.isArray(s) ? s[0] : s;
    const key = one?.columnKey != null ? String(one.columnKey) : one?.field != null ? String(one.field) : null;
    // 点第三下是"取消排序"（order 为 undefined），那就把记忆也清掉
    save(key && (one.order === "ascend" || one.order === "descend") ? { key, order: one.order } : null);
  };

  /**
   * 把记住的排序回填到列上。没有 sorter 的列不动；
   * 显式给 key，不然 antd 回调里的 columnKey 会是 undefined，存不下来。
   */
  // 泛型写在行类型上（applySort<Row>([...])）：这样内联的列数组还能拿到上下文
  // 类型，render/sorter 的参数不会退化成 any
  const applySort = <T,>(columns: ColumnsType<T>): ColumnsType<T> => {
    // 没记住过就原样返回：一旦给了 sortOrder（哪怕是 null），列上写的
    // defaultSortOrder 就失效了——首次进来的默认排序不能被这个功能弄丢
    if (!sort) return columns;
    return columns.map((c) => {
      const col = c as ColumnLike;
      if (!col.sorter) return c;
      const k = sortKeyOf(col);
      if (!k) return c;
      return { ...c, key: k, sortOrder: sort.key === k ? sort.order : null };
    });
  };

  return { sort, onTableChange, applySort };
}
