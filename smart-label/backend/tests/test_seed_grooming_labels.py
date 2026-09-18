"""seed_grooming_labels：一键给项目补「舔身体/啃身体」那组标签。

要守住的：跑完候选按「舔身体」能找到标签；反复跑不重复；人手敲过的同名标签
不动；停用的重新启用；子标签挂对父；预览模式一个字不写。
"""

from __future__ import annotations

from sqlalchemy import select

from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.user import User, UserRole
from app.services.grooming_labels import walk_parts
from app.scripts.seed_grooming_labels import (
    GROUPS, apply_plan, describe, pick_user, plan, wanted_rows,
)


def _seed_users_project(db, run):
    admin = User(username="adm", password_hash="x", display_name="管理员", role=UserRole.admin)
    worker = User(username="w", password_hash="x", display_name="标注员", role=UserRole.annotator)
    db.add(admin)
    db.add(worker)
    run(db.flush())
    p = Project(name="p1", created_by=admin.id)
    db.add(p)
    run(db.commit())
    return admin, worker, p


def _labels(db, run, pid):
    return run(db.execute(
        select(LabelDefinition).where(LabelDefinition.project_id == pid).order_by(LabelDefinition.sort_order)
    )).scalars().all()


def test_wanted_rows_parents_before_children_and_no_dupes():
    rows = wanted_rows()
    assert [r.display_name for r in rows[:4]] == ["舔", "啃", "抓挠", "蹭"]
    assert len(rows) == sum(1 + len(list(walk_parts(g[4], g[0], g[1]))) for g in GROUPS) == 28
    assert len({r.code for r in rows}) == len(rows)
    assert len({r.display_name for r in rows}) == len(rows)
    seen = set()
    for r in rows:
        assert r.parent_code is None or r.parent_code in seen
        seen.add(r.code)
    # 库里 code / display_name 都是 String(50)
    assert all(len(r.code) <= 50 and len(r.display_name) <= 50 for r in rows)
    assert all(r.parent_code is None for r in wanted_rows(with_parts=False))
    assert len(wanted_rows(with_parts=False)) == 4


def test_fresh_project_gets_everything_and_candidate_lookup_works(db, run):
    admin, _, p = _seed_users_project(db, run)
    actions = run(plan(db, p.id))
    assert all(a.kind == "create" for a in actions)
    counts = run(apply_plan(db, p.id, admin.id, actions))
    assert counts == {"create": 28, "keep": 0, "reactivate": 0}

    labels = _labels(db, run, p.id)
    assert len(labels) == 28
    # 候选确认走的就是这条查询：display_name == label_name
    hit = run(db.execute(select(LabelDefinition.id).where(
        LabelDefinition.project_id == p.id,
        (LabelDefinition.display_name == "舔") | (LabelDefinition.code == "舔"),
    ).limit(1))).scalar_one_or_none()
    assert hit is not None
    by_name = {l.display_name: l for l in labels}
    assert by_name["舔-前爪"].parent_id == by_name["舔"].id
    assert by_name["啃-生殖区肛周"].parent_id == by_name["啃"].id
    assert by_name["舔"].parent_id is None
    assert all(l.created_by == admin.id for l in labels)
    assert all(l.is_active for l in labels)
    assert all(l.color for l in labels)
    # 排序：父、它的子、下一个父、它的子
    assert [l.display_name for l in labels][:3] == ["舔", "舔-前爪", "舔-前左爪"]


def test_second_run_changes_nothing(db, run):
    admin, _, p = _seed_users_project(db, run)
    run(apply_plan(db, p.id, admin.id, run(plan(db, p.id))))
    ids = sorted(l.id for l in _labels(db, run, p.id))
    actions = run(plan(db, p.id))
    assert all(a.kind == "keep" for a in actions)
    counts = run(apply_plan(db, p.id, admin.id, actions))
    assert counts["create"] == 0 and counts["keep"] == 28
    assert sorted(l.id for l in _labels(db, run, p.id)) == ids


def test_hand_made_label_with_other_code_is_kept_and_used_as_parent(db, run):
    """标签管理页里人先加过「舔身体」（code 随手写的）：不重复加，子标签挂到它下面。"""
    admin, _, p = _seed_users_project(db, run)
    mine = LabelDefinition(project_id=p.id, code="tian", display_name="舔", color="#000",
                           sort_order=3, created_by=admin.id)
    db.add(mine)
    run(db.commit())
    actions = run(plan(db, p.id))
    kinds = {a.row.display_name: a.kind for a in actions}
    assert kinds["舔"] == "keep"
    assert kinds["啃"] == "create"
    run(apply_plan(db, p.id, admin.id, actions))
    labels = _labels(db, run, p.id)
    assert len(labels) == 28
    by_name = {l.display_name: l for l in labels}
    assert by_name["舔"].id == mine.id
    assert by_name["舔"].code == "tian" and by_name["舔"].color == "#000"
    assert by_name["舔-躯干侧腹"].parent_id == mine.id
    assert "code 相同" not in describe(actions)


def test_same_code_different_name_counts_as_present(db, run):
    """code 撞上了但名字不同：不能再插（唯一约束会炸），当作已有并在预览里说明。"""
    admin, _, p = _seed_users_project(db, run)
    db.add(LabelDefinition(project_id=p.id, code="chew_body", display_name="啃咬身体", created_by=admin.id))
    run(db.commit())
    actions = run(plan(db, p.id))
    a = next(x for x in actions if x.row.code == "chew_body")
    assert a.kind == "keep" and a.existing_name == "啃咬身体"
    assert "「啃咬身体」" in describe(actions)
    run(apply_plan(db, p.id, admin.id, actions))
    assert len(_labels(db, run, p.id)) == 28


def test_inactive_label_is_reactivated(db, run):
    admin, _, p = _seed_users_project(db, run)
    run(apply_plan(db, p.id, admin.id, run(plan(db, p.id))))
    lick = next(l for l in _labels(db, run, p.id) if l.display_name == "舔")
    lick.is_active = False
    run(db.commit())
    actions = run(plan(db, p.id))
    assert {a.kind for a in actions} == {"keep", "reactivate"}
    assert sum(a.kind == "reactivate" for a in actions) == 1
    run(apply_plan(db, p.id, admin.id, actions))
    assert all(l.is_active for l in _labels(db, run, p.id))
    assert len(_labels(db, run, p.id)) == 28


def test_no_parts_only_parents(db, run):
    admin, _, p = _seed_users_project(db, run)
    actions = run(plan(db, p.id, with_parts=False))
    run(apply_plan(db, p.id, admin.id, actions))
    assert sorted(l.display_name for l in _labels(db, run, p.id)) == ["啃", "抓挠", "舔", "蹭"]


def test_plan_alone_writes_nothing(db, run):
    _, _, p = _seed_users_project(db, run)
    run(plan(db, p.id))
    run(db.commit())
    assert _labels(db, run, p.id) == []


def test_other_project_untouched(db, run):
    admin, _, p = _seed_users_project(db, run)
    p2 = Project(name="p2", created_by=admin.id)
    db.add(p2)
    run(db.commit())
    run(apply_plan(db, p.id, admin.id, run(plan(db, p.id))))
    assert _labels(db, run, p2.id) == []
    assert all(a.kind == "create" for a in run(plan(db, p2.id)))


def test_pick_user_prefers_admin_and_honors_explicit(db, run):
    admin, worker, _ = _seed_users_project(db, run)
    assert run(pick_user(db, None)).id == admin.id
    assert run(pick_user(db, worker.id)).id == worker.id
    admin.is_active = False
    run(db.commit())
    assert run(pick_user(db, None)) is None
    assert run(pick_user(db, 9999)) is None


def test_describe_lists_every_row(db, run):
    _, _, p = _seed_users_project(db, run)
    text = describe(run(plan(db, p.id)))
    assert text.count("新增") == 28
    assert "舔  [lick_body]" in text


def _fake_session_local(db):
    """没有 aiosqlite，把 SessionLocal 换成给 sqlite 外壳的 async with。"""
    class _Ctx:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *a):
            return False

    return lambda: _Ctx()


def test_cli_preview_then_apply(db, run, monkeypatch, capsys):
    import app.scripts.seed_grooming_labels as mod

    admin, _, p = _seed_users_project(db, run)
    monkeypatch.setattr(mod, "SessionLocal", _fake_session_local(db))

    assert mod.main(["--project", str(p.id)]) == 0
    out = capsys.readouterr().out
    assert "预览" in out and "28 条要改" in out
    assert _labels(db, run, p.id) == []          # 预览不写

    assert mod.main(["--project", str(p.id), "--apply"]) == 0
    out = capsys.readouterr().out
    assert "新增 28" in out and "created_by=adm" in out
    assert len(_labels(db, run, p.id)) == 28

    assert mod.main(["--project", str(p.id), "--apply"]) == 0
    assert "都齐了" in capsys.readouterr().out

    assert mod.main(["--project", "999"]) == 2
    assert "不存在" in capsys.readouterr().err


def test_cli_no_admin_refuses_without_user(db, run, monkeypatch, capsys):
    import app.scripts.seed_grooming_labels as mod

    admin, worker, p = _seed_users_project(db, run)
    admin.is_active = False
    run(db.commit())
    monkeypatch.setattr(mod, "SessionLocal", _fake_session_local(db))
    assert mod.main(["--project", str(p.id), "--apply"]) == 3
    assert "--user" in capsys.readouterr().err
    assert _labels(db, run, p.id) == []
    assert mod.main(["--project", str(p.id), "--apply", "--user", str(worker.id), "--no-parts"]) == 0
    got = _labels(db, run, p.id)
    assert len(got) == 4 and all(l.created_by == worker.id for l in got)


def test_existing_scratch_label_is_reused_as_parent(db, run):
    """项目里早就有「抓挠」（code 是老的）：不再加一个，抓挠-部位挂到它下面。"""
    admin, _, p = _seed_users_project(db, run)
    old = LabelDefinition(project_id=p.id, code="scratching", display_name="抓挠", color="#f00",
                          sort_order=1, created_by=admin.id)
    db.add(old)
    run(db.commit())
    actions = run(plan(db, p.id))
    assert {a.row.display_name: a.kind for a in actions}["抓挠"] == "keep"
    run(apply_plan(db, p.id, admin.id, actions))
    labels = _labels(db, run, p.id)
    assert sum(l.display_name == "抓挠" for l in labels) == 1
    by_name = {l.display_name: l for l in labels}
    assert by_name["抓挠-头颈耳"].parent_id == old.id
    assert by_name["蹭-臀尾肛周"].parent_id == by_name["蹭"].id
