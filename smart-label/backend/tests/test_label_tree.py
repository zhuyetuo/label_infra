"""层级标签：模板带上级、套用时挂父子、老项目补上级、父子校验、导出带整条链、子孙展开。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import label_templates as tpl_api
from app.api.v1 import labels as label_api
from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.project import Project
from app.models.user import User, UserRole
from app.schemas.label import LabelCreate, LabelUpdate
from app.schemas.label_template import LabelTemplateCreate, LabelTemplateItemIn, LabelTemplateUpdate
from app.services import label_tree


def _admin(db, run):
    u = User(username="adm", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.commit())
    return u


def _project(db, run, admin, name="p"):
    p = Project(name=name, created_by=admin.id)
    db.add(p)
    run(db.commit())
    return p


def _labels(db, run, pid):
    return {l.code: l for l in run(db.execute(select(LabelDefinition).where(LabelDefinition.project_id == pid))).scalars().all()}


def _items(name, *rows):
    return [LabelTemplateItemIn(code=c, display_name=n, parent_code=p, sort_order=i) for i, (c, n, p) in enumerate(rows)]


def test_模板带上级_校验不在里面和绕圈(db, run):
    admin = _admin(db, run)
    body = LabelTemplateCreate(name="t", items=_items("t", ("lick", "舔", None), ("fore", "舔-前爪", "lick"), ("fore_l", "舔-前左爪", "fore")))
    out = run(tpl_api.create_template(body, db=db, admin=admin))["data"]
    assert {i["code"]: i["parent_code"] for i in out["items"]} == {"lick": None, "fore": "lick", "fore_l": "fore"}
    # 上级不在模板里可以（套用时按项目里已有的 code 找，比如内置模板的「抓挠-部位」挂项目的「抓挠」）
    run(tpl_api.create_template(LabelTemplateCreate(name="t2", items=_items("t2", ("a", "a", "zz"))), db=db, admin=admin))
    with pytest.raises(HTTPException) as e:
        run(tpl_api.create_template(LabelTemplateCreate(name="t2b", items=_items("t2b", ("a", "a", "a"))), db=db, admin=admin))
    assert e.value.status_code == 400 and "自己" in e.value.detail
    with pytest.raises(HTTPException) as e:
        run(tpl_api.create_template(LabelTemplateCreate(name="t3", items=_items("t3", ("a", "a", "b"), ("b", "b", "a"))), db=db, admin=admin))
    assert e.value.status_code == 400 and "圈" in e.value.detail
    # 编辑时改上级也走同一套
    run(tpl_api.update_template(out["id"], LabelTemplateUpdate(items=_items("t", ("lick", "舔", None), ("fore", "舔-前爪", None), ("fore_l", "舔-前左爪", "fore"))), db=db))
    got = {i.code: i.parent_code for i in run(db.execute(select(LabelTemplateItem).where(LabelTemplateItem.template_id == out["id"]))).scalars().all()}
    assert got == {"lick": None, "fore": None, "fore_l": "fore"}


def test_套用模板挂父子_子在前也行_已有的补上级(db, run):
    admin = _admin(db, run)
    p = _project(db, run, admin)
    # 项目里本来就有「抓挠」（手工建的 code）和一条没挂上级的「舔-前爪」
    db.add(LabelDefinition(project_id=p.id, code="zhua", display_name="抓挠", created_by=admin.id))
    db.add(LabelDefinition(project_id=p.id, code="lick_fore", display_name="舔-前爪", created_by=admin.id))
    run(db.commit())
    # 模板里故意把子放在父前面
    body = LabelTemplateCreate(name="t", items=_items(
        "t", ("lick_fore_l", "舔-前左爪", "lick_fore"), ("lick_fore", "舔-前爪", "lick"), ("lick", "舔", None),
        ("scratch_head", "抓挠-头颈耳", "zhua")))
    tid = run(tpl_api.create_template(body, db=db, admin=admin))["data"]["id"]
    r = run(tpl_api.apply_template(tid, p.id, db=db, admin=admin))["data"]
    assert r["created"] == 3 and r["skipped"] == 1 and r["skipped_codes"] == ["lick_fore"] and r["linked"] == 1
    ls = _labels(db, run, p.id)
    assert ls["lick"].parent_id is None
    assert ls["lick_fore"].parent_id == ls["lick"].id          # 本来就有的这条补上了上级
    assert ls["lick_fore_l"].parent_id == ls["lick_fore"].id
    assert ls["scratch_head"].parent_id == ls["zhua"].id       # 挂到项目里已有的「抓挠」
    # 再套一次：全跳过，不重复挂
    r = run(tpl_api.apply_template(tid, p.id, db=db, admin=admin))["data"]
    assert r["created"] == 0 and r["linked"] == 0
    # 存为模板：父子关系存成 parent_code
    from app.schemas.label_template import SaveAsTemplateRequest
    out = run(tpl_api.save_project_labels_as_template(SaveAsTemplateRequest(project_id=p.id, name="saved"), db=db, admin=admin))["data"]
    assert {i["code"]: i["parent_code"] for i in out["items"]} == {
        "zhua": None, "lick": None, "lick_fore": "lick", "lick_fore_l": "lick_fore", "scratch_head": "zhua"}


def test_老项目按模板补上级_启动时跑(db, run):
    admin = _admin(db, run)
    p = _project(db, run, admin)
    tpl = LabelTemplate(name="t", created_by=admin.id)
    db.add(tpl)
    run(db.flush())
    a = LabelTemplateItem(template_id=tpl.id, code="lick", display_name="舔", sort_order=0)
    b = LabelTemplateItem(template_id=tpl.id, code="lick_fore", display_name="舔-前爪", sort_order=1, parent_code="lick")
    db.add(a)
    db.add(b)
    run(db.flush())
    db.add(LabelDefinition(project_id=p.id, code="lick", display_name="舔", template_item_id=a.id, created_by=admin.id))
    db.add(LabelDefinition(project_id=p.id, code="lick_fore", display_name="舔-前爪", template_item_id=b.id, created_by=admin.id))
    run(db.commit())
    assert run(label_tree.link_from_templates(db)) == 1
    run(db.commit())
    ls = _labels(db, run, p.id)
    assert ls["lick_fore"].parent_id == ls["lick"].id
    assert run(label_tree.link_from_templates(db)) == 0


def test_标签接口_parent_id校验_删父标签子标签上提(db, run):
    admin = _admin(db, run)
    p = _project(db, run, admin)
    q = _project(db, run, admin, "q")
    lick = run(label_api.create_label(LabelCreate(project_id=p.id, code="lick", display_name="舔"), db=db, admin=admin))["data"]
    fore = run(label_api.create_label(LabelCreate(project_id=p.id, code="fore", display_name="舔-前爪", parent_id=lick["id"]), db=db, admin=admin))["data"]
    assert fore["parent_id"] == lick["id"]
    other = run(label_api.create_label(LabelCreate(project_id=q.id, code="x", display_name="x"), db=db, admin=admin))["data"]
    with pytest.raises(HTTPException) as e:      # 别的项目的
        run(label_api.create_label(LabelCreate(project_id=p.id, code="y", display_name="y", parent_id=other["id"]), db=db, admin=admin))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:      # 自己
        run(label_api.update_label(lick["id"], LabelUpdate(parent_id=lick["id"]), db=db))
    assert "自己" in e.value.detail
    with pytest.raises(HTTPException) as e:      # 绕圈
        run(label_api.update_label(lick["id"], LabelUpdate(parent_id=fore["id"]), db=db))
    assert "圈" in e.value.detail
    # 太深
    prev = fore["id"]
    for i in range(label_tree.MAX_DEPTH - 2):
        prev = run(label_api.create_label(LabelCreate(project_id=p.id, code=f"d{i}", display_name=f"d{i}", parent_id=prev), db=db, admin=admin))["data"]["id"]
    with pytest.raises(HTTPException) as e:
        run(label_api.create_label(LabelCreate(project_id=p.id, code="deep", display_name="deep", parent_id=prev), db=db, admin=admin))
    assert "层" in e.value.detail
    # 摘掉上级
    out = run(label_api.update_label(fore["id"], LabelUpdate(parent_id=None), db=db))["data"]
    assert out["parent_id"] is None
    run(label_api.update_label(fore["id"], LabelUpdate(parent_id=lick["id"]), db=db))
    # 删父：子上提到爷（这里是没有上级）
    run(label_api.delete_label(lick["id"], db=db))
    assert run(db.get(LabelDefinition, fore["id"])).parent_id is None


def test_子孙展开和祖先链(db, run):
    admin = _admin(db, run)
    p = _project(db, run, admin)
    lick = LabelDefinition(project_id=p.id, code="lick", display_name="舔", created_by=admin.id)
    db.add(lick)
    run(db.flush())
    fore = LabelDefinition(project_id=p.id, code="fore", display_name="舔-前爪", parent_id=lick.id, created_by=admin.id)
    db.add(fore)
    run(db.flush())
    fl = LabelDefinition(project_id=p.id, code="fl", display_name="舔-前左爪", parent_id=fore.id, created_by=admin.id)
    other = LabelDefinition(project_id=p.id, code="o", display_name="活动", created_by=admin.id)
    db.add(fl)
    db.add(other)
    run(db.commit())
    assert run(label_tree.expand_ids(db, {lick.id})) == {lick.id, fore.id, fl.id}
    assert run(label_tree.expand_ids(db, {fore.id})) == {fore.id, fl.id}
    assert run(label_tree.expand_ids(db, set())) == set()
    by_id = {l.id: l for l in (lick, fore, fl, other)}
    assert label_tree.ancestors_chain(by_id, fl.id) == [lick.id, fore.id, fl.id]
    assert label_tree.ancestors_chain(by_id, other.id) == [other.id]
