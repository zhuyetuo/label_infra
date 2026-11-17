// 负例挖掘模型：训练时把「容易被判成抓挠的动作」各自成一类（不并进「活动」），
// 预标注「只补负例候选」时，模型判成这些类的片段变成候选给人确认（imu_train label_service/mining.py）。
// 推理服务那边认的类别名（MINE_LABELS）跟这里一致：进食 / 饮水 / 嗅闻 / 舔 / 啃 / 蹭（舔身体、啃身体、蹭擦身体也认）

/** 负例大类，顺序就是界面上的显示顺序 */
export const NEG_GROUPS = ["进食", "饮水", "嗅闻", "舔", "啃", "蹭"] as const;

/** 一个类别名属于哪个负例大类：「舔-后肢」「舔身体」→ 舔，「蹭擦身体」→ 蹭；不是负例 → null */
export const negGroupOf = (name: string): string | null =>
  NEG_GROUPS.find((g) => name === g || name.startsWith(`${g}-`) || name.startsWith(g)) ?? null;

/** 一张类别映射表 / 一串类别里，有哪几个负例大类自成一类了（就是负例挖掘模型） */
export const negClassesOf = (classes: Iterable<string>): string[] => {
  const got = new Set(classes);
  return NEG_GROUPS.filter((g) => got.has(g));
};
