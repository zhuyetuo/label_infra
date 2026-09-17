/**
 * 新建项目弹窗里「标签模板」的默认值。
 *
 * saved 是上次建项目时选的（localStorage 里的字符串）：
 *   "none"   上次是特意清掉不套的 → 这次也不套
 *   "12"     上次选了 id=12 → 还在列表里就用它；模板被删了就退回第一个
 *   ""       没记过 → 列表第一个
 */
export function defaultTemplateId(saved: string, ids: number[]): number | undefined {
  if (saved === "none") return undefined;
  const n = Number(saved);
  if (saved !== "" && Number.isFinite(n) && ids.includes(n)) return n;
  return ids[0];
}
