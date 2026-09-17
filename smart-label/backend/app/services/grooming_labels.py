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
    "抓挠 / 舔 / 啃 / 蹭 四组按部位细分的标签。「舔身体」是疑似舔/啃候选默认落的类别；"
    "「抓挠」本身项目里已有所以不带，只带部位。同一组一个色系，组内深浅不同。"
    "不需要分部位可以把子项删掉。"
)

# 每组：(父 code, 父名, 父颜色, 父标签要不要进模板, [(部位 code, 部位名, 颜色), ...])
#
# 「抓挠」父标签**不进模板**：每个项目早就有「抓挠」了（AI 预标注/统计都靠它），
# 模板再带一个同名的进去，套用时按 code 查重发现不一样就会多出第二个「抓挠」，
# 统计就乱了。模板里只带「抓挠-部位」子项；命令行脚本会把它们挂到项目里
# 已有的「抓挠」下面。
#
# 颜色：一组一个色系（舔=橙 啃=红 抓=绿 蹭=紫），父标签是本色，四个部位是同一
# 色相从深到浅四档（亮度 28% / 40% / 52% / 76%），一眼能看出是哪组、组内也分得开。
#
# 部位分组按"头戴 IMU 能不能分得开"来定，不按解剖学：
#   舔/啃  用嘴够——舔前爪 / 舔后躯 / 舔侧腹的头部姿态差异最大，生殖区肛周最特殊
#   抓挠   用后腿够——挠头颈耳时头会歪着抖，挠躯干/胸腹时身子侧躺，挠后肢时扭身
#   蹭     用身体蹭东西——蹭脸（口鼻眼）、仰躺翻滚蹭背、侧身蹭墙/地、坐着拖屁股
GROUPS: list[tuple[str, str, str, bool, list[tuple[str, str, str]]]] = [
    ("lick_body", "舔身体", "#FF8C42", True, [
        ("fore", "前肢爪", "#8F3800"), ("hind", "后肢臀尾", "#CC5000"),
        ("trunk", "躯干侧腹", "#FF6A0A"), ("groin", "生殖区肛周", "#FFB585"),
    ]),
    ("chew_body", "啃身体", "#C0392B", True, [
        ("fore", "前肢爪", "#75231A"), ("hind", "后肢臀尾", "#A73125"),
        ("trunk", "躯干侧腹", "#D24637"), ("groin", "生殖区肛周", "#E9A29B"),
    ]),
    ("scratch", "抓挠", "#27AE60", False, [
        ("head", "头颈耳", "#1A7540"), ("trunk", "躯干侧腹", "#25A75C"),
        ("belly", "胸腹", "#37D279"), ("hind", "后肢臀尾", "#9BE9BC"),
    ]),
    ("rub_body", "蹭身体", "#8E44AD", True, [
        ("face", "头脸口鼻", "#542867"), ("back", "背部翻滚", "#783A92"),
        ("trunk", "躯干侧腹", "#9A4FBA"), ("rump", "臀尾肛周", "#CDA7DC"),
    ]),
]

# 上一版模板里每组所有条目都是父标签那一个色。启动时把还是这个旧色的条目换成
# 新色（管理员自己改过颜色的不动）。
_OLD_GROUP_COLORS = {"lick_body": "#FF8C42", "chew_body": "#C0392B", "scratch": "#F1C40F", "rub_body": "#8E44AD"}

# 第一批放在现有标签后面。现有项目的标签 sort_order 一般在 0~20 之间，
# 从 100 起排不会插到中间去。每组占 10 个号。
SORT_BASE = 100


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
        rows.append(Row(code, name, color, SORT_BASE + i * 10, in_template=in_tpl))
    if with_parts:
        for i, (code, name, _color, _in_tpl, parts) in enumerate(GROUPS):
            for j, (pcode, pname, pcolor) in enumerate(parts):
                rows.append(Row(f"{code}_{pcode}", f"{name}-{pname}", pcolor,
                                SORT_BASE + i * 10 + 1 + j, parent_code=code))
    return rows


def template_rows() -> list[Row]:
    """进模板的那些（去掉「抓挠」父标签本身）。"""
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
                                     color=r.color, sort_order=r.sort_order))
        await db.commit()
        return "created"

    have = set((await db.execute(
        select(LabelTemplateItem.code).where(LabelTemplateItem.template_id == tpl.id)
    )).scalars().all())
    for code, _name, _color, _in_tpl, _parts in GROUPS:
        group = [r for r in template_rows() if r.code == code or r.parent_code == code]
        if any(r.code in have for r in group):
            continue
        for r in group:
            db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name,
                                     color=r.color, sort_order=r.sort_order))
        changed = True
    await db.flush()
    if await _recolor_from_old_scheme(db, tpl.id):
        changed = True
    if not changed:
        return "exists"
    await db.commit()
    return "updated"
