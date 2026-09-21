/**
 * 标签 → 一句英文描述（一句话找画面用）。
 *
 * ## 为什么要手写这张表
 *
 *  1. SigLIP 的文本端是**英文**训练的。中文标签名送进去命中会差一大截，
 *     而且差得不明显——它照样给你 60 个命中，只是那些命中不对。
 *  2. 机翻也不行。「蹭-背」直译 rub back 检索出来的是人按摩；
 *     写成 a dog rolling on its back on the floor 才是我们要的那个画面。
 *  3. 一次写好、全项目复用。写错一句，影响的是往后每一次检索。
 *
 * ## 为什么**不是**每条标签都有一句
 *
 * 全量标签有 150 条，其中一多半是「左/右」和更细的部位（左耳 / 右耳、
 * 左大腿内侧…）。**SigLIP 分不出左右，也分不出大腿内侧和大腿。** 给它们各编
 * 一句，只会让人以为检索能分到那一层——那是假的精度，比没有更糟：人会拿着
 * 「左耳」的结果去标左耳。
 *
 * 所以这里只给**检索真能分开**的那些写句子，更细的一律回退到上一级，
 * 并且在界面上写明"用的是哪一句"。回退规则见 queryFor()。
 *
 * ## 怎么用
 *
 * 填进输入框的**起点**，不是终点。检索效果跟措辞关系很大，改一版再搜一次是常态。
 */

/** 标签显示名 → 英文描述。键跟「犬行为全量（IMU 22 类）」模板里的 display_name 对齐 */
export const LABEL_QUERIES: Record<string, string> = {
  // ── 四个动作的根：最常用，也是所有细部位的兜底 ──
  抓挠: "a dog scratching itself with a hind leg",
  舔: "a dog licking its own body",
  啃: "a dog chewing and nibbling at its own fur",
  蹭: "a dog rubbing its body against the floor",

  // ── 抓挠：后爪去挠。区域之间姿势差得明显，值得各写一句 ──
  "抓挠-头颈耳": "a dog scratching its head and neck with a hind paw",
  "抓挠-耳/耳后": "a dog scratching behind its ear with a hind paw",
  "抓挠-眼周/颊": "a dog scratching its cheek and the area around its eye with a hind paw",
  "抓挠-脸/下颌": "a dog scratching its muzzle and chin with a hind paw",
  "抓挠-颈侧/颈下": "a dog scratching the side of its neck and throat with a hind paw",
  "抓挠-肩胸": "a dog scratching its shoulder and chest with a hind paw",
  "抓挠-鬐甲/肩": "a dog scratching its shoulder blade with a hind paw",
  "抓挠-前胸/胸侧": "a dog scratching its chest with a hind paw",
  "抓挠-躯干": "a dog scratching its side and belly with a hind leg",
  "抓挠-腹前/腹侧": "a dog lying on its side scratching its belly with a hind leg",
  "抓挠-侧腹/胁（肋侧/腰窝）": "a dog scratching its flank and ribs with a hind leg",
  "抓挠-待判定（后躯附近）": "a dog working at its hindquarters with its hind leg or muzzle",

  // ── 舔：嘴够到身上某处并保持住 ──
  "舔-前肢": "a dog licking its front leg",
  "舔-前爪": "a dog licking its own front paw",
  "舔-前臂": "a dog licking its foreleg above the paw",
  "舔-后肢": "a dog licking its hind leg",
  "舔-后爪": "a dog licking its own hind paw",
  "舔-小腿": "a dog licking its lower hind leg",
  "舔-大腿": "a dog licking its thigh",
  "舔-大腿内侧": "a dog lying on its side licking the inner side of its thigh",
  "舔-腹股沟": "a dog licking its groin area",
  "舔-躯干": "a dog licking its own side and belly",
  "舔-腹": "a dog licking its belly",
  "舔-侧腹/胁": "a dog licking its flank",
  "舔-会阴·臀·尾": "a dog licking its rear end, tail base and hips",
  "舔-肛周": "a dog licking under its tail",
  "舔-生殖器": "a dog licking its genital area",
  "舔-臀": "a dog licking its hip and rump",
  "舔-尾/尾根": "a dog licking the base of its own tail",

  // ── 啃：牙齿去咬、头一顿一顿的（跟舔在画面上最难分，措辞上强调啃咬） ──
  "啃-前肢": "a dog gnawing at its front leg",
  "啃-前爪": "a dog chewing and biting at its own front paw",
  "啃-后肢": "a dog gnawing at its hind leg",
  "啃-后爪": "a dog chewing and biting at its own hind paw",
  "啃-小腿": "a dog gnawing at its lower hind leg",
  "啃-大腿": "a dog gnawing at its thigh",
  "啃-大腿内侧": "a dog gnawing at the inner side of its thigh",
  "啃-腹股沟": "a dog biting and nibbling at its groin",
  "啃-躯干": "a dog nibbling at the fur on its side",
  "啃-侧腹": "a dog nibbling at the fur on its flank and ribs",
  "啃-会阴·臀·尾": "a dog biting at the base of its tail and its rump",
  "啃-尾根": "a dog biting at the base of its own tail",
  "啃-臀": "a dog nibbling at its rump",
  "啃-头脸颈": "a dog nibbling at the edge of its ear",

  // ── 蹭：身体去蹭地板/墙，多半是翻滚或拖着走 ──
  "蹭-头脸颈": "a dog rubbing its face and head on the floor",
  "蹭-脸/口鼻": "a dog rubbing its muzzle on the floor",
  "蹭-耳/耳后": "a dog rubbing the side of its head and ear on the floor",
  "蹭-眼周": "a dog rubbing the side of its face on the floor",
  "蹭-颈/喉": "a dog rubbing its neck and throat on the floor",
  "蹭-背侧（仰卧翻滚）": "a dog rolling on its back on the floor",
  "蹭-鬐甲/肩背": "a dog rubbing its shoulders on the floor while rolling",
  "蹭-背": "a dog lying on its back and wriggling from side to side",
  "蹭-腰": "a dog rubbing its lower back on the floor while rolling",
  "蹭-躯干侧/腹": "a dog rubbing its side along the floor",
  "蹭-胸/前胸": "a dog rubbing its chest on the floor",
  "蹭-腹（仰卧）": "a dog lying belly up rubbing against the floor",
  "蹭-侧腹/胁": "a dog rubbing its flank on the floor or against a wall",
  "蹭-臀尾会阴（坐地/拖屁股）": "a dog scooting its bottom along the floor while sitting",
  "蹭-臀": "a dog dragging its rear end across the floor",
  "蹭-肛周/肛门": "a dog scooting and dragging its anus on the floor",

  // ── 其余行为 ──
  "甩头/抖身": "a dog shaking its whole body vigorously",
  "甩头/抖身-甩头": "a dog shaking its head rapidly",
  "甩头/抖身-抖身": "a wet dog shaking its whole body from head to tail",
  进食: "a dog eating food from a bowl",
  饮水: "a dog drinking water from a bowl",
  嗅闻: "a dog sniffing the floor with its nose down",
  疑似如厕: "a dog squatting to relieve itself",
  "疑似如厕-排尿": "a dog urinating with one hind leg lifted or squatting",
  "疑似如厕-排便": "a dog squatting with its back arched to defecate",

  // ── 运动 / 姿态：不是瘙痒相关，但翻数据时常要找 ──
  "静止/休息": "a dog lying still and resting on the floor",
  睡眠: "a dog curled up asleep",
  活动: "a dog moving around the room",
  行走: "a dog walking across the room",
  奔跑: "a dog running",
  跳跃: "a dog jumping up",
  坐: "a dog sitting upright on its haunches",
  卧: "a dog lying down on the floor",
  "卧-侧卧": "a dog lying on its side with legs stretched out",
  "卧-趴卧": "a dog lying on its chest with front legs forward",
  "卧-仰卧": "a dog lying on its back with belly up",
  站立: "a dog standing still on all four legs",

  // ── 不在标签表里、但常要找的画面 ──
  咬尾巴: "a dog biting its own tail",
  追尾巴: "a dog chasing its own tail in circles",
  打哈欠: "a dog yawning with its mouth wide open",
  伸懒腰: "a dog stretching with its front legs forward and rear up",
};

/** 「（少见）」这种后缀不影响是哪个部位，比之前先去掉 */
const strip = (s: string) => s.replace(/（[^）]*）/g, "").trim();

/**
 * 某个标签用哪一句去搜，以及这一句是从哪一级拿的。
 *
 * 回退顺序：这一条本身 → 去掉左/右 → 去掉「（少见）」→ 上一级（按「-」截） → 根。
 * `exact=false` 时界面上要写明"用的是上一级那一句"——**别让人以为检索能分到
 * 他选的那一层**。分不出左右还装作分得出，人会拿着「左耳」的结果去标左耳。
 */
export function queryFor(labelName: string): { query: string; from: string; exact: boolean } | null {
  const tries: string[] = [];
  const push = (s: string) => {
    if (s && !tries.includes(s)) tries.push(s);
  };
  push(labelName);
  push(strip(labelName));
  // 左/右在部位名里是「舔-左大腿」「抓挠-左耳/耳后」这样，也有「前左爪」「后右爪」
  const noLR = strip(labelName)
    .replace(/-([左右])/, "-")
    .replace(/-(前|后)([左右])/, "-$1")
    .replace(/^([左右])/, "");
  push(noLR);
  // 一级一级往上找：舔-左大腿 → 舔-大腿 → 舔
  for (const base of [noLR, strip(labelName)]) {
    const i = base.indexOf("-");
    if (i > 0) push(base.slice(0, i));
  }
  for (const k of tries) {
    if (LABEL_QUERIES[k]) return { query: LABEL_QUERIES[k], from: k, exact: k === labelName };
  }
  return null;
}

/** 下拉里给人挑的那一份：表里全部条目，按名字。选完还能在输入框里改 */
export const ACTION_QUERIES: { label: string; query: string }[] =
  Object.entries(LABEL_QUERIES).map(([label, query]) => ({ label, query }));
