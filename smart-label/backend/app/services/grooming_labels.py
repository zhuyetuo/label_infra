"""舔 / 啃 / 抓挠 / 蹭 这几组"部位"标签的定义，以及对应的内置标签模板。

label_service 把姿态像舔/啃的片段当候选送上来，label_name 是「舔身体」；标注员
确认时平台在项目里按 display_name / code 找标签，找不到就 422。所以每个要收
这类候选的项目都得有这组标签。两条路：

  1. 标签管理 → 套用模板 → 选「抓/舔/啃/蹭」                 ← 平常用这个
  2. python -m app.scripts.seed_grooming_labels --project N   ← 命令行，顺带把部位子标签挂到父标签下

模板是服务启动时自动保证存在的（ensure_grooming_template），不用人去建；
建过一次之后就归管理员管，改名/改颜色/删条目都不会被启动时覆盖回去。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, update

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.user import User, UserRole

TEMPLATE_NAME = "抓/舔/啃/蹭"
# 以前叫这个；启动时发现旧名字的就改名，不会再多建一个
OLD_TEMPLATE_NAMES = ("舔/啃（IMU 候选）",)
TEMPLATE_DESC = (
    "抓 / 舔 / 啃 / 蹭 四个大类，按部位分层（舔 → 前爪 → 前左爪）。看得清标最细的，"
    "看不清停在上级；标了细的自动算进上级。「舔」是疑似舔/啃候选默认落的类别；"
    "项目里已有同名标签（比如「抓挠」）的直接复用，部位挂到它下面。同一组一个色系，组内深浅不同。"
)

# 每组：(父 code, 父名, 父颜色, 父标签要不要进模板, [部位...])
# 部位：(部位 code, 部位名, 颜色) 或 (部位 code, 部位名, 颜色, [下一层部位...])
#
# 层级：舔 → 前爪 → 前左爪 / 前右爪。看得清标最细的，看不清停在上一级；标了细的
# 自动算进上级（统计、导出都按树算，见 label_tree.py）。
#
# 「抓挠」父标签也进模板：项目里早就有「抓挠」的（code 多半不一样），套用时按
# 显示名认出来直接复用、部位挂到它下面，不会多出第二个「抓挠」（见 apply_template）。
#
# 颜色：一组一个色系（舔=橙 啃=红 抓=绿 蹭=紫），父标签是本色，部位是同一色相
# 深浅不同，一眼能看出是哪组、组内也分得开。
#
# 部位分组按"头戴 IMU 能不能分得开"来定，不按解剖学：
#   舔/啃  用嘴够——舔前爪 / 舔后爪 / 舔侧腹的头部姿态差异最大，生殖区肛周最特殊；
#          爪子再分左右（头往哪边偏）
#   抓挠   用后腿够——挠头颈耳时头会歪着抖，挠躯干/胸腹时身子侧躺，挠后肢时扭身
#   蹭     用身体蹭东西——蹭脸（口鼻眼）、仰躺翻滚蹭背、侧身蹭墙/地、坐着拖屁股
Part = tuple  # (code, name, color) | (code, name, color, [Part, ...])
GROUPS: list[tuple[str, str, str, bool, list]] = [
    ("lick_body", "舔", "#FF8C42", True, [
        ("fore", "前爪", "#8F3800", [("fore_l", "前左爪", "#702C00"), ("fore_r", "前右爪", "#AD4400")]),
        ("hind", "后爪", "#CC5000", [("hind_l", "后左爪", "#EB5C00"), ("hind_r", "后右爪", "#FF7D29")]),
        ("trunk", "躯干侧腹", "#FF6A0A"), ("groin", "生殖区肛周", "#FFB585"),
    ]),
    ("chew_body", "啃", "#C0392B", True, [
        ("fore", "前爪", "#75231A", [("fore_l", "前左爪", "#5C1B15"), ("fore_r", "前右爪", "#8E2A20")]),
        ("hind", "后爪", "#A73125", [("hind_l", "后左爪", "#B33528"), ("hind_r", "后右爪", "#D03E2F")]),
        ("trunk", "躯干侧腹", "#D24637"), ("groin", "生殖区肛周", "#E9A29B"),
    ]),
    ("scratch", "抓挠", "#27AE60", True, [
        ("head", "头颈耳", "#1A7540"), ("trunk", "躯干侧腹", "#25A75C"),
        ("belly", "胸腹", "#37D279"), ("hind", "后肢臀尾", "#9BE9BC"),
    ]),
    ("rub_body", "蹭", "#8E44AD", True, [
        ("face", "头脸口鼻", "#542867"), ("back", "背部翻滚", "#783A92"),
        ("trunk", "躯干侧腹", "#9A4FBA"), ("rump", "臀尾肛周", "#CDA7DC"),
    ]),
]
# 父标签的旧显示名（上一版叫「舔身体」这种）。IMU 候选送上来的 label_name 还是旧名，
# 平台找标签时新旧都认（见 candidates.py 的 alias）；模板里还叫旧名的启动时改成新名。
OLD_PARENT_NAMES = {"lick_body": "舔身体", "chew_body": "啃身体", "rub_body": "蹭身体"}
NAME_ALIASES = {old: new for old, new in ((v, next(g[1] for g in GROUPS if g[0] == k)) for k, v in OLD_PARENT_NAMES.items())}
NAME_ALIASES.update({v: k for k, v in list(NAME_ALIASES.items())})   # 两个方向都认


def alias_names(name: str) -> list[str]:
    """一个标签名可能对应的全部名字（自己 + 新旧别名）。找标签时用 in_。"""
    return [name] + ([NAME_ALIASES[name]] if name in NAME_ALIASES else [])


def walk_parts(parts: list, group_code: str, group_name: str, parent_code: str | None = None):
    """把嵌套的部位摊平成 (code, 显示名, 颜色, 上级 code)，父在前子在后。
    code 一律是「组 code_部位 code」（lick_body_fore_l），显示名一律是「组名-部位名」（舔-前左爪）：
    不把中间那层拼进去，名字短，工作台上摆得下。"""
    for p in parts:
        pcode, pname, pcolor = p[0], p[1], p[2]
        code = f"{group_code}_{pcode}"
        yield code, f"{group_name}-{pname}", pcolor, parent_code or group_code
        if len(p) > 3:
            yield from walk_parts(p[3], group_code, group_name, code)


# 上一版模板里每组所有条目都是父标签那一个色。启动时把还是这个旧色的条目换成
# 新色（管理员自己改过颜色的不动）。
_OLD_GROUP_COLORS = {"lick_body": "#FF8C42", "chew_body": "#C0392B", "scratch": "#F1C40F", "rub_body": "#8E44AD"}

# 上一版舔/啃的爪子只有「前肢爪」「后肢臀尾」两条。启动时把还叫旧名的改成「前爪」「后爪」，
# 并补上左右四条。以"fore/hind 还叫旧名"当没升级过的记号：升级过一次名字就变了，
# 之后管理员把左右爪删掉也不会被重启补回来。
_OLD_PART_NAMES = {"fore": "前肢爪", "hind": "后肢臀尾"}
_LR_PARTS = ("fore_l", "fore_r", "hind_l", "hind_r")

# 第一批放在现有标签后面。现有项目的标签 sort_order 一般在 0~20 之间，
# 从 100 起排不会插到中间去。每组占 20 个号（舔/啃各 12 条）。
SORT_BASE = 100
SORT_STRIDE = 20


@dataclass
class Row:
    code: str
    display_name: str
    color: str
    sort_order: int
    parent_code: str | None = None
    in_template: bool = True


def wanted_rows(with_parts: bool = True) -> list[Row]:
    """项目里要保证存在的全部标签，父在前子在后（子要用父的 id）。"""
    rows: list[Row] = []
    for i, (code, name, color, in_tpl, _parts) in enumerate(GROUPS):
        rows.append(Row(code, name, color, SORT_BASE + i * SORT_STRIDE, in_template=in_tpl))
    if with_parts:
        for i, (code, name, _color, _in_tpl, parts) in enumerate(GROUPS):
            for j, (pcode, pname, pcolor, parent) in enumerate(walk_parts(parts, code, name)):
                rows.append(Row(pcode, pname, pcolor, SORT_BASE + i * SORT_STRIDE + 1 + j, parent_code=parent))
    return rows


def template_rows() -> list[Row]:
    """进模板的那些（现在四个大类都进）。"""
    return [r for r in wanted_rows() if r.in_template]


async def pick_admin(db) -> User | None:
    """挑一个在职的 super_admin / admin 当 created_by。"""
    for role in (UserRole.super_admin, UserRole.admin):
        u = (await db.execute(
            select(User).where(User.role == role, User.is_active.is_(True)).order_by(User.id).limit(1)
        )).scalar_one_or_none()
        if u is not None:
            return u
    return None


async def _recolor_from_old_scheme(db, tpl_id: int) -> int:
    """上一版每组一个色 → 现在组内分深浅。只换还是旧色的条目，跟着它的项目标签一起换
    （跟标签模板页改颜色的行为一致）。返回换了几条。"""
    items = (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == tpl_id)
    )).scalars().all()
    want = {r.code: r for r in template_rows()}
    n = 0
    for it in items:
        r = want.get(it.code)
        if r is None or it.color == r.color:
            continue
        group = it.code if it.code in _OLD_GROUP_COLORS else next(
            (g for g in _OLD_GROUP_COLORS if it.code.startswith(g + "_")), None)
        if group is None or it.color != _OLD_GROUP_COLORS[group]:
            continue
        it.color = r.color
        await db.execute(update(LabelDefinition).where(LabelDefinition.template_item_id == it.id)
                         .values(color=r.color))
        n += 1
    return n


async def _rename_parents(db, tpl_id: int) -> int:
    """上一版父标签叫「舔身体 / 啃身体 / 蹭身体」，现在大类就叫「舔 / 啃 / 蹭」。
    只改还叫旧名的模板条目（连带「舔身体-xxx」的前缀）；项目标签不动（新旧名都认）。"""
    items = (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == tpl_id)
    )).scalars().all()
    new_of = {g[0]: g[1] for g in GROUPS}
    n = 0
    for it in items:
        for gcode, old in OLD_PARENT_NAMES.items():
            if it.code == gcode and it.display_name == old:
                it.display_name = new_of[gcode]
                n += 1
            elif it.code.startswith(gcode + "_") and it.display_name.startswith(old + "-"):
                it.display_name = new_of[gcode] + it.display_name[len(old):]
                n += 1
    return n


async def _fill_parent_codes(db, tpl_id: int) -> int:
    """老模板条目没有 parent_code：按内置定义补上（只补空的，管理员改过的不动）。"""
    items = (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == tpl_id)
    )).scalars().all()
    # 上级不一定在模板里：「抓挠-部位」的上级是项目自己的「抓挠」，套用时按项目找
    want = {r.code: r for r in template_rows()}
    n = 0
    for it in items:
        r = want.get(it.code)
        if it.parent_code is None and r is not None and r.parent_code:
            it.parent_code = r.parent_code
            n += 1
    return n


# 上一版模板故意不带这些组的父标签（怕跟项目里的重复）
_HISTORICALLY_NO_PARENT = ("scratch",)


async def _add_group_parents(db, tpl_id: int) -> int:
    """老模板没带「抓挠」父标签本身（那时怕跟项目里的重复）。现在套用时按名字复用，
    父标签可以进模板了：组里有部位、父不在（按 code 和名字都没有）的补上。"""
    items = (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == tpl_id)
    )).scalars().all()
    codes = {it.code for it in items}
    names = {it.display_name for it in items}
    want = {r.code: r for r in template_rows()}
    n = 0
    for code, name, _color, in_tpl, _parts in GROUPS:
        # 只补历史上故意不带的那个（抓挠）：别的组父不在是管理员自己删的，不动
        if code not in _HISTORICALLY_NO_PARENT or not in_tpl or code in codes or names & set(alias_names(name)):
            continue
        if not any(c.startswith(code + "_") for c in codes):
            continue        # 整组都不在：那是管理员删掉的，不补
        r = want[code]
        db.add(LabelTemplateItem(template_id=tpl_id, code=r.code, display_name=r.display_name,
                                 color=r.color, sort_order=r.sort_order, parent_code=None))
        n += 1
    return n


async def _split_paws(db, tpl_id: int) -> int:
    """舔/啃：「前肢爪」→「前爪」+ 前左/前右，「后肢臀尾」→「后爪」+ 后左/后右。
    只动还叫旧名的；模板条目改名不下发到项目标签（跟标签模板页改名的行为一致）。
    返回改/加了几条。"""
    items = {it.code: it for it in (await db.execute(
        select(LabelTemplateItem).where(LabelTemplateItem.template_id == tpl_id)
    )).scalars().all()}
    want = {r.code: r for r in template_rows()}
    n = 0
    for group in ("lick_body", "chew_body"):
        stale = [p for p, old in _OLD_PART_NAMES.items()
                 if (it := items.get(f"{group}_{p}")) is not None and it.display_name == f"{want[group].display_name}-{old}"]
        if not stale:
            continue
        for p in stale:
            items[f"{group}_{p}"].display_name = want[f"{group}_{p}"].display_name
            n += 1
        for p in _LR_PARTS:
            code = f"{group}_{p}"
            if code in items:
                continue
            r = want[code]
            db.add(LabelTemplateItem(template_id=tpl_id, code=r.code, display_name=r.display_name,
                                     color=r.color, sort_order=r.sort_order, parent_code=r.parent_code))
            n += 1
    return n


async def ensure_grooming_template(db) -> str:
    """保证内置模板存在、且每一组都在。返回 "created" / "updated" / "exists" / "no_admin"。

    模板没有 → 整个建（旧名字的先改名，不另建）。模板有了 → 只补**整组都不在**
    的组（比如后来新加的「抓挠-部位」「蹭身体」），组里哪怕剩一条也不碰；再把
    还是上一版"整组一个色"的条目换成分深浅的新色。管理员删掉/改过的东西不会被
    每次重启覆盖回去。系统还没建管理员账号（首次部署）时建不了，返回 no_admin，
    下次启动再试。
    """
    tpl = (await db.execute(
        select(LabelTemplate).where(LabelTemplate.name == TEMPLATE_NAME)
    )).scalar_one_or_none()
    changed = False
    if tpl is None:
        tpl = (await db.execute(
            select(LabelTemplate).where(LabelTemplate.name.in_(OLD_TEMPLATE_NAMES))
        )).scalars().first()
        if tpl is not None:
            tpl.name = TEMPLATE_NAME
            tpl.description = TEMPLATE_DESC
            changed = True
    if tpl is None:
        admin = await pick_admin(db)
        if admin is None:
            return "no_admin"
        tpl = LabelTemplate(name=TEMPLATE_NAME, description=TEMPLATE_DESC, created_by=admin.id)
        db.add(tpl)
        await db.flush()
        for r in template_rows():
            db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name,
                                     color=r.color, sort_order=r.sort_order, parent_code=r.parent_code))
        await db.commit()
        return "created"

    have = set((await db.execute(
        select(LabelTemplateItem.code).where(LabelTemplateItem.template_id == tpl.id)
    )).scalars().all())
    for code, _name, _color, _in_tpl, _parts in GROUPS:
        group = [r for r in template_rows() if r.code == code or r.code.startswith(code + "_")]
        if any(r.code in have for r in group):
            continue
        for r in group:
            db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name,
                                     color=r.color, sort_order=r.sort_order, parent_code=r.parent_code))
        changed = True
    await db.flush()
    # 几步升级按先后：先改父名（后面的步骤按新名认），再拆爪子，最后补上级
    for step in (_recolor_from_old_scheme, _rename_parents, _split_paws, _add_group_parents, _fill_parent_codes):
        if await step(db, tpl.id):
            changed = True
            await db.flush()
    if not changed:
        return "exists"
    await db.commit()
    return "updated"
