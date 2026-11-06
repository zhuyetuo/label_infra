"""项目没标签时自动克隆一套：同源项目优先，其次最近有标签的项目。"""

from sqlalchemy import select

from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.user import User, UserRole
from app.services.label_fallback import base_name, ensure_project_labels


def test_base_name():
    assert base_name("2026-11-05 · #29 · 3轴 · 调试版") == "2026-11-05"
    assert base_name("2026-11-05-2") == "2026-11-05"
    assert base_name("2026-11-05 · #29 · 调试版 (3)") == "2026-11-05"
    assert base_name("2026-11-05") == "2026-11-05"


def test_ensure_labels(db, run):
    async def go():
        u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
        db.add(u)
        await db.flush()
        src = Project(name="2026-11-05", created_by=u.id)
        other = Project(name="别的项目", created_by=u.id)
        db.add(src)
        db.add(other)
        await db.flush()
        parent = LabelDefinition(project_id=src.id, code="scratch", display_name="抓挠", created_by=u.id)
        db.add(parent)
        await db.flush()
        db.add(LabelDefinition(project_id=src.id, code="scratch_head", display_name="抓挠-头颈耳", parent_id=parent.id, created_by=u.id))
        db.add(LabelDefinition(project_id=other.id, code="x", display_name="别的", created_by=u.id))
        derived = Project(name="2026-11-05-2", created_by=u.id)
        db.add(derived)
        await db.flush()
        got = await ensure_project_labels(db, derived)
        assert got == "2026-11-05"
        labs = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == derived.id))).scalars().all()
        names = {l.display_name for l in labs}
        assert names == {"抓挠", "抓挠-头颈耳"}
        child = next(l for l in labs if l.display_name == "抓挠-头颈耳")
        assert child.parent_id in {l.id for l in labs}
        # 已经有标签：什么都不做
        assert await ensure_project_labels(db, derived) is None
        # 没有同源：退回最近有标签的项目
        lone = Project(name="全新项目", created_by=u.id)
        db.add(lone)
        await db.flush()
        assert await ensure_project_labels(db, lone) is not None
    run(go())
