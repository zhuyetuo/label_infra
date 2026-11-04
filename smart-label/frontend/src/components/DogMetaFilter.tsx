import { Select } from "antd";

/** 皮肤跟踪表 / 项目联动每行带的「场地 · 房间 · 品种」（后端按狗档案 + 采集布局补的） */
export interface DogMetaRow {
  dog_name?: string | null;
  site_name?: string | null;
  room?: string | null;
  breed?: string | null;
}

export interface DogMetaValue {
  sites?: string[];
  rooms?: string[];
  breeds?: string[];
}

/** 房间要带上场地才唯一（两个狗场都有「1号单间」） */
const roomKey = (r: DogMetaRow) => (r.room ? `${r.site_name ?? "?"} ${r.room}` : null);

export function matchDogMeta(r: DogMetaRow, v: DogMetaValue): boolean {
  if (v.sites?.length && !v.sites.includes(r.site_name ?? "未知场地")) return false;
  if (v.rooms?.length && !v.rooms.includes(roomKey(r) ?? "")) return false;
  if (v.breeds?.length && !v.breeds.includes(r.breed ?? "未登记品种")) return false;
  return true;
}

const uniq = (xs: (string | null | undefined)[]) =>
  [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, "zh"));

/** 狗名下拉的选项：名字后面带上品种和房间，光一个名字分不清 */
export function dogOptions(rows: DogMetaRow[]) {
  const by = new Map<string, DogMetaRow>();
  for (const r of rows) if (r.dog_name && !by.has(r.dog_name)) by.set(r.dog_name, r);
  return [...by.keys()].sort((a, b) => a.localeCompare(b, "zh")).map((name) => {
    const r = by.get(name)!;
    const extra = [r.breed, r.site_name && r.room ? `${r.site_name.replace(/狗场$/, "")}${r.room}` : r.site_name].filter(Boolean).join(" · ");
    return { value: name, label: extra ? `${name}（${extra}）` : name };
  });
}

/** 一行小字：品种 · 场地 房间 */
export function dogMetaText(r: DogMetaRow): string {
  return [r.breed, [r.site_name?.replace(/狗场$/, ""), r.room].filter(Boolean).join("")].filter(Boolean).join(" · ");
}

/** 场地 / 房间 / 品种三个筛选。选了场地，房间只列那几个场地的 */
export default function DogMetaFilter({ rows, value, onChange }: {
  rows: DogMetaRow[];
  value: DogMetaValue;
  onChange: (patch: DogMetaValue) => void;
}) {
  const sites = uniq(rows.map((r) => r.site_name ?? "未知场地"));
  const roomRows = value.sites?.length ? rows.filter((r) => value.sites!.includes(r.site_name ?? "未知场地")) : rows;
  const rooms = uniq(roomRows.map(roomKey));
  const breeds = uniq(rows.map((r) => r.breed ?? "未登记品种"));
  const common = { mode: "multiple" as const, allowClear: true, showSearch: true, maxTagCount: "responsive" as const };
  return (
    <>
      <Select {...common} placeholder="全部场地" style={{ minWidth: 140 }} value={value.sites ?? []}
        onChange={(v) => onChange({ sites: v })} options={sites.map((s) => ({ value: s, label: s }))} />
      {rooms.length > 0 && (
        <Select {...common} placeholder="全部房间" style={{ minWidth: 140 }} value={value.rooms ?? []}
          onChange={(v) => onChange({ rooms: v })} options={rooms.map((s) => ({ value: s, label: s }))} />
      )}
      <Select {...common} placeholder="全部品种" style={{ minWidth: 140 }} value={value.breeds ?? []}
        onChange={(v) => onChange({ breeds: v })} options={breeds.map((s) => ({ value: s, label: s }))} />
    </>
  );
}
