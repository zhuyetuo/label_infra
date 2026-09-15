/** AI 预标注版本选项：稳定版（滞回+合并）/ 稳定版 v2（Viterbi 解码）/ 调试版（逐窗口原始输出） */
export type AlgoMode = "stable" | "viterbi" | "raw";

/** 版本可以是 algo_service 的 mode，也可以是端侧模型（edge:<标签>）。
 *
 * 端侧那几个是运行时才知道的（问服务），所以类型上只能是 string——
 * 写成联合类型的话每加一个端侧模型都要改前端代码，而那正是
 * "问服务不写死"要避免的事。 */
export type InferMode = AlgoMode | string;

/** 端侧模型的版本前缀，跟后端 edge_client.EDGE_PREFIX 是同一个约定 */
export const EDGE_PREFIX = "edge:";
export const isEdgeMode = (m: string) => m.startsWith(EDGE_PREFIX);
export const edgeTagOf = (m: string) => m.slice(EDGE_PREFIX.length);
export const INFER_MODE_OPTIONS: { label: string; value: AlgoMode }[] = [
  { label: "稳定版", value: "stable" },
  { label: "稳定版 v2", value: "viterbi" },
  { label: "调试版", value: "raw" },
];
/** 历史记录里回显用：后端存的是 stable/viterbi/raw */
export const INFER_MODE_LABEL: Record<string, string> = Object.fromEntries(
  INFER_MODE_OPTIONS.map((o) => [o.value, o.label])
);

/** 历史记录/回显用的显示名。端侧的标签是运行时才知道的，
 *  所以不在 INFER_MODE_LABEL 那张表里，单独拼。 */
export const modeLabelOf = (m: string) =>
  isEdgeMode(m) ? `端侧 · ${edgeTagOf(m)}` : (INFER_MODE_LABEL[m] ?? m);

/** 端侧那条**只有 raw**——板子上没有 stable/viterbi 那套后处理。
 *  所以铺出来的草稿会比稳定版碎，标注员要多合并几下。这不是 bug，
 *  是设备真实会报的东西；要看"平滑之后"就用线上那几个版本。 */
/** 某个版本的说明文案。端侧的不在 INFER_MODE_HINT 那张表里（它是运行时才知道的），
 *  直接用 INFER_MODE_HINT[m] 会在端侧那几个上拿到 undefined。 */
export const hintOf = (m: string) =>
  isEdgeMode(m) ? EDGE_MODE_HINT : (INFER_MODE_HINT[m as AlgoMode] ?? "");

export const EDGE_MODE_HINT =
  "跑的是烧进项圈的那份 C（逐位一致）。端上没有稳定版那套平滑/合并，"
  + "所以片段会更碎——这就是设备实际会报的东西。";
export const INFER_MODE_HINT: Record<AlgoMode, string> = {
  stable: "活动/睡觉平滑、碎片并入邻段；抓挠用双阈值滞回不被切碎，间隔 4s 内合并，前后的甩身体并入；单窗口噪声丢掉",
  viterbi: "动态规划解码整条时间轴，切换类别要付代价，所有类别统一生效；抓挠同样合并/过滤。跟稳定版对比看哪个更接近人工",
  raw: "模型逐窗口原始输出，活动/睡觉会来回闪，抓挠有很多单窗口噪声。用来看模型到底说了什么",
};
