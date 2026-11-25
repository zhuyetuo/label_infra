"""片段审核：按类别领一批、逐条通过 / 退回、直接改起止；工作台里改了自动回到待审。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1 import segment_review as api
from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import task_service


def _world(db, run, n_items=3):
    admin = User(username="boss", password_hash="x", display_name="管理员", role=UserRole.admin)
    rev = User(username="rev", password_hash="x", display_name="审核员", role=UserRole.reviewer)
    rev2 = User(username="rev2", password_hash="x", display_name="审核员2", role=UserRole.reviewer)
    ann = User(username="ann", password_hash="x", display_name="实习生", role=UserRole.annotator)
    for u in (admin, rev, rev2, ann):
        db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=admin.id)
    db.add(p)
    run(db.flush())
    parent = LabelDefinition(project_id=p.id, code="scratch", display_name="抓挠", created_by=admin.id)
    db.add(parent)
    run(db.flush())
    child = LabelDefinition(project_id=p.id, code="scratch_head", display_name="抓挠-头颈耳", parent_id=parent.id,
                            created_by=admin.id)
    other = LabelDefinition(project_id=p.id, code="act", display_name="活动", created_by=admin.id)
    db.add(child)
    db.add(other)
    s = Sample(sample_code="s1", video_cam1_path="a.mp4", imu_csv_path="a.csv", created_by=admin.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED,
             assigned_to=ann.id, created_by=admin.id)
    db.add(t)
    run(db.flush())
    rec = AnnotationRecord(task_id=t.id, round_no=t.round_no or 1, source_type=RecordSourceType.human_only)
    db.add(rec)
    run(db.flush())
    items = []
    for k in range(n_items):
        it = AnnotationLabelItem(annotation_record_id=rec.id, label_id=child.id, start_time_ms=k * 10000,
                                 end_time_ms=k * 10000 + 3000, source_type=LabelItemSource.human_added)
        db.add(it)
        items.append(it)
    # 没人看过的 AI 片段：默认不进审核
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=child.id, start_time_ms=90000,
                               end_time_ms=93000, source_type=LabelItemSource.ai_generated))
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=other.id, start_time_ms=50000,
                               end_time_ms=60000, source_type=LabelItemSource.human_added))
    run(db.commit())
    return SimpleNamespace(admin=admin, rev=rev, rev2=rev2, ann=ann, p=p, parent=parent, child=child, other=other,
                           t=t, rec=rec, items=items)


def _q(run, db, user, **kw):
    return run(api.queue(db=db, user=user, **{"label_id": None, "label_name": None, "seg_status": "pending", "source": "touched",
                                               "project_id": None, "mine": False, "limit": 300, **kw}))["data"]


def test_按大类筛含细类_只算人碰过的(db, run):
    w = _world(db, run)
    d = _q(run, db, w.rev, label_id=w.parent.id)
    assert len(d["items"]) == 3 and d["counts"]["pending"] == 3
    assert {i["label_name"] for i in d["items"]} == {"抓挠-头颈耳"}
    assert len(_q(run, db, w.rev, label_id=w.parent.id, source="all")["items"]) == 4


def test_领一批_别人看不到_通过和退回(db, run):
    w = _world(db, run)
    assert run(api.claim(api.ClaimIn(label_id=w.parent.id, n=2), db, w.rev))["data"]["claimed"] == 2
    assert len(_q(run, db, w.rev, mine=True)["items"]) == 2
    # 另一个审核员只看得到剩下那 1 条，也领不到那 2 条
    assert len(_q(run, db, w.rev2, label_id=w.parent.id)["items"]) == 1
    mine = [i["id"] for i in _q(run, db, w.rev, mine=True)["items"]]
    with pytest.raises(HTTPException) as e:
        run(api.decide(mine[0], api.DecideIn(decision="approved"), db, w.rev2))
    assert e.value.status_code == 409

    run(api.decide(mine[0], api.DecideIn(decision="approved"), db, w.rev))
    with pytest.raises(HTTPException):
        run(api.decide(mine[1], api.DecideIn(decision="returned"), db, w.rev))   # 退回要写原因
    run(api.decide(mine[1], api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    d = _q(run, db, w.rev, label_id=w.parent.id, seg_status="all")
    assert d["counts"] == {"pending": 1, "returned": 1, "approved": 1}
    assert _q(run, db, w.rev, mine=True)["items"] == []          # 审完就不再占着


def test_标注员改了退回的片段_自动回到待审_记调整(db, run):
    w = _world(db, run)
    it = w.items[0]
    run(api.decide(it.id, api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    ret = _q(run, db, w.ann, seg_status="returned")["items"]
    assert [i["id"] for i in ret] == [it.id] and ret[0]["review_note"] == "起止不准"
    run(api.edit(it.id, api.EditIn(start_time_ms=500, end_time_ms=3000), db, w.ann))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert got.seg_status is None and got.review_note is None and '"from": [0, 3000]' in got.boundary_edits


def test_审核员改起止不改状态_标注员不能动别人的(db, run):
    w = _world(db, run)
    it = w.items[1]
    run(api.edit(it.id, api.EditIn(start_time_ms=10200, end_time_ms=13000, label_id=w.child.id), db, w.rev))
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert (got.start_time_ms, got.seg_status) == (10200, "approved")
    with pytest.raises(HTTPException):
        run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.ann))   # 标注员不能通过


def test_工作台里改了通过的片段_回到待审(db, run):
    w = _world(db, run)
    it = w.items[2]
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    w.t.status = TaskStatus.IN_PROGRESS
    w.t.locked_by = w.ann.id
    run(db.commit())
    payload = [SimpleNamespace(label_id=x.label_id, start_time_ms=x.start_time_ms + (100 if x.id == it.id else 0),
                               end_time_ms=x.end_time_ms, origin_item_id=x.id, source_type=None, ai_confidence=None,
                               ai_confirmed=None, uncertain=None, uncertain_reason=None)
               for x in run(db.execute(select(AnnotationLabelItem))).scalars().all()]
    run(task_service.save_draft(db, w.t.id, w.ann, payload))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == it.id))).scalar_one()
    assert got.seg_status is None


def test_导出只要审核通过的片段(db, run, tmp_path, monkeypatch):
    from datetime import date, datetime

    from app.services import training_export_service as svc

    w = _world(db, run)
    run(db.execute(select(Sample))).scalar_one().session_date = date(2026, 9, 1)
    run(api.decide(w.items[0].id, api.DecideIn(decision="approved"), db, w.rev))
    run(api.decide(w.items[1].id, api.DecideIn(decision="returned", note="类别错了"), db, w.rev))

    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_of", csv_start)
    monkeypatch.setattr(svc, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    out = run(svc.export_dataset(db, "seg", project_ids=[w.p.id], scope="seg_approved", dry_run=True))
    assert out["n_segments"] == 1 and out["n_unapproved_skipped"] == 4


def test_按名字跨项目(db, run):
    w = _world(db, run)
    d = _q(run, db, w.rev, label_name="抓挠")
    assert len(d["items"]) == 3
    assert run(api.claim(api.ClaimIn(label_name="抓挠-头颈耳", n=10), db, w.rev))["data"]["claimed"] == 3
    assert _q(run, db, w.rev, label_name="没有这个")["items"] == []


def test_退回数_按项目(db, run):
    w = _world(db, run)
    run(api.decide(w.items[0].id, api.DecideIn(decision="returned", note="起止不准"), db, w.rev))
    run(api.decide(w.items[1].id, api.DecideIn(decision="returned", note="类别错了"), db, w.rev))
    d = run(api.returned_summary(db=db, user=w.ann))["data"]
    assert d == {"total": 2, "by_project": {w.p.id: 2}}
    run(api.edit(w.items[0].id, api.EditIn(start_time_ms=100, end_time_ms=3000), db, w.ann))   # 改好一条
    assert run(api.returned_summary(db=db, user=w.ann))["data"]["total"] == 1


def test_退回说要拆_标注员拆成两段_都回到待审(db, run):
    w = _world(db, run)
    it = w.items[0]                     # 0 ~ 3000
    run(api.decide(it.id, api.DecideIn(decision="returned", note="应该拆成几段"), db, w.rev))
    with pytest.raises(HTTPException):
        run(api.split(it.id, api.SplitIn(at_ms=100), db, w.ann))      # 太靠边
    r = run(api.split(it.id, api.SplitIn(at_ms=1200), db, w.ann))
    rows = run(db.execute(select(AnnotationLabelItem).where(
        AnnotationLabelItem.annotation_record_id == it.annotation_record_id,
        AnnotationLabelItem.label_id == it.label_id).order_by(AnnotationLabelItem.start_time_ms))).scalars().all()
    spans = [(x.start_time_ms, x.end_time_ms) for x in rows if x.start_time_ms < 3000]
    assert spans == [(0, 1200), (1200, 3000)]
    left = next(x for x in rows if x.id == it.id)
    assert left.seg_status is None and left.review_note is None and '"to": [0, 1200]' in left.boundary_edits
    assert r["data"]["right"]["start_time_ms"] == 1200
    assert _q(run, db, w.ann, seg_status="returned")["items"] == []   # 退回清掉了


def test_长片段优先(db, run):
    w = _world(db, run)
    w.items[1].end_time_ms = w.items[1].start_time_ms + 8000   # 8 秒，其余 3 秒
    run(db.commit())
    d = _q(run, db, w.rev, label_id=w.parent.id, order="long")
    assert d["items"][0]["id"] == w.items[1].id
    d = _q(run, db, w.rev, label_id=w.parent.id, min_sec=5)
    assert [i["id"] for i in d["items"]] == [w.items[1].id] and d["counts"]["pending"] == 1
    r = run(api.claim(api.ClaimIn(label_id=w.parent.id, n=1, order="long"), db, w.rev))
    assert r["data"]["claimed"] == 1
    assert [i["id"] for i in _q(run, db, w.rev, label_id=w.parent.id, mine=True)["items"]] == [w.items[1].id]


def test_标注员开着任务时管理员直接改_不被他的旧草稿冲掉(db, run):
    from datetime import datetime, timedelta

    w = _world(db, run)
    w.t.status = TaskStatus.IN_PROGRESS
    w.t.locked_by = w.ann.id
    w.t.lock_expires_at = datetime.now() + timedelta(hours=1)
    run(db.commit())
    all_items = run(db.execute(select(AnnotationLabelItem))).scalars().all()
    # 标注员这时拉了草稿：手里是旧版本
    stale = [SimpleNamespace(label_id=x.label_id, start_time_ms=x.start_time_ms, end_time_ms=x.end_time_ms,
                             origin_item_id=x.id, source_type=None, ai_confidence=None, ai_confirmed=None,
                             uncertain=None, uncertain_reason=None) for x in all_items]
    loaded_at = datetime.now() - timedelta(seconds=1)
    a, b = w.items[0], w.items[1]
    # 管理员在片段弹窗里直接改起止（不再 409），改完就算通过
    r = run(api.edit(a.id, api.EditIn(start_time_ms=500, end_time_ms=2500), db, w.admin))
    assert r["data"]["seg_status"] == "approved"
    # 管理员把 b 拆成两段：右半段是新建的，标注员手里没有
    run(api.split(b.id, api.SplitIn(at_ms=b.start_time_ms + 1500), db, w.admin))
    n_before = len(run(db.execute(select(AnnotationLabelItem))).scalars().all())

    # 标注员拿旧版本存草稿：a 的旧起止不写回，b 的右半段也不删
    rec = run(task_service.save_draft(db, w.t.id, w.ann, stale, loaded_at))
    assert rec.kept_others == 3
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == a.id))).scalar_one()
    assert (got.start_time_ms, got.end_time_ms, got.seg_status) == (500, 2500, "approved")
    assert len(run(db.execute(select(AnnotationLabelItem))).scalars().all()) == n_before

    # 不带 loaded_at（老前端）：照旧整份覆盖
    rec = run(task_service.save_draft(db, w.t.id, w.ann, stale))
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == a.id))).scalar_one()
    assert got.start_time_ms == 0


def test_管理员直接删片段_标注员旧草稿不重建(db, run):
    from datetime import datetime, timedelta

    w = _world(db, run)
    w.t.status = TaskStatus.IN_PROGRESS
    w.t.locked_by = w.ann.id
    run(db.commit())
    all_items = run(db.execute(select(AnnotationLabelItem))).scalars().all()
    stale = [SimpleNamespace(label_id=x.label_id, start_time_ms=x.start_time_ms, end_time_ms=x.end_time_ms,
                             origin_item_id=x.id, source_type=None, ai_confidence=None, ai_confirmed=None,
                             uncertain=None, uncertain_reason=None) for x in all_items]
    loaded_at = datetime.now() - timedelta(seconds=1)
    gone = w.items[0].id
    r = run(api.delete_item(gone, db, w.admin))
    assert r["data"]["deleted"]
    n = len(run(db.execute(select(AnnotationLabelItem))).scalars().all())
    rec = run(task_service.save_draft(db, w.t.id, w.ann, stale, loaded_at))
    assert rec.kept_others >= 1
    ids = [x.id for x in run(db.execute(select(AnnotationLabelItem))).scalars().all()]
    assert gone not in ids and len(ids) == n


def test_一键去重(db, run):
    w = _world(db, run)
    a, b, c = w.items
    # a、b 同类别重叠：并成一条；c 跟它们不重叠
    b.start_time_ms, b.end_time_ms = a.start_time_ms + 1000, a.end_time_ms + 2000
    # 父子：父类「抓挠」一条，被子类 c 完全盖住 → 删父
    rec = w.rec
    parent_item = AnnotationLabelItem(annotation_record_id=rec.id, label_id=w.parent.id, start_time_ms=c.start_time_ms,
                                      end_time_ms=c.end_time_ms, source_type=LabelItemSource.human_added)
    db.add(parent_item)
    run(db.commit())
    a_span = (a.start_time_ms, b.end_time_ms)
    run(api.decide(b.id, api.DecideIn(decision="approved"), db, w.rev))       # b 审核通过 → b 留下
    r = run(api.dedupe(api.DedupeIn(task_id=w.t.id), db, w.admin))["data"]
    assert r["merged"] == 1 and r["removed_parent"] == 1
    ids = {x.id for x in run(db.execute(select(AnnotationLabelItem))).scalars().all()}
    assert b.id in ids and a.id not in ids and parent_item.id not in ids and c.id in ids
    got = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id == b.id))).scalar_one()
    assert (got.start_time_ms, got.end_time_ms) == a_span and got.seg_status == "approved"
    # 再跑一次没东西可去
    r = run(api.dedupe(api.DedupeIn(task_id=w.t.id), db, w.admin))["data"]
    assert r["merged"] == 0 and r["removed_parent"] == 0

    # 父子部分重叠（细类只占粗类不到一半，如 抓挠 15s 与 抓挠-头颈耳 7s）：合并成一条长细类取并集
    p_long = AnnotationLabelItem(annotation_record_id=rec.id, label_id=w.parent.id, start_time_ms=200_000,
                                 end_time_ms=215_000, source_type=LabelItemSource.human_added)
    f_short = AnnotationLabelItem(annotation_record_id=rec.id, label_id=c.label_id, start_time_ms=200_200,
                                  end_time_ms=207_200, source_type=LabelItemSource.human_added)
    db.add(p_long)
    db.add(f_short)
    run(db.commit())
    r2 = run(api.dedupe(api.DedupeIn(task_id=w.t.id), db, w.admin))["data"]
    assert r2["removed_parent"] == 1
    rem = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.id.in_([p_long.id, f_short.id])))).scalars().all()
    assert len(rem) == 1 and rem[0].id == f_short.id
    assert (rem[0].start_time_ms, rem[0].end_time_ms) == (200_000, 215_000)


def test_整个项目一键去重(db, run):
    import pytest
    from fastapi import HTTPException

    w = _world(db, run)
    a, b, c = w.items
    b.start_time_ms, b.end_time_ms = a.start_time_ms + 1000, a.end_time_ms + 2000
    run(db.commit())
    # 标注员不能整个项目去重
    with pytest.raises(HTTPException):
        run(api.dedupe_project(api.DedupeProjectIn(project_id=w.p.id), db, w.ann))
    r = run(api.dedupe_project(api.DedupeProjectIn(project_id=w.p.id), db, w.rev))["data"]
    assert r["tasks"] == 1 and r["tasks_changed"] == 1 and r["merged"] == 1
    assert r["changed"][0]["task_id"] == w.t.id
    ids = {x.id for x in run(db.execute(select(AnnotationLabelItem))).scalars().all()}
    assert len({a.id, b.id} & ids) == 1 and c.id in ids
    # 再跑一次：没东西可去
    r = run(api.dedupe_project(api.DedupeProjectIn(project_id=w.p.id), db, w.rev))["data"]
    assert r["tasks_changed"] == 0 and r["merged"] == 0


def test_管理员不受别人领着限制_能退回给原来通过的人(db, run):
    from app.models.user import User, UserRole

    w = _world(db, run)
    it = w.items[0]
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    # 别人领着也能改、能通过
    it.seg_claimed_by, it.seg_claim_expires_at = w.rev2.id, api._now() + api.timedelta(days=1)
    run(db.commit())
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.admin))
    it.seg_claimed_by, it.seg_claim_expires_at = w.rev2.id, api._now() + api.timedelta(days=1)
    run(db.commit())
    with pytest.raises(HTTPException):          # 审核员照旧被挡
        run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    # 退回给通过它的人（现在是 admin 通过的 → 退回给 admin 自己；换成 rev 通过再试）
    it.seg_claimed_by = None
    run(db.commit())
    run(api.decide(it.id, api.DecideIn(decision="approved"), db, w.rev))
    with pytest.raises(HTTPException):
        run(api.send_back_to_reviewer(it.id, api.SendBackIn(), db, w.rev))
    r = run(api.send_back_to_reviewer(it.id, api.SendBackIn(note="起止不准"), db, w.admin))
    assert r["data"]["sent_to"] == w.rev.id
    run(db.refresh(it))
    assert it.seg_status is None and it.seg_claimed_by == w.rev.id and "起止不准" in (it.mark_note or "")


def test_查看里直接新建片段_审核员管理员可以_标注员不行(db, run):
    w = _world(db, run)
    body = api.CreateIn(task_id=w.t.id, label_id=w.child.id, start_time_ms=70000, end_time_ms=72500)
    with pytest.raises(HTTPException) as e:
        run(api.create(body, db, w.ann))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        run(api.create(api.CreateIn(task_id=w.t.id, label_id=999999, start_time_ms=0, end_time_ms=1000), db, w.admin))
    assert e.value.status_code == 422
    with pytest.raises(HTTPException):
        run(api.create(api.CreateIn(task_id=w.t.id, label_id=w.child.id, start_time_ms=1000, end_time_ms=1050), db, w.admin))
    r = run(api.create(body, db, w.admin))["data"]
    it = run(db.get(AnnotationLabelItem, r["id"]))
    assert it.annotation_record_id == w.rec.id and it.source_type == LabelItemSource.human_added
    assert it.seg_status == "approved" and it.seg_reviewed_by == w.admin.id and it.created_by == w.admin.id
    run(api.create(body, db, w.rev))
    n = run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.start_time_ms == 70000))).scalars().all()
    assert len(n) == 2


def test_挖空活动_按重叠具体行为切成多段(db, run):
    w = _world(db, run)
    # 新增运动轨「活动」与行为轨「舔」
    act = LabelDefinition(project_id=w.p.id, code="activity", display_name="活动", color="#faad14", sort_order=10, track="motion", created_by=w.admin.id)
    lick = LabelDefinition(project_id=w.p.id, code="lick", display_name="舔", color="#f5222d", sort_order=11, track="behavior", created_by=w.admin.id)
    for obj in (act, lick):
        db.add(obj)
    run(db.flush())
    # 模拟真实场景：活动 47080~75697，内部压着 舔 47080~47970、抓挠 57499~59598、抓挠 69570~84590
    m = AnnotationLabelItem(
        annotation_record_id=w.rec.id, label_id=act.id,
        start_time_ms=47080, end_time_ms=75697,
        source_type=LabelItemSource.ai_generated, ai_confidence=0.95,
    )
    b1 = AnnotationLabelItem(annotation_record_id=w.rec.id, label_id=lick.id, start_time_ms=47080, end_time_ms=47970, source_type=LabelItemSource.human_added)
    b2 = AnnotationLabelItem(annotation_record_id=w.rec.id, label_id=w.child.id, start_time_ms=57499, end_time_ms=59598, source_type=LabelItemSource.human_added)
    b3 = AnnotationLabelItem(annotation_record_id=w.rec.id, label_id=w.child.id, start_time_ms=69570, end_time_ms=84590, source_type=LabelItemSource.human_added)
    for obj in (m, b1, b2, b3):
        db.add(obj)
    run(db.commit())

    r = run(api.carve_motion(api.DedupeIn(task_id=w.t.id), db, w.rev))["data"]
    assert r["carved"] >= 1 and r["created"] >= 1 and r["removed"] == 0
    act_rows = sorted(
        run(db.execute(select(AnnotationLabelItem).where(AnnotationLabelItem.label_id == act.id))).scalars().all(),
        key=lambda x: x.start_time_ms,
    )
    assert [(x.start_time_ms, x.end_time_ms) for x in act_rows] == [(47970, 57499), (59598, 69570)]
    # 保持原来的待审状态（不擅自标通过）
    assert all(x.seg_status is None and x.source_type == LabelItemSource.ai_generated for x in act_rows)
    # 幂等：再跑一次无变化
    r2 = run(api.carve_motion(api.DedupeIn(task_id=w.t.id), db, w.rev))["data"]
    assert r2 == {"carved": 0, "created": 0, "removed": 0}


def test_合并相邻同类片段_保留审核状态并拒绝异类合并(db, run):
    w = _world(db, run)
    s1 = AnnotationLabelItem(
        annotation_record_id=w.rec.id, label_id=w.child.id,
        start_time_ms=49580, end_time_ms=57500,
        source_type=LabelItemSource.ai_generated, is_modified=True, seg_status="approved",
    )
    s2 = AnnotationLabelItem(
        annotation_record_id=w.rec.id, label_id=w.child.id,
        start_time_ms=57499, end_time_ms=59598,
        source_type=LabelItemSource.human_added, seg_status="approved",
    )
    s3 = AnnotationLabelItem(
        annotation_record_id=w.rec.id, label_id=w.child.id,
        start_time_ms=59600, end_time_ms=63750,
        source_type=LabelItemSource.ai_generated, is_modified=True, seg_status="approved",
    )
    other = AnnotationLabelItem(
        annotation_record_id=w.rec.id, label_id=w.other.id,
        start_time_ms=64000, end_time_ms=66000,
        source_type=LabelItemSource.human_added,
    )
    for obj in (s1, s2, s3, other):
        db.add(obj)
    run(db.commit())

    # 异类合并被拒绝
    with pytest.raises(HTTPException) as e:
        run(api.merge_adjacent(api.MergeAdjacentIn(task_id=w.t.id, groups=[[s1.id, other.id]]), db, w.rev))
    assert e.value.status_code == 422

    # 3 段相邻同类合为 1 段，起止取并集，保持已通过
    r = run(api.merge_adjacent(api.MergeAdjacentIn(task_id=w.t.id, groups=[[s1.id, s2.id, s3.id]]), db, w.rev))["data"]
    assert r == {"groups_merged": 1, "removed": 2}
    left = run(db.execute(
        select(AnnotationLabelItem).where(AnnotationLabelItem.id.in_([s1.id, s2.id, s3.id]))
    )).scalars().all()
    assert len(left) == 1
    assert (left[0].start_time_ms, left[0].end_time_ms) == (49580, 63750)
    assert left[0].seg_status == "approved"
