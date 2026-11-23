import type { AiCandidate } from "@/api/candidates";

// 疑似片段（候选）是怎么挑出来的：候选面板和已标注片段的「来历」列共用。
// 单独放一个文件：两个面板互相引用会成环
export const REASON_LABEL: Record<AiCandidate["reason"], string> = {
  low_conf: "模型低置信",
  spectral: "频谱像抓挠",
  // 只靠加速度姿态挑出来的：头伸到某个部位并保持住。给「舔/啃哪个部位」攒标注用，
  // 人只看这几段，不用翻 24 小时视频
  grooming: "姿态像舔/啃",
  // 同一批「头伸出去并保持」的姿态段，按节律猜成进食 / 饮水（见 imu_train behaviors.py）
  eating: "姿态+节律像进食",
  drinking: "姿态+节律像饮水",
  // 加速度上一串孤立的尖脉冲，峰之间安静
  barking: "冲击串像吠叫",
  // 短促、大幅、规整的 3–9 Hz 振荡
  shaking: "振荡像甩头/抖身",
  // 走 → 停下换姿势不动一会儿 → 又走。判据弱，误报多
  toileting: "走停走像如厕",
  // 模型里单独训了进食 / 饮水 / 嗅闻…（容易被判成抓挠的动作）：它判成这一类的片段不进草稿，
  // 拿来给人确认，快速补负例标注（imu_train label_service/mining.py）
  model_neg: "模型判成这一类",
  // 视觉大模型看视频挑出来的：画面里狗在做这个动作。类别是项目里选的那几类（含部位）
  vision: "画面看像",
  // 画面向量索引：拿一帧样例（或一句话）在整个项目里找长得像的几秒。不问大模型，免费
  similar: "画面相似",
  // 抽查：新模型报了、人工没标的片段，请人对着视频判是不是真的（统计新模型多报的是真抓挠还是误报）
  spot: "抽查·新模型报的",
  // 专项：训练数据里标「活动」、模型很有把握判成抓挠——是漏标的抓挠，还是别的动作（舔 / 啃 / 蹭 / 进食…）
  act_scr: "专项·活动里疑似抓挠",
  // 补标：模型在没人标的时间里报的抓挠，抽查约 3/4 是漏标的。普通来源，确认了写进任务标注
  unl_fill: "补标·未标时间",
};

/** 疑似片段的显示名：「疑似」+ 类别。类别本身已经叫「疑似如厕-排尿」的不再叠一个「疑似」 */
export const candTitle = (name: string) => (name.startsWith("疑似") ? name : `疑似${name}`);


/** 专项片段的背景（写在说明文字最前面的标记），分四种，人可以按它挑着先判 */
export type SpotKind = "plain" | "approved" | "overlap" | "both";
export const SPOT_KIND: Record<SpotKind, { short: string; color: string; tip: string }> = {
  plain: { short: "普通", color: "green", tip: "没有特别背景，直接判" },
  approved: { short: "任务已通过", color: "default", tip: "这段所在的任务之前已经审核通过（现在专项不用认领、也能直接判）" },
  overlap: { short: "跟已有片段重叠", color: "orange", tip: "同一位置已经有一条「AI 低置信」抓挠疑似片段，括号里是那条现在的状态，可以对照着看" },
  both: { short: "两样都是", color: "purple", tip: "任务已通过，同时跟已有低置信片段重叠" },
};
export function spotKindOf(evidence: string | null | undefined): SpotKind {
  const e = evidence ?? "";
  if (e.startsWith("【任务已通过】【")) return "both";
  if (e.startsWith("【任务已通过】")) return "approved";
  if (e.startsWith("【跟已有")) return "overlap";
  return "plain";
}
/** 重叠那条现在的状态（括号里的：待判 / 已确认 / 已排除…） */
export function spotOverlapState(evidence: string | null | undefined): string | null {
  const m = /跟已有低置信抓挠片段重叠（([^）]*)）/.exec(evidence ?? "");
  return m ? m[1] : null;
}
