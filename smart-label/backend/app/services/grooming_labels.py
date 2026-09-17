"""「舔身体 / 啃身体」这组标签的定义，以及对应的内置标签模板。

label_service 把姿态像舔/啃的片段当候选送上来，label_name 是「舔身体」；标注员
确认时平台在项目里按 display_name / code 找标签，找不到就 422。所以每个要收
这类候选的项目都得有这组标签。两条路：

  1. 标签管理 → 套用模板 → 选「舔/啃（IMU 候选）」          ← 平常用这个
  2. python -m app.scripts.seed_grooming_labels --project N   ← 命令行，顺带把部位子标签挂到父标签下

模板是服务启动时自动保证存在的（ensure_grooming_template），不用人去建；
建过一次之后就归管理员管，改名/改颜色/删条目都不会被启动时覆盖回去。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select

from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.user import User, UserRole

TEMPLATE_NAME = "舔/啃（IMU 候选）"
TEMPLATE_DESC = (
    "疑似舔/啃候选确认要用的标签。「舔身体」是候选默认落的类别，"
    "带部位的用于「改成别的」里细分；不需要分部位可以把子项删掉。"
)

# (code, display_name, color)。code 项目内唯一，display_name 要跟 label_service 的
# GROOM_LABEL 一致（默认「舔身体」），候选就是按这个名字来找标签的。
BASE_LABELS: list[tuple[str, str, str]] = [
    ("lick_body", "舔身体", "#FF8C42"),
    ("chew_body", "啃身体", "#C0392B"),
]

# 部位分组按"IMU 能不能分得开"来定，不按解剖学：头戴 IMU 时舔前爪 / 舔后躯 /
# 舔侧腹的头部姿态差异最大，生殖区肛周动作幅度最特殊，所以先分这四组。
BODY_PARTS: list[tuple[str, str]] = [
    ("fore", "前肢爪"),
    ("hind", "后肢臀尾"),
    ("trunk", "躯干侧腹"),
    ("groin", "生殖区肛周"),
]

# 第一批放在现有标签后面。现有项目的标签 sort_order 一般在 0~20 之间，
# 从 100 起排不会插到中间去。
SORT_BASE = 100


@dataclass
class Row:
    code: str
    display_name: str
    color: str
    sort_order: int
    parent_code: str | None = None


def wanted_rows(with_parts: bool = True) -> list[Row]:
    """要保证存在的全部标签，父在前子在后（子要用父的 id）。"""
    rows: list[Row] = []
    for i, (code, name, color) in enumerate(BASE_LABELS):
        rows.append(Row(code, name, color, SORT_BASE + i * 10))
    if with_parts:
        for i, (code, name, color) in enumerate(BASE_LABELS):
            for j, (pcode, pname) in enumerate(BODY_PARTS):
                rows.append(Row(f"{code}_{pcode}", f"{name}-{pname}", color,
                                SORT_BASE + i * 10 + 1 + j, parent_code=code))
    return rows


async def pick_admin(db) -> User | None:
    """挑一个在职的 super_admin / admin 当 created_by。"""
    for role in (UserRole.super_admin, UserRole.admin):
        u = (await db.execute(
            select(User).where(User.role == role, User.is_active.is_(True)).order_by(User.id).limit(1)
        )).scalar_one_or_none()
        if u is not None:
            return u
    return None


async def ensure_grooming_template(db) -> str:
    """保证内置模板存在。返回 "created" / "exists" / "no_admin"。

    只在**没有**同名模板时建；有了就一个字不碰——管理员改过的东西不能被
    每次重启覆盖回去。系统还没建管理员账号（首次部署）时建不了，返回
    no_admin，下次启动再试。
    """
    exists = (await db.execute(
        select(LabelTemplate.id).where(LabelTemplate.name == TEMPLATE_NAME)
    )).scalar_one_or_none()
    if exists is not None:
        return "exists"
    admin = await pick_admin(db)
    if admin is None:
        return "no_admin"
    tpl = LabelTemplate(name=TEMPLATE_NAME, description=TEMPLATE_DESC, created_by=admin.id)
    db.add(tpl)
    await db.flush()
    for r in wanted_rows():
        db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name,
                                 color=r.color, sort_order=r.sort_order))
    await db.commit()
    return "created"
