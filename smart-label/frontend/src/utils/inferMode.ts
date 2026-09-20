/** AI 预标注版本选项：稳定版（滞回+合并）/ 稳定版 v2（Viterbi 解码）/ 调试版（逐窗口原始输出） */
export type AlgoMode = "stable" | "viterbi" | "raw" | "viterbi_noshake";

/** 版本可以是算法服务（imu_train 的 label_service）的后处理 mode，
 *  也可以是它上面挂的另一个模型（srv:<标签>）或端侧模型（edge:<标签>）。
 *
 * 端侧那几个是运行时才知道的（问服务），所以类型上只能是 string——
 * 写成联合类型的话每加一个端侧模型都要改前端代码，而那正是
 * "问服务不写死"要避免的事。 */
export type InferMode = AlgoMode | string;

/** 服务端**另一个模型**的版本前缀，跟后端 algo_client.SRV_PREFIX 同一个约定。
 *  跟 edge: 的区别：这边跑的是服务器上的 sklearn，那边跑的是烧进项圈的 C。 */
export const SRV_PREFIX = "srv:";
export const isSrvMode = (m: string) => m.startsWith(SRV_PREFIX);
/** srv:acc3@raw → acc3 */
export const srvTagOf = (m: string) => m.slice(SRV_PREFIX.length).split("@")[0];
/** 不带后缀 = viterbi，跟后端 SRV_DEFAULT_POST 一致 */
export const srvPostOf = (m: string): string =>
  m.slice(SRV_PREFIX.length).split("@")[1] || "viterbi";

/** 端侧模型的版本前缀，跟后端 edge_client.EDGE_PREFIX 是同一个约定 */
export const EDGE_PREFIX = "edge:";
export const isEdgeMode = (m: string) => m.startsWith(EDGE_PREFIX);
/** edge:edge_cnn_i8@raw → edge_cnn_i8。
 *  `@后缀` 是后处理，**不是模型名的一部分**——带着后缀去认模型的话，
 *  同一个模型的两种后处理会被当成两个不同的模型。 */
export const edgeTagOf = (m: string) => m.slice(EDGE_PREFIX.length).split("@")[0];
/** 端侧版本用的后处理。不带后缀 = viterbi，跟后端 EDGE_DEFAULT_POST 一致。 */
export const edgePostOf = (m: string): string =>
  (m.slice(EDGE_PREFIX.length).split("@")[1] || "viterbi");
export const INFER_MODE_OPTIONS: { label: string; value: AlgoMode }[] = [
  { label: "稳定版", value: "stable" },
  { label: "稳定版 v2", value: "viterbi" },
  // 跟「稳定版 v2」**只差一条规则**：抓挠不再吞并前后的甩身体。
  //
  // 做成一个版本而不是一个配置开关：结果按 (样本, 模型, 版本) 存，
  // 版本串不同才不会互相覆盖——改配置的话两次跑出来 mode 都是 viterbi，
  // 后一次直接把前一次顶掉，没法并排比。
  { label: "稳定版 v2 · 不吞甩身体", value: "viterbi_noshake" },
  { label: "调试版", value: "raw" },
];
/** 历史记录里回显用：后端存的是 stable/viterbi/raw */
export const INFER_MODE_LABEL: Record<string, string> = Object.fromEntries(
  INFER_MODE_OPTIONS.map((o) => [o.value, o.label])
);

/** 历史记录/回显用的显示名。端侧的标签是运行时才知道的，
 *  所以不在 INFER_MODE_LABEL 那张表里，单独拼。 */
/** 端侧后处理的显示名。board 不在 INFER_MODE_LABEL 里——它不是
 *  算法服务的 mode，是"用板上那份 C 做后处理"。 */
const EDGE_POST_LABEL: Record<string, string> = { board: "板上整条链" };
export const modeLabelOf = (m: string) =>
  isSrvMode(m)
    ? `服务端 · ${srvTagOf(m)} · ${INFER_MODE_LABEL[srvPostOf(m)] ?? srvPostOf(m)}`
    : isEdgeMode(m)
    ? `端侧 · ${edgeTagOf(m)} · ${EDGE_POST_LABEL[edgePostOf(m)] ?? INFER_MODE_LABEL[edgePostOf(m)] ?? edgePostOf(m)}`
    : (INFER_MODE_LABEL[m] ?? m);

/** 某个版本的说明文案。端侧的不在 INFER_MODE_HINT 那张表里（它是运行时才知道的），
 *  直接用 INFER_MODE_HINT[m] 会在端侧那几个上拿到 undefined。 */
export const hintOf = (m: string) => {
  if (isSrvMode(m)) return SRV_MODE_HINT;
  if (!isEdgeMode(m)) return INFER_MODE_HINT[m as AlgoMode] ?? "";
  const post = edgePostOf(m);
  if (post === "raw") return EDGE_RAW_HINT;
  if (post === "board") return EDGE_BOARD_HINT;
  return EDGE_MODE_HINT;
};

/** 端侧 + 线上同一份后处理：对比表里差的只有模型本身。 */
export const EDGE_MODE_HINT =
  "模型跑的是烧进项圈的那份 C（逐位一致），后处理跟线上「稳定版 v2」"
  + "**是同一份代码**。所以跟线上版本比，差的只有模型本身。";
/** 端侧 + 板上后处理：整条链都是板子会跑的那份 C。 */
export const EDGE_BOARD_HINT =
  "模型、推理、**后处理全是板上那份 C**——手里没有板子时，"
  + "这一列才真正回答「板子会报什么」。跟上面那个「稳定版 v2」比，"
  + "差的只有后处理的实现（离线 viterbi vs 板上的流式有界回溯）。"
  + "两边应该一致，不一致就是真的分家了，值得查。";
/** 端侧 raw：板子上真实会报的东西。 */
export const EDGE_RAW_HINT =
  "跑的是烧进项圈的那份 C，而且**不做任何后处理**——板子上真实会报的样子，"
  + "片段更碎。用来看设备端实际输出，不适合直接铺草稿。";
export const INFER_MODE_HINT: Record<AlgoMode, string> = {
  stable: "活动/睡觉平滑、碎片并入邻段；抓挠用双阈值滞回不被切碎，间隔 4s 内合并，前后的甩身体并入；单窗口噪声丢掉",
  viterbi: "动态规划解码整条时间轴，切换类别要付代价，所有类别统一生效；抓挠同样合并/过滤。跟稳定版对比看哪个更接近人工",
  viterbi_noshake: "跟稳定版 v2 只差一条规则：抓挠不再吞并前后的甩身体。模型完全一样，用来看那条规则划不划算",
  raw: "模型逐窗口原始输出，活动/睡觉会来回闪，抓挠有很多单窗口噪声。用来看模型到底说了什么",
};

/** 「不吞甩身体」那一版跟稳定版 v2 的唯一差别。 */
export const NOSHAKE_HINT =
  "跟「稳定版 v2」**只差一条规则**：抓挠不再吞并前后的甩身体。"
  + "那条规则本来是为了修「模型爱把抓挠的剧烈段判成甩身体」，"
  + "但反过来会把真的甩身体并进抓挠。两个版本并排跑同一批样本，"
  + "就能看出那条规则到底划不划算。**模型完全一样。**";

/** 服务端的另一个模型：跟线上那三行同一台服务、同一套后处理，只换了模型。 */
export const SRV_MODE_HINT =
  "同一台 AI 服务、同一份后处理，**只换了模型**。所以跟线上「稳定版 v2」"
  + "并排跑同一批样本时，差的只有模型本身。跑的是服务器上的 sklearn，"
  + "**不是**烧进项圈的那份 C——想知道板子会报什么，看端侧那几行。";

/** 每个 IMU 预测模型是什么。统计页分组显示时用，说明只写"跟别的比差在哪"。
 *  认不出来的按命名规律兜底（见 imuModelHint）——新模型不至于一行说明都没有。 */
export const IMU_MODEL_HINT: Record<string, string> = {
  ml_rf: "线上主力。随机森林，6 轴（加速度 + 陀螺仪），跑在服务器上",
  acc3_rf: "跟 ml_rf 同一套做法，但**只用 3 轴加速度**（去掉陀螺仪）——验证端侧能不能省掉陀螺仪",
  edge_rf_d10: "端侧随机森林，树深限到 10。按项圈的算力和内存裁过，推理是烧进固件那份 C",
  edge_cnn_i8: "端侧小 CNN，int8 量化。跟 edge_rf_d10 比的是「同样上板，哪种模型更准」",
};

export function imuModelHint(tag: string): string {
  const hit = IMU_MODEL_HINT[tag];
  if (hit) return hit;
  const parts: string[] = [];
  if (tag.startsWith("edge")) parts.push("端侧尺寸的模型，推理跑的是固件那份 C");
  if (/acc3|_acc/.test(tag)) parts.push("只用 3 轴加速度，没有陀螺仪");
  if (/cnn/i.test(tag)) parts.push("小 CNN");
  else if (/rf|forest/i.test(tag)) parts.push("随机森林");
  if (/i8|int8/i.test(tag)) parts.push("int8 量化");
  return parts.join("；") || "还没登记说明的模型";
}

/** 服务端 / 端侧这两组各是什么，差在哪。统计页分组标题下面那一句。 */
export const IMU_KIND_HINT: Record<"server" | "edge", string> = {
  server: "跑在服务器上的 sklearn（imu_train 的 label_service）。算力不受限，线上用的就是这一组",
  edge: "跑的是烧进项圈的那份 C（algo_tinyml 的 edge_service），逐位跟固件一致。手里还没有板子，用它先回答「上板之后行不行」",
};
export const IMU_KIND_LABEL: Record<"server" | "edge", string> = {
  server: "服务端模型",
  edge: "端侧推理模型",
};
