import type { TrainDiag, TrainReview } from "@/api/training";

/**
 * 训练记录「诊断」页的「下一步建议」：按混淆矩阵（验证集）、两两可分性、回放（训练集）几样东西
 * 套几条规则，给出先做什么。只是建议，规则写在这里，看得懂、好改。
 *
 * 核心判断：一类认不好（召回低），主要被认成了哪一类；这两类单独分分不分得开——
 *   分得开   → 不是特征的问题：查标注 / 短片段 / 数据量 / 被大类拖累
 *   能分吃力 → 补干净数据 + 看是靠什么特征在分，业务上要的区分是不是这个
 *   分不开   → 补数据作用有限：合并 / 改定义、加特征、换采样率或传感器
 * 再看训练集上（回放）认得、验证集上认不出 → 泛化不行，数据多样性不够
 */
export interface Advice {
  level: "error" | "warning" | "info";
  title: string;
  detail: string[];
  /** 「去看这些错例」：回放里筛「人标 human → 判成 pred」 */
  pair?: { human: string; pred: string };
}

const featKind = (names: string[]) => {
  const amp = names.filter((n) => /(std|iqr|rms|range|sma|energy|mag|jerk|max|min)$/i.test(n) && !/^(roll|pitch)/.test(n)).length;
  const pose = names.filter((n) => /^(roll|pitch)|_mean$/.test(n)).length;
  const freq = names.filter((n) => /(freq|spec|dom|band|entropy|fft|psd)/i.test(n)).length;
  const m = Math.max(amp, pose, freq);
  if (!m) return null;
  return m === amp ? "幅度类（动得大不大）" : m === pose ? "姿态类（身体 / 头的朝向）" : "频率类（动作节奏）";
};

export function advise(diag: TrainDiag | null | undefined, review: TrainReview | null | undefined, windowS?: number | null): Advice[] {
  const out: Advice[] = [];
  const cm = diag?.confusion;
  if (!cm) return out;
  const names = cm.labels;
  const sep = diag?.separability ?? [];
  const sepOf = (a: string, b: string) => sep.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  names.forEach((name, i) => {
    const row = cm.matrix[i];
    const total = row.reduce((x, y) => x + y, 0);
    if (!total) return;
    const recall = row[i] / total;
    let j = -1, best = 0;
    row.forEach((v, k) => { if (k !== i && v > best) { best = v; j = k; } });
    const smallVal = total < 300;
    if (recall >= 0.75 && !smallVal) return;
    if (recall >= 0.75 && smallVal) {
      out.push({ level: "info", title: `${name}：验证集只有 ${total} 个窗口`, detail: ["数字不稳，看个大概。想判断真实效果，先补一些（不同狗、不同天）再看"] });
      return;
    }
    const other = j >= 0 ? names[j] : null;
    const lost = other ? `主要被认成了「${other}」（${best} 窗，占 ${Math.round((best / total) * 100)}%）` : "";
    const d: string[] = [];
    const p = other ? sepOf(name, other) : undefined;
    // 训练集（回放，按段）认得、验证集认不出：记住了训练过的段，换一批就不行
    const rRecall = review?.per_class?.[name]?.recall;
    const overfit = rRecall != null && rRecall - recall >= 0.3;
    if (p?.auc != null && p.auc >= 0.9) {
      d.push(`单独分「${name} vs ${other}」AUC ${p.auc}：分得开，不是特征不够的问题。`);
      d.push(`先去回放里看「人标${name} → 判成${other}」，改掉「疑似标错」的；「段里混了别的」的调起止 / 拆开`);
      const shortRows = (review?.rows ?? []).filter((r) => r.human === name && r.pred === other);
      const nShort = windowS ? shortRows.filter((r) => r.seconds < windowS).length : 0;
      if (windowS && shortRows.length && nShort / shortRows.length >= 0.3) {
        d.push(`这些错例里 ${nShort}/${shortRows.length} 段比窗口（${windowS}s）还短：一个窗口里大半是别的动作，窗口的标签跟内容对不上。` +
          `可以试：提高采样率（31.25Hz 比 25Hz 对快动作更好）、窗口改短、或者训练时只用不短于窗口的段`);
      }
      if (total < 1000) d.push(`${name} 的数据也偏少（验证集 ${total} 窗）：补不同狗、不同设备的${name}`);
    } else if (p?.auc != null && p.auc >= 0.75) {
      const k = featKind(p.top_features.map((f) => f.feature));
      d.push(`单独分「${name} vs ${other}」AUC ${p.auc}：能分但吃力。`);
      if (k) d.push(`现在主要靠${k}的特征在分。业务上要的区分是不是这个？比如「站着不动算活动、卧着不动算静止」要靠姿态，不是靠动作大小——那就要把姿态类特征做好（更长的窗口 / 更准的重力方向），或者把这两种情况拆成单独的类`);
      d.push(`统一标注口径（同一种画面所有人都标成同一类），再补干净的数据：不同狗、不同设备、不同时间`);
    } else if (p?.auc != null) {
      d.push(`单独分「${name} vs ${other}」AUC ${p.auc}：现有特征下基本分不开。一直补数据作用有限。`);
      d.push(`考虑：合并这两类 / 改类别定义；加针对性的特征；换模型；提高采样率或加传感器（比如陀螺仪）`);
    } else if (other) {
      d.push(`这一对没算可分性（混得不够多或者是老版本）。先去回放里看「人标${name} → 判成${other}」的错例`);
    }
    if (overfit) {
      d.push(`训练集上（回放）召回 ${Math.round((rRecall ?? 0) * 100)}%，验证集上只有 ${Math.round(recall * 100)}%：记住了训练过的段、换一批就不行——数据多样性不够（同一只狗 / 同一天太多），补别的狗、别的设备；模型也可以简单一点（叶子最少样本数调大）`);
    }
    if (smallVal) d.push(`验证集只有 ${total} 个窗口，这个召回本身也不稳`);
    out.push({
      level: recall < 0.5 ? "error" : "warning",
      title: `${name}：召回 ${Math.round(recall * 100)}%${lost ? `，${lost}` : ""}`,
      detail: d,
      ...(other ? { pair: { human: name, pred: other } } : {}),
    });
  });
  const nMis = review?.by_hint?.["疑似标错"] ?? 0;
  if (nMis) out.unshift({ level: "warning", title: `回放里有 ${nMis} 条「疑似标错」`, detail: ["模型很有把握是另一类、几乎不给人标的那一类概率。先挨个看一眼，改掉标错的——改标注比补数据便宜得多"] });
  const nUn = review?.by_kind?.["未标注区报事件"] ?? 0;
  if (nUn >= 50) out.push({ level: "info", title: `没标注的时间里，模型报了 ${nUn} 段事件类`, detail: ["抽几条看：是真抓挠 / 真甩动就补标（白捡的数据）；不是的话是误报，说明模型对没见过的动作太敏感"] });
  return out;
}
