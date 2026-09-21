/**
 * 一句话搜的现成英文描述：中文类别 → 一句英文。
 *
 * 为什么要手写这张表，而不是拿标签名直接去搜：
 *
 *  1. SigLIP 的文本端是**英文**训练的。中文标签名送进去命中会差一大截，
 *     而且差得不明显——它照样给你 60 个命中，只是那些命中不对。
 *  2. 机翻也不行。「蹭身体」直译 rub body 检索出来的是人擦东西；
 *     写成 a dog rubbing its body against the floor 才是我们要的那个画面。
 *  3. 这张表是**一次写好、全项目复用**的。写错一句，影响的是往后每一次检索，
 *     所以宁可只放几条确定的，也别塞一堆没验过的。
 *
 * 用法：是填进输入框的**起点**，不是终点。人可以在框里接着改——
 * 检索效果跟措辞关系很大，改一版再搜一次是常态，不该被模板锁死。
 *
 * 没收录的类别不给模板（下拉里就没有），别硬凑一句了事。
 */
export const ACTION_QUERIES: { label: string; query: string }[] = [
  { label: "咬尾巴", query: "a dog biting its own tail" },
  { label: "追尾巴", query: "a dog chasing its own tail in circles" },
  { label: "舔身体", query: "a dog licking its own body" },
  { label: "舔前爪", query: "a dog licking its own front paw" },
  { label: "舔后爪", query: "a dog licking its own hind paw" },
  { label: "舔后肢", query: "a dog licking its own hind leg" },
  { label: "舔生殖器/腹股沟", query: "a dog licking its groin area" },
  { label: "啃身体", query: "a dog chewing and nibbling at its own fur" },
  { label: "抓挠（后爪挠）", query: "a dog scratching itself with a hind leg" },
  { label: "抓挠头颈耳", query: "a dog scratching its head neck and ears with a hind paw" },
  { label: "抓挠躯干", query: "a dog scratching its side and belly with a hind leg" },
  { label: "蹭身体（地板）", query: "a dog rubbing its body against the floor" },
  { label: "蹭脸/头（地板）", query: "a dog rubbing its face and head on the floor" },
  { label: "甩身体", query: "a dog shaking its whole body vigorously" },
  { label: "甩头", query: "a dog shaking its head rapidly" },
  { label: "进食", query: "a dog eating food from a bowl" },
  { label: "饮水", query: "a dog drinking water from a bowl" },
  { label: "嗅闻地面", query: "a dog sniffing the floor with its nose down" },
  { label: "如厕（蹲姿）", query: "a dog squatting to defecate" },
  { label: "站立", query: "a dog standing still on all four legs" },
  { label: "趴卧", query: "a dog lying down on the floor resting" },
  { label: "走动", query: "a dog walking across the room" },
];
