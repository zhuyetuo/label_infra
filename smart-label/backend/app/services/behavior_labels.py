"""内置标签模板「犬行为全量（IMU 22 类）」：产品那张 22 类行为表 + 瘙痒四类的解剖学部位子树。

顶层就是 22 个行为，code 直接用表里的（CARE_SCRATCH / ACT_SLEEP……），训练导出和线上模型
对得上。抓 / 舔 / 啃 / 蹭下面按解剖学挂 区域 → 部位 → 左右，正好四层（label_tree.MAX_DEPTH）。
看得清标最细的，看不清停在上级；标了细的自动算进上级。

跟老的「抓/舔/啃/蹭」模板并存：四个大类和已有的部位沿用老模板的 code / 显示名
（lick_body / lick_body_fore_l「舔-前左爪」……），老项目套这张新模板时按 code / 名字直接复用，
已标的片段不用重标；老模板本身不动。

互斥轨（见 label_tracks.py）：
  行为轨  CARE_* / ING_* / ACT_SNIFF / ELIM_POSSIBLE    具体在干什么，一次一件
  运动轨  ACT_REST(→ACT_SLEEP) / ACT_ACTIVITY(→WALK…)   要么静要么动
  姿态轨  POST_SIT / LIE / STAND / TRANS_POSTURE         任一时刻一种姿态
  设备轨  LOOSE_COLLAR                                   随时可叠
跨轨可以同时标（卧着 + 静止 + 舔前爪）；训练导出时按 行为 > 运动 > 姿态 折叠成单标签。

表里"少见"的部位保留、名字带「（少见）」、排在各区域末尾；"重点 / 瘙痒高发"这类备注放模板说明里。
scratch_hind（抓挠后肢臀尾）按解剖学去掉：犬的后爪够不到自身后躯，那些动作是啃或蹭 / 拖屁股，
改成「抓挠-待判定（后躯附近）」给标注员放拿不准的，之后复核改成啃或蹭。
"""

from __future__ import annotations

import colorsys
from dataclasses import dataclass

from sqlalchemy import select

from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.services.grooming_labels import pick_admin

TEMPLATE_NAME = "犬行为全量（IMU 22 类）"
TEMPLATE_DESC = (
    "产品的 22 类行为表（顶层 code 就是模型类别：CARE_SCRATCH、ACT_SLEEP……）+ 抓/舔/啃/蹭按解剖学分的"
    "区域 → 部位 → 左右。分四条互斥轨：行为 / 运动 / 姿态 / 设备，跨轨可以同时标（卧着 + 静止 + 舔前爪），"
    "导出训练集时按 行为 > 运动 > 姿态 折叠成一个时刻一个标签。"
    "重点部位：啃-前爪（趾间/爪垫）、啃-尾根（肛腺）、舔/啃-腹股沟（瘙痒高发）、啃-侧腹（腰胯皮炎高发）、"
    "抓挠-耳/耳后（最典型，标被挠侧）。「抓挠-待判定（后躯附近）」放拿不准是啃还是蹭的，之后复核。"
)

RARE = "（少见）"

# 节点：(code, 名字, [子节点])。code 全大写的是表里的行为 code、原样用、名字不加前缀；
# 小写的是部位，code 拼成「根 code_部位 code」、名字拼成「根名-部位名」（跟老模板一样）。
# LR(...) 展开成 部位 → 左 / 右 两个子节点。
Node = tuple


def LR(code: str, name: str, lname: str | None = None, rname: str | None = None) -> Node:
    return (code, name, [(f"{code}_l", lname or f"左{name}", []), (f"{code}_r", rname or f"右{name}", [])])


ROOTS: list[tuple[str, str, str, str, list]] = [
    # (code, 名字, 轨, 底色, 子节点)。顺序就是工作台第一行的顺序：按轨分组，组内按表的优先级
    ("CARE_SCRATCH", "抓挠", "behavior", "#27AE60", [
        ("head", "头颈耳", [LR("ear", "耳/耳后", "左耳/耳后", "右耳/耳后"), LR("eye", "眼周/颊", "左眼周/颊", "右眼周/颊"),
                          ("chin", "脸/下颌", []), LR("neck", "颈侧/颈下", "左颈侧/颈下", "右颈侧/颈下")]),
        ("shoulder", "肩胸", [LR("withers", "鬐甲/肩", "左鬐甲/肩", "右鬐甲/肩"), ("chest", "前胸/胸侧", []),
                             LR("arm", f"上臂/腋{RARE}", f"左上臂/腋{RARE}", f"右上臂/腋{RARE}")]),
        ("trunk", "躯干", [("belly", "腹前/腹侧", []), ("flank", "侧腹/胁（肋侧/腰窝）", []), ("loin", f"腰{RARE}", [])]),
        ("pending", "待判定（后躯附近）", []),
    ]),
    ("lick_body", "舔", "behavior", "#FF8C42", [
        ("forelimb", "前肢", [LR("fore", "前爪", "前左爪", "前右爪"), LR("forearm", "前臂"),
                             LR("upperarm", f"上臂·肩·腋{RARE}", f"左上臂·肩·腋{RARE}", f"右上臂·肩·腋{RARE}")]),
        ("hindlimb", "后肢", [LR("hind", "后爪", "后左爪", "后右爪"), LR("shank", "小腿"), LR("thigh", "大腿"),
                             LR("thigh_in", "大腿内侧"), ("inguinal", "腹股沟", [])]),
        ("trunk", "躯干", [("chest", f"胸{RARE}", []), ("belly", "腹", []), ("flank", "侧腹/胁", [])]),
        ("groin", "会阴·臀·尾", [("anus", "肛周", []), ("genital", "生殖器", []), ("rump", "臀", []), ("tail", "尾/尾根", [])]),
    ]),
    ("chew_body", "啃", "behavior", "#C0392B", [
        ("forelimb", "前肢", [LR("fore", "前爪", "前左爪", "前右爪"), LR("forearm", f"前臂{RARE}", f"左前臂{RARE}", f"右前臂{RARE}"),
                             LR("upperarm", f"上臂·肩{RARE}", f"左上臂·肩{RARE}", f"右上臂·肩{RARE}")]),
        ("hindlimb", "后肢", [LR("hind", "后爪", "后左爪", "后右爪"), LR("shank", "小腿"), LR("thigh", "大腿"),
                             LR("thigh_in", "大腿内侧"), ("inguinal", "腹股沟", [])]),
        ("trunk", "躯干", [("flank", "侧腹", []), ("belly", f"腹{RARE}", []), ("loin", f"腰{RARE}", [])]),
        ("groin", "会阴·臀·尾", [("tailbase", "尾根", []), ("rump", "臀", []), ("anus", f"肛周{RARE}", []), ("genital", "生殖器", [])]),
        ("head", "头脸颈", [LR("ear_edge", f"耳缘{RARE}", f"左耳缘{RARE}", f"右耳缘{RARE}")]),
    ]),
    ("rub_body", "蹭", "behavior", "#8E44AD", [
        ("face", "头脸颈", [("muzzle", "脸/口鼻", []), LR("ear", "耳/耳后", "左耳/耳后", "右耳/耳后"), ("eye", "眼周", []), ("neck", "颈/喉", [])]),
        ("back", "背侧（仰卧翻滚）", [("withers", "鬐甲/肩背", []), ("spine", "背", []), ("loin", "腰", [])]),
        ("trunk", "躯干侧/腹", [("chest", "胸/前胸", []), ("belly", "腹（仰卧）", []), ("flank", "侧腹/胁", [])]),
        ("rump", "臀尾会阴（坐地/拖屁股）", [("butt", "臀", []), ("anus", "肛周/肛门", []), ("tail", f"尾{RARE}", [])]),
    ]),
    ("CARE_HEADSHAKE", "甩头/抖身", "behavior", "#16A085", [("head", "甩头", []), ("body", "抖身", [])]),
    ("ING_EAT", "进食", "behavior", "#D35400", []),
    ("ING_DRINK", "饮水", "behavior", "#2980B9", []),
    ("ACT_SNIFF", "嗅闻", "behavior", "#7F8C8D", []),
    ("ELIM_POSSIBLE", "疑似如厕", "behavior", "#A04000", [("urinate", "排尿", []), ("defecate", "排便", [])]),
    ("ACT_REST", "静止/休息", "motion", "#5D6D7E", [("ACT_SLEEP", "睡眠", [])]),
    ("ACT_ACTIVITY", "活动", "motion", "#F39C12", [
        ("ACT_WALK", "行走", []), ("ACT_RUN", "奔跑", []), ("ACT_JUMP", "跳跃", []), ("ACT_SWIM", "游泳", []),
        ("ACT_STAIRS", "上下楼", [("up", "上楼", []), ("down", "下楼", [])]),
    ]),
    ("POST_SIT", "坐", "posture", "#3498DB", []),
    ("POST_LIE", "卧", "posture", "#1F618D", [("side", "侧卧", []), ("sternal", "趴卧", []), ("supine", "仰卧", [])]),
    ("POST_STAND", "站立", "posture", "#85C1E9", []),
    ("TRANS_POSTURE", "姿态转换", "posture", "#48C9B0", [
        ("stand_sit", "站→坐", []), ("stand_lie", "站→卧", []), ("sit_lie", "坐→卧", []),
        ("lie_up", "卧→站", []), ("sit_stand", "坐→站", []),
    ]),
    ("LOOSE_COLLAR", "颈圈松动", "device", "#95A5A6", []),
]

# 顶层从 200 起排（老「抓/舔/啃/蹭」模板占 100~180），每个根 60 个号：舔那组最多 40 多条
SORT_BASE = 200
SORT_STRIDE = 60


@dataclass
class Row:
    code: str
    display_name: str
    color: str
    sort_order: int
    parent_code: str | None
    track: str


def _shade(base_hex: str, k: int, n: int) -> str:
    """同一色相、按 k/n 从深到浅：一组一个色系，组内分得开。"""
    r, g, b = (int(base_hex[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l2 = 0.28 + 0.5 * (k / max(1, n - 1)) if n > 1 else 0.45
    r2, g2, b2 = colorsys.hls_to_rgb(h, l2, max(0.45, s))
    return "#%02X%02X%02X" % (round(r2 * 255), round(g2 * 255), round(b2 * 255))


def _is_table_code(code: str) -> bool:
    return code.isupper()


def template_rows() -> list[Row]:
    """模板里全部条目，父在前子在后（套用时子要用父的 id）。"""
    rows: list[Row] = []
    for i, (rcode, rname, track, color, kids) in enumerate(ROOTS):
        base = SORT_BASE + i * SORT_STRIDE
        rows.append(Row(rcode, rname, color, base, None, track))
        flat: list[tuple[str, str, str]] = []      # (code, name, parent_code) 深度优先

        def walk(nodes: list, parent_code: str) -> None:
            for code, name, sub in nodes:
                full = code if _is_table_code(code) else f"{rcode}_{code}"
                full_name = name if _is_table_code(code) else f"{rname}-{name}"
                flat.append((full, full_name, parent_code))
                walk(sub, full)

        walk(kids, rcode)
        for j, (code, name, parent) in enumerate(flat):
            rows.append(Row(code, name, _shade(color, j, len(flat)), base + 1 + j, parent, track))
    return rows


def root_codes() -> list[str]:
    return [r[0] for r in ROOTS]


async def ensure_behavior_template(db) -> str:
    """保证模板存在。返回 "created" / "updated" / "exists" / "no_admin"。

    没有 → 整个建。有了 → 只补**整个根都不在**的根（以后表里加了行为），根还在的一条都不碰：
    管理员删掉 / 改过的东西不会被每次重启覆盖回去。
    """
    tpl = (await db.execute(select(LabelTemplate).where(LabelTemplate.name == TEMPLATE_NAME))).scalar_one_or_none()
    rows = template_rows()
    if tpl is None:
        admin = await pick_admin(db)
        if admin is None:
            return "no_admin"
        tpl = LabelTemplate(name=TEMPLATE_NAME, description=TEMPLATE_DESC, created_by=admin.id)
        db.add(tpl)
        await db.flush()
        for r in rows:
            db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name, color=r.color,
                                     sort_order=r.sort_order, parent_code=r.parent_code, track=r.track))
        await db.commit()
        return "created"
    have = set((await db.execute(
        select(LabelTemplateItem.code).where(LabelTemplateItem.template_id == tpl.id)
    )).scalars().all())
    changed = False
    for rcode in root_codes():
        group = [r for r in rows if r.code == rcode or r.code.startswith(rcode + "_")]
        # 表里的子行为（ACT_SLEEP 在 ACT_REST 下）code 不带根前缀，按父链归组
        by_code = {r.code: r for r in rows}
        for r in rows:
            cur = r.parent_code
            while cur is not None:
                if cur == rcode and r not in group:
                    group.append(r)
                    break
                cur = by_code[cur].parent_code if cur in by_code else None
        if any(r.code in have for r in group):
            continue
        for r in sorted(group, key=lambda x: x.sort_order):
            db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name, color=r.color,
                                     sort_order=r.sort_order, parent_code=r.parent_code, track=r.track))
        changed = True
    if not changed:
        return "exists"
    await db.commit()
    return "updated"
