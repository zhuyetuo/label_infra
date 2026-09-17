"""内置「舔/啃（IMU 候选）」标签模板：启动时自动建，套用后候选能确认，改过不被覆盖。"""

from __future__ import annotations

from sqlalchemy import select

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.project import Project
from app.models.user import User, UserRole
from app.services.grooming_labels import TEMPLATE_NAME, ensure_grooming_template, wanted_rows


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
        {(r.code, r.display_name, r.color, r.sort_order) for r in wanted_rows()}
    assert len(items) == 10

    assert run(ensure_grooming_template(db)) == "exists"
    assert run(db.execute(select(LabelTemplate))).scalars().all().__len__() == 1
    assert len(_items(db, run, tpl.id)) == 10


def test_admin_edits_survive_restart(db, run):
    _admin(db, run)
    run(ensure_grooming_template(db))
    tpl = _tpl(db, run)
    items = _items(db, run, tpl.id)
    for i in items[2:]:
        db._s.delete(i)
    items[0].color = "#123456"
    run(db.commit())
    assert run(ensure_grooming_template(db)) == "exists"
    left = _items(db, run, tpl.id)
    assert len(left) == 2 and left[0].color == "#123456"


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
    assert len(_items(db, run, _tpl(db, run).id)) == 10
