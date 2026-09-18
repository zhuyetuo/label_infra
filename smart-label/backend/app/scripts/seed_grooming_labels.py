"""给项目一键补上「舔身体 / 啃身体」这组标签，让疑似舔/啃候选能被确认。

    docker compose exec api python -m app.scripts.seed_grooming_labels --project 3           # 先看会加什么
    docker compose exec api python -m app.scripts.seed_grooming_labels --project 3 --apply   # 真写

label_service 现在会把姿态像舔/啃的片段当候选送上来，label_name 是「舔身体」。
标注员点「确认是舔身体」时平台要在项目里按 display_name / code 找到这个标签，
找不到就报 422「项目里没有「舔身体」标签」。这个脚本就是把它（以及后面区分部位
要用的一组子标签）一次加齐，省得去标签管理页一条条敲。

平常更方便的是标签管理页 → 套用模板 → 「抓/舔/啃/蹭」（服务启动时自动建好）；
这个脚本多做的一件事是把部位子标签挂到父标签下（parent_id），模板套用做不到这点。

加的东西：

    舔身体          ← 候选默认落在这个上面
    啃身体
    抓挠            ← 项目里一般已经有，有就用现成的
    蹭身体
    舔身体-前爪 -前左爪 -前右爪 -后爪 -后左爪 -后右爪 -躯干侧腹 -生殖区肛周
    啃身体-前爪 -前左爪 -前右爪 -后爪 -后左爪 -后右爪 -躯干侧腹 -生殖区肛周
    抓挠-头颈耳     抓挠-躯干侧腹     抓挠-胸腹         抓挠-后肢臀尾
    蹭身体-头脸口鼻 蹭身体-背部翻滚   蹭身体-躯干侧腹   蹭身体-臀尾肛周

带部位的挂在对应父标签下（parent_id）。确认候选时下拉「改成别的」就能直接选到
具体部位；不想分那么细就 --no-parts 只加父标签。

可以反复跑：display_name 或 code 已经有了的跳过；之前停用掉的会重新启用。
默认只打印计划，加 --apply 才写库。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.user import User
from app.services.grooming_labels import GROUPS, Row, pick_admin, wanted_rows  # noqa: F401


@dataclass
class Action:
    kind: str          # "create" | "keep" | "reactivate"
    row: Row
    existing_id: int | None = None
    existing_name: str | None = None


async def plan(db, project_id: int, with_parts: bool = True) -> list[Action]:
    """对照项目里已有的标签，算出每条要做什么。不写库。"""
    have = (await db.execute(
        select(LabelDefinition).where(LabelDefinition.project_id == project_id)
    )).scalars().all()
    by_name = {l.display_name: l for l in have}
    by_code = {l.code: l for l in have}

    actions: list[Action] = []
    for row in wanted_rows(with_parts):
        # 同名优先：候选确认是按 display_name 找的，名字对上就算有，
        # 哪怕 code 是人手敲的别的写法
        hit = by_name.get(row.display_name) or by_code.get(row.code)
        if hit is None:
            actions.append(Action("create", row))
        elif not hit.is_active:
            actions.append(Action("reactivate", row, hit.id, hit.display_name))
        else:
            actions.append(Action("keep", row, hit.id, hit.display_name))
    return actions


async def apply_plan(db, project_id: int, user_id: int, actions: list[Action]) -> dict[str, int]:
    """按计划写库。返回各类动作的条数。"""
    # code -> id，父标签建完就登记，子标签接着用。已有的父也要登记进来。
    id_by_code: dict[str, int] = {}
    counts = {"create": 0, "keep": 0, "reactivate": 0}
    for a in actions:
        if a.kind == "create":
            parent_id = id_by_code.get(a.row.parent_code) if a.row.parent_code else None
            label = LabelDefinition(
                project_id=project_id, code=a.row.code, display_name=a.row.display_name,
                color=a.row.color, sort_order=a.row.sort_order, parent_id=parent_id,
                created_by=user_id,
            )
            db.add(label)
            await db.flush()
            id_by_code[a.row.code] = label.id
        else:
            if a.kind == "reactivate":
                label = await db.get(LabelDefinition, a.existing_id)
                label.is_active = True
            id_by_code[a.row.code] = a.existing_id
        counts[a.kind] += 1
    await db.commit()
    return counts


async def pick_user(db, user_id: int | None) -> User | None:
    """created_by 用谁：指定了就用指定的，否则挑一个在职的 super_admin / admin。"""
    if user_id is not None:
        return await db.get(User, user_id)
    return await pick_admin(db)


def describe(actions: list[Action]) -> str:
    verb = {"create": "新增", "keep": "已有，跳过", "reactivate": "已停用，重新启用"}
    lines = []
    for a in actions:
        extra = ""
        if a.kind != "create" and a.existing_name and a.existing_name != a.row.display_name:
            extra = f"（项目里叫「{a.existing_name}」，code 相同）"
        indent = "    " if a.row.parent_code else "  "
        lines.append(f"{indent}{verb[a.kind]:<10} {a.row.display_name}  [{a.row.code}]{extra}")
    return "\n".join(lines)


async def run(project_id: int, apply: bool, with_parts: bool, user_id: int | None) -> int:
    async with SessionLocal() as db:
        project = await db.get(Project, project_id)
        if project is None:
            print(f"项目 {project_id} 不存在", file=sys.stderr)
            return 2
        actions = await plan(db, project_id, with_parts)
        print(f"项目 {project_id}「{project.name}」：")
        print(describe(actions))
        todo = [a for a in actions if a.kind != "keep"]
        if not todo:
            print("\n都齐了，不用动。")
            return 0
        if not apply:
            print(f"\n以上 {len(todo)} 条要改。这是预览，加 --apply 才写库。")
            return 0
        user = await pick_user(db, user_id)
        if user is None:
            print("找不到管理员账号来当 created_by，用 --user <用户id> 指定一个", file=sys.stderr)
            return 3
        counts = await apply_plan(db, project_id, user.id, actions)
        print(f"\n完成：新增 {counts['create']}，重新启用 {counts['reactivate']}，"
              f"已有 {counts['keep']}（created_by={user.username}）")
        return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project", type=int, required=True, help="项目 id")
    ap.add_argument("--apply", action="store_true", help="真写库；不加只预览")
    ap.add_argument("--no-parts", action="store_true", help="只加父标签，不加部位子标签")
    ap.add_argument("--user", type=int, default=None, help="created_by 用哪个用户 id；默认挑一个管理员")
    args = ap.parse_args(argv)
    return asyncio.run(run(args.project, args.apply, not args.no_parts, args.user))


if __name__ == "__main__":
    sys.exit(main())
