/** AI 预标注版本选项：稳定版（滞回+合并）/ 稳定版 v2（Viterbi 解码）/ 调试版（逐窗口原始输出） */
export type InferMode = "stable" | "viterbi" | "raw";
export const INFER_MODE_OPTIONS: { label: string; value: InferMode }[] = [
  { label: "稳定版", value: "stable" },
  { label: "稳定版 v2", value: "viterbi" },
  { label: "调试版", value: "raw" },
];
/** 历史记录里回显用：后端存的是 stable/viterbi/raw */
export const INFER_MODE_LABEL: Record<string, string> = Object.fromEntries(
  INFER_MODE_OPTIONS.map((o) => [o.value, o.label])
);
export const INFER_MODE_HINT: Record<InferMode, string> = {
  stable: "活动/睡觉平滑、碎片并入邻段；抓挠用双阈值滞回不被切碎，间隔 4s 内合并，前后的甩身体并入；单窗口噪声丢掉",
  viterbi: "动态规划解码整条时间轴，切换类别要付代价，所有类别统一生效；抓挠同样合并/过滤。跟稳定版对比看哪个更接近人工",
  raw: "模型逐窗口原始输出，活动/睡觉会来回闪，抓挠有很多单窗口噪声。用来看模型到底说了什么",
};
