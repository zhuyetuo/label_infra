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
};

/** 疑似片段的显示名：「疑似」+ 类别。类别本身已经叫「疑似如厕-排尿」的不再叠一个「疑似」 */
export const candTitle = (name: string) => (name.startsWith("疑似") ? name : `疑似${name}`);
