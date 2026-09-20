"""内置「犬行为全量（IMU 22 类）」模板：22 个顶层 code 对上表、四层以内、名字 code 不重、带轨；
启动时建一次、改过不覆盖；套到已有老「抓/舔/啃/蹭」标签的项目上直接复用并补轨。"""

from __future__ import annotations

from sqlalchemy import select

from app.models.label import LabelDefinition
from app.models.label_template import LabelTemplate, LabelTemplateItem
from app.models.project import Project
from app.models.user import User, UserRole
from app.services import behavior_labels as bl
from app.services import label_template_service as tsvc
from app.services import label_tree
from app.services.grooming_labels import ensure_grooming_template
from app.services.grooming_labels import template_rows as grooming_rows

TABLE = ["CARE_SCRATCH", "ACT_SLEEP", "ACT_ACTIVITY", "LOOSE_COLLAR", "ACT_REST", "ACT_WALK", "ACT_RUN", "ING_EAT",
         "ING_DRINK", "CARE_HEADSHAKE", "POST_SIT", "POST_LIE", "POST_STAND", "TRANS_POSTURE", "ACT_JUMP",
         "CARE_LICK", "CARE_RUB", "ACT_CHEW", "ACT_SWIM", "ACT_STAIRS", "ACT_SNIFF", "ELIM_POSSIBLE"]
# 舔 / 蹭 / 啃 沿用老模板的 code（老项目已标的片段不用重标），表里的 CARE_LICK 这几个对应它们
OLD_CODE_OF = {"CARE_LICK": "lick_body", "CARE_RUB": "rub_body", "ACT_CHEW": "chew_body"}


def _admin(db, run):
    u = User(username="adm", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.commit())
    return u


def _tpl(db, run):
    return run(db.execute(select(LabelTemplate).where(LabelTemplate.name == bl.TEMPLATE_NAME))).scalar_one_or_none()


def _items(db, run, tid):
    return run(db.execute(select(LabelTemplateItem).where(LabelTemplateItem.template_id == tid)
                          .order_by(LabelTemplateItem.sort_order))).scalars().all()


def test_定义本身_22类都在_四层以内_不重名_都有轨():
    rows = bl.template_rows()
    by = {r.code: r for r in rows}
    for code in TABLE:
        assert OLD_CODE_OF.get(code, code) in by, code
    assert by["ACT_SLEEP"].parent_code == "ACT_REST" and by["ACT_WALK"].parent_code == "ACT_ACTIVITY"
    assert "CARE_SCRATCH_hind" not in by and by["CARE_SCRATCH_pending"].display_name == "抓挠-待判定（后躯附近）"
    assert len({r.code for r in rows}) == len(rows)
    assert len({r.display_name for r in rows}) == len(rows)
    assert all(r.track in ("behavior", "motion", "posture", "device") for r in rows)
    assert by["POST_LIE"].track == "posture" and by["ACT_SLEEP"].track == "motion" and by["LOOSE_COLLAR"].track == "device"
    # 未佩戴：设备轨、顶层、跟松动互斥（同轨）
    assert by["NOT_WORN"].track == "device" and by["NOT_WORN"].parent_code is None and by["NOT_WORN"].display_name == "未佩戴"

    def depth(code):
        d, cur = 0, code
        while cur is not None:
            d, cur = d + 1, by[cur].parent_code
        return d
    assert max(depth(c) for c in by) == label_tree.MAX_DEPTH
    assert depth("lick_body_fore_l") == 4 and by["lick_body_fore_l"].display_name == "舔-前左爪"
    # 老模板里的部位 code / 名字在新模板里原样有
    old = {r.code: r.display_name for r in grooming_rows()}
    for code in ("lick_body_fore", "lick_body_fore_l", "chew_body_hind_r", "scratch_head", "rub_body_face"):
        assert code in by or code.replace("scratch", "CARE_SCRATCH") in by, code
    assert by["lick_body_fore_l"].display_name == old["lick_body_fore_l"]
    # 每个根 60 个号够用、父在子前
    idx = {r.code: i for i, r in enumerate(rows)}
    assert all(r.parent_code is None or idx[r.parent_code] < idx[r.code] for r in rows)
    assert all(r.sort_order < bl.SORT_BASE + (i + 1) * bl.SORT_STRIDE for i, root in enumerate(bl.ROOTS)
               for r in rows if r.code == root[0] or r.code.startswith(root[0] + "_"))


def test_启动建一次_改过不覆盖_整根丢了补回来(db, run):
    assert run(bl.ensure_behavior_template(db)) == "no_admin"
    _admin(db, run)
    assert run(bl.ensure_behavior_template(db)) == "created"
    tpl = _tpl(db, run)
    items = _items(db, run, tpl.id)
    assert len(items) == len(bl.template_rows()) and items[0].code == "CARE_SCRATCH" and items[0].track == "behavior"
    assert run(bl.ensure_behavior_template(db)) == "exists"
    # 删掉舔的一半、改个名：不动
    for i in items:
        if i.code.startswith("lick_body_hind"):
            db._s.delete(i)
    items[0].display_name = "抓"
    run(db.commit())
    assert run(bl.ensure_behavior_template(db)) == "exists"
    assert _items(db, run, tpl.id)[0].display_name == "抓"
    # 整根删掉（含表里的子行为）：补回来
    for i in _items(db, run, tpl.id):
        if i.code in ("ACT_REST", "ACT_SLEEP"):
            db._s.delete(i)
    run(db.commit())
    assert run(bl.ensure_behavior_template(db)) == "updated"
    codes = {i.code for i in _items(db, run, tpl.id)}
    assert {"ACT_REST", "ACT_SLEEP"} <= codes and not any(c.startswith("lick_body_hind") for c in codes)


def test_套到已有老模板标签的项目_复用并补轨(db, run):
    admin = _admin(db, run)
    run(ensure_grooming_template(db))
    run(bl.ensure_behavior_template(db))
    p = Project(name="p", created_by=admin.id)
    db.add(p)
    run(db.commit())
    old_tid = run(tsvc.builtin_template_id(db, "抓/舔/啃/蹭"))
    old_items = _items(db, run, old_tid)
    r = run(tsvc.apply_to_project(db, old_items, p.id, admin.id))
    run(db.commit())
    n_old = r["created"]
    labels = {l.code: l for l in run(db.execute(select(LabelDefinition).where(LabelDefinition.project_id == p.id))).scalars().all()}
    assert labels["lick_body_fore_l"].track is None
    new_items = _items(db, run, _tpl(db, run).id)
    r2 = run(tsvc.apply_to_project(db, new_items, p.id, admin.id))
    run(db.commit())
    labels = {l.code: l for l in run(db.execute(select(LabelDefinition).where(LabelDefinition.project_id == p.id))).scalars().all()}
    # 跳过的按模板条目 code 报：「抓挠」「抓挠-头颈耳」按名字对上了项目里的 scratch / scratch_head
    assert {"lick_body_fore_l", "CARE_SCRATCH", "CARE_SCRATCH_head"} <= set(r2["skipped_codes"])
    assert "CARE_SCRATCH_head" not in labels and labels["scratch_head"].track == "behavior"
    assert labels["lick_body_fore_l"].track == "behavior"          # 老标签复用、补上轨
    assert labels["lick_body_fore_l"].parent_id == labels["lick_body_fore"].id   # 老的父子不动
    assert labels["POST_LIE"].track == "posture" and labels["ACT_SLEEP"].parent_id == labels["ACT_REST"].id
    assert labels["lick_body_forearm_l"].parent_id == labels["lick_body_forearm"].id
    assert "CARE_SCRATCH" not in labels                              # 「抓挠」按名字复用了项目里的 scratch
    assert labels["CARE_SCRATCH_pending"].parent_id == labels["scratch"].id
    assert len(labels) == n_old + r2["created"]
