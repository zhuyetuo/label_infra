"""内置「抓/舔/啃/蹭」标签模板：启动时自动建，套用后候选能确认，改过不被覆盖。"""

from __future__ import annotations

from sqlalchemy import select

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.project import Project
from app.models.user import User, UserRole
from app.services.grooming_labels import (
    GROUPS, OLD_TEMPLATE_NAMES, TEMPLATE_DESC, TEMPLATE_NAME, _OLD_GROUP_COLORS,
    ensure_grooming_template, template_rows,
)


def _admin(db, run, active=True):
    u = User(username="adm", password_hash="x", display_name="a", role=UserRole.admin, is_active=active)
    db.add(u)
    run(db.commit())
    return u


def _tpl(db, run):
    return run(db.execute(select(LabelTemplate).where(LabelTemplate.name == TEMPLATE_NAME))).scalar_one_or_none()


def _items(db, run, tid):
    return run(db.execute(select(LabelTemplateItem).where(LabelTemplateItem.template_id == tid)
                          .order_by(LabelTemplateItem.sort_order))).scalars().all()


def test_created_once_with_all_items(db, run):
    admin = _admin(db, run)
    assert run(ensure_grooming_template(db)) == "created"
    tpl = _tpl(db, run)
    assert tpl is not None and tpl.created_by == admin.id and tpl.description
    items = _items(db, run, tpl.id)
    names = [i.display_name for i in items]
    assert names[0] == "舔身体" and names[5] == "啃身体"   # 父在前，四个部位跟在后面
    assert {(i.code, i.display_name, i.color, i.sort_order) for i in items} == \
        {(r.code, r.display_name, r.color, r.sort_order) for r in template_rows()}
    assert len(items) == 19
    # 「抓挠」本身不进模板（项目里已有，带进去会变成两个），只带部位
    assert "抓挠" not in names and "抓挠-头颈耳" in names and "蹭身体" in names
    assert "scratch" not in {i.code for i in items}

    assert run(ensure_grooming_template(db)) == "exists"
    assert run(db.execute(select(LabelTemplate))).scalars().all().__len__() == 1
    assert len(_items(db, run, tpl.id)) == 19


def test_admin_edits_survive_restart(db, run):
    _admin(db, run)
    run(ensure_grooming_template(db))
    tpl = _tpl(db, run)
    items = _items(db, run, tpl.id)
    # 每组只留一条，改一个颜色
    keep = {"lick_body", "chew_body_fore", "scratch_head", "rub_body"}
    for i in items:
        if i.code not in keep:
            db._s.delete(i)
    items[0].color = "#123456"
    run(db.commit())
    assert run(ensure_grooming_template(db)) == "exists"
    left = _items(db, run, tpl.id)
    assert {i.code for i in left} == keep and left[0].color == "#123456"


def test_missing_whole_group_is_topped_up_on_restart(db, run):
    """老版本模板只有舔/啃两组：重启后补上抓挠部位和蹭两组，原有的不动。"""
    _admin(db, run)
    run(ensure_grooming_template(db))
    tpl = _tpl(db, run)
    for i in _items(db, run, tpl.id):
        if i.code.startswith(("scratch", "rub_body")):
            db._s.delete(i)
    lick = next(i for i in _items(db, run, tpl.id) if i.code == "lick_body")
    lick.display_name = "舔"
    run(db.commit())
    assert len(_items(db, run, tpl.id)) == 10

    assert run(ensure_grooming_template(db)) == "updated"
    items = _items(db, run, tpl.id)
    assert len(items) == 19
    assert next(i for i in items if i.code == "lick_body").display_name == "舔"
    assert run(ensure_grooming_template(db)) == "exists"


def test_no_admin_means_nothing_written_and_retry_later(db, run):
    assert run(ensure_grooming_template(db)) == "no_admin"
    assert _tpl(db, run) is None
    _admin(db, run, active=False)
    assert run(ensure_grooming_template(db)) == "no_admin"
    assert _tpl(db, run) is None
    db.add(User(username="s", password_hash="x", display_name="s", role=UserRole.super_admin))
    run(db.commit())
    assert run(ensure_grooming_template(db)) == "created"


def test_applying_template_makes_candidate_lookup_work(db, run):
    """走 apply_template 同样的拷贝逻辑之后，候选按「舔身体」能找到标签。"""
    admin = _admin(db, run)
    run(ensure_grooming_template(db))
    tpl = _tpl(db, run)
    p = Project(name="p", created_by=admin.id)
    db.add(p)
    run(db.commit())
    for i in _items(db, run, tpl.id):
        db.add(LabelDefinition(project_id=p.id, code=i.code, display_name=i.display_name, color=i.color,
                               sort_order=i.sort_order, template_item_id=i.id, created_by=admin.id))
    run(db.commit())
    hit = run(db.execute(select(LabelDefinition.id).where(
        LabelDefinition.project_id == p.id,
        (LabelDefinition.display_name == "舔身体") | (LabelDefinition.code == "舔身体"),
    ).limit(1))).scalar_one_or_none()
    assert hit is not None


def test_startup_hook_is_registered_and_swallows_db_errors(monkeypatch):
    import app.main as m

    assert m.app.router.lifespan_context is not None   # 挂上了 lifespan

    class Boom:
        async def __aenter__(self):
            raise RuntimeError("db down")

        async def __aexit__(self, *a):
            return False

    import app.db.session as sess
    monkeypatch.setattr(sess, "SessionLocal", lambda: Boom())
    import asyncio
    asyncio.run(m._seed_builtin_templates())   # 不能抛


def test_lifespan_really_seeds_the_template(db, run, monkeypatch):
    """跑真正的 lifespan：起服务这一步过后模板就在库里。"""
    import app.db.session as sess
    import app.main as m

    _admin(db, run)

    class Ctx:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(sess, "SessionLocal", lambda: Ctx())

    async def boot():
        async with m.app.router.lifespan_context(m.app):
            pass

    run(boot())
    assert _tpl(db, run) is not None
    assert len(_items(db, run, _tpl(db, run).id)) == 19


def _hue(hex_):
    import colorsys
    r, g, b = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return colorsys.rgb_to_hls(r, g, b)[0]


def test_colors_same_hue_within_group_distinct_everywhere():
    rows = template_rows() + [r for r in GROUPS_PARENTS()]
    colors = [r.color for r in rows]
    assert len(set(c.upper() for c in colors)) == len(colors)   # 全部不重样
    for code, _n, pcolor, _t, parts in GROUPS:
        hues = [_hue(pcolor)] + [_hue(c) for _c, _n2, c in parts]
        assert max(hues) - min(hues) < 0.02, code                 # 组内同色相
    parents = [g[2] for g in GROUPS]
    assert len({round(_hue(c), 1) for c in parents}) == 4       # 组间色相分开


def GROUPS_PARENTS():
    from app.services.grooming_labels import Row
    return [Row(g[0], g[1], g[2], 0) for g in GROUPS if not g[3]]


def test_old_name_is_renamed_not_duplicated(db, run):
    admin = _admin(db, run)
    old = LabelTemplate(name=OLD_TEMPLATE_NAMES[0], description="老的", created_by=admin.id)
    db.add(old)
    run(db.flush())
    db.add(LabelTemplateItem(template_id=old.id, code="lick_body", display_name="舔身体", color="#FF8C42", sort_order=100))
    run(db.commit())

    assert run(ensure_grooming_template(db)) == "updated"
    all_tpl = run(db.execute(select(LabelTemplate))).scalars().all()
    assert len(all_tpl) == 1 and all_tpl[0].id == old.id
    assert all_tpl[0].name == TEMPLATE_NAME and all_tpl[0].description == TEMPLATE_DESC
    codes = {i.code for i in _items(db, run, old.id)}
    assert "lick_body" in codes and "scratch_head" in codes and "rub_body" in codes
    assert "lick_body_fore" not in codes    # 舔那组还有一条在，不补


def test_recolor_only_untouched_old_colors_and_follows_to_projects(db, run):
    """上一版整组一个色：还是旧色的换新色并同步到跟着它的项目标签；管理员改过的不动。"""
    admin = _admin(db, run)
    tpl = LabelTemplate(name=TEMPLATE_NAME, created_by=admin.id)
    db.add(tpl)
    run(db.flush())
    for r in template_rows():
        grp = r.parent_code or r.code
        db.add(LabelTemplateItem(template_id=tpl.id, code=r.code, display_name=r.display_name,
                                 color=_OLD_GROUP_COLORS[grp], sort_order=r.sort_order))
    run(db.flush())
    items = {i.code: i for i in _items(db, run, tpl.id)}
    items["chew_body_hind"].color = "#000000"        # 管理员自己改过
    p = Project(name="p", created_by=admin.id)
    db.add(p)
    run(db.flush())
    follow = LabelDefinition(project_id=p.id, code="lick_body_fore", display_name="舔身体-前肢爪",
                             color="#FF8C42", template_item_id=items["lick_body_fore"].id, created_by=admin.id)
    detached = LabelDefinition(project_id=p.id, code="lick_body_hind", display_name="舔身体-后肢臀尾",
                               color="#FF8C42", template_item_id=None, created_by=admin.id)
    db.add(follow)
    db.add(detached)
    run(db.commit())

    assert run(ensure_grooming_template(db)) == "updated"
    want = {r.code: r.color for r in template_rows()}
    got = {i.code: i.color for i in _items(db, run, tpl.id)}
    assert got["lick_body_fore"] == want["lick_body_fore"] == "#8F3800"
    assert got["lick_body"] == want["lick_body"] == "#FF8C42"     # 父标签本色没变
    assert got["chew_body_hind"] == "#000000"
    assert got["scratch_head"] == want["scratch_head"]
    run(db.refresh(follow))
    run(db.refresh(detached))
    assert follow.color == "#8F3800"
    assert detached.color == "#FF8C42"

    assert run(ensure_grooming_template(db)) == "exists"
