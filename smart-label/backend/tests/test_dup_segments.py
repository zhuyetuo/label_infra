"""同一段时间不该留下两行一模一样的片段。

两行长得完全一样时，人根本分不出该删哪一条——而这些片段是原样送去算
「今天抓了几次、共多久」的，同一次动作被算成两次，C 值跟着虚高。皮肤评估是
拿来判断要不要干预的，数字虚高比没有数字更糟。

这里守两条口子：
1. 保存草稿时，一次里出现两条完全一样的（同标签同起止），只留库里已有的那条
2. 从候选确认时，「同类别」按**名字**算——同名标签在一个项目里可能有两条
   （停用的旧的 + 现在这条），按 label_id 比就漏了
"""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import select

from app.models.annotation import AnnotationLabelItem, LabelItemSource
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import task_service


def _world(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    lab = LabelDefinition(project_id=p.id, code="lick", display_name="舔-后肢", created_by=u.id)
    db.add(lab)
    s = Sample(sample_code="s1", video_cam1_path="d/a.mp4", imu_csv_path="d/a.csv", created_by=u.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted,
             status=TaskStatus.IN_PROGRESS, locked_by=u.id, created_by=u.id)
    db.add(t)
    run(db.commit())
    return u, p, lab, t


def _incoming(label_id, start, end, origin=None):
    return SimpleNamespace(label_id=label_id, start_time_ms=start, end_time_ms=end,
                           origin_item_id=origin, source_type=LabelItemSource.human_added,
                           ai_confidence=None, ai_confirmed=None, uncertain=None, uncertain_reason=None)


def _items(db, run, record_id):
    return run(db.execute(select(AnnotationLabelItem)
                          .where(AnnotationLabelItem.annotation_record_id == record_id)
                          .order_by(AnnotationLabelItem.id))).scalars().all()


def test_保存时同标签同起止的重复只留一条(db, run):
    u, p, lab, t = _world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [
        _incoming(lab.id, 100718, 107200),
        _incoming(lab.id, 100718, 107200),          # 一模一样：不是有人故意标了两遍
        _incoming(lab.id, 134409, 137452),          # 时间不同：照留
    ]))
    got = _items(db, run, rec.id)
    assert [(i.start_time_ms, i.end_time_ms) for i in got] == [(100718, 107200), (134409, 137452)]


def test_重复时留库里已有的那条_不留新加的(db, run):
    """已有的那条身上挂着出处（点错了能退回候选）、改没改过、谁确认的。
    反过来丢就把这些一起丢了，而且顺序一变结果就变。"""
    u, p, lab, t = _world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 100718, 107200)]))
    old = _items(db, run, rec.id)[0]
    old.from_candidate_id = 42
    run(db.commit())

    # 新加的排在前面，已有的排在后面——顺序不该影响结果
    rec = run(task_service.save_draft(db, t.id, u, [
        _incoming(lab.id, 100718, 107200),
        _incoming(lab.id, 100718, 107200, origin=old.id),
    ]))
    got = _items(db, run, rec.id)
    assert len(got) == 1 and got[0].id == old.id and got[0].from_candidate_id == 42


def test_起止差一毫秒的不算重复_照留(db, run):
    """真有连着的两次动作。差一点就并，等于替人做了"这两次是同一次"的判断——
    该并不该并只有人知道，这里只处理"完全一样"这种明显不是故意的。"""
    u, p, lab, t = _world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [
        _incoming(lab.id, 100718, 107200),
        _incoming(lab.id, 100718, 107201),
    ]))
    assert len(_items(db, run, rec.id)) == 2


def test_同一段时间父子都标了_只留细的那条(db, run):
    """「舔」和「舔-躯干」标在同一段时间上：父级那条一点新信息都没有。

    导出本来就是从叶子往上写整条链（["舔","舔-躯干"]），单独那条「舔」既不会让
    导出多出什么，还会触发"粗标签挖掉细段"那套逻辑白跑一遍；界面上更是两行时间
    一模一样，人只会以为是重复了。

    **只在起止完全相同时才丢**：粗的那条要是更长，丢了就把没被细段盖住的那截
    也一起丢了——那是真信息。
    """
    u, p, lab, t = _world(db, run)
    parent = LabelDefinition(project_id=p.id, code="lick_root", display_name="舔", created_by=u.id)
    db.add(parent)
    run(db.flush())
    lab.parent_id = parent.id
    run(db.commit())

    rec = run(task_service.save_draft(db, t.id, u, [
        _incoming(parent.id, 227040, 237090),       # 舔      ← 被细的那条盖住，丢
        _incoming(lab.id, 227040, 237090),          # 舔-后肢 ← 留
        _incoming(parent.id, 300000, 320000),       # 起止不同：照留
    ]))
    got = [(i.label_id, i.start_time_ms) for i in _items(db, run, rec.id)]
    assert got == [(lab.id, 227040), (parent.id, 300000)]


def test_父的那条更长时不丢_那截是真信息(db, run):
    """粗的比细的长：丢了就把没被细段盖住的那截也丢了。起止完全相同才算重复。"""
    u, p, lab, t = _world(db, run)
    parent = LabelDefinition(project_id=p.id, code="lick_root2", display_name="舔", created_by=u.id)
    db.add(parent)
    run(db.flush())
    lab.parent_id = parent.id
    run(db.commit())

    rec = run(task_service.save_draft(db, t.id, u, [
        _incoming(parent.id, 227040, 250000),       # 舔：更长，照留
        _incoming(lab.id, 227040, 237090),
    ]))
    assert len(_items(db, run, rec.id)) == 2


def test_库里已经并排躺着两条一样的_存一次就清掉(db, run):
    """原来那条规则只拦**新加的**（`if not incoming.origin_item_id` 里才查重），
    于是库里早就并排躺着的两条一模一样的行，存多少次草稿都还在。

    人看到的是两行分毫不差，删掉一条再存，点进来还是两行——他删的是前端那份，
    后端把两条都写回去了。
    """
    u, p, lab, t = _world(db, run)
    # 先造出"库里两条一模一样"的局面
    rec = run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 227040, 237090)]))
    a = _items(db, run, rec.id)[0]
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id,
                               start_time_ms=227040, end_time_ms=237090,
                               source_type=LabelItemSource.human_added, created_by=u.id))
    run(db.commit())
    b = [i for i in _items(db, run, rec.id) if i.id != a.id][0]
    assert len(_items(db, run, rec.id)) == 2

    # 两条都带 origin 交回来（前端就是这么把库里那份原样带回来的）
    rec2 = run(task_service.save_draft(db, t.id, u, [
        _incoming(lab.id, 227040, 237090, origin=a.id),
        _incoming(lab.id, 227040, 237090, origin=b.id),
    ]))
    got = _items(db, run, rec2.id)
    assert len(got) == 1, "库里已有的两条一样的，存一次就该只剩一条"
    # 留 id 小的那条：必须是确定的，不然同一份草稿存两次可能留下不同的行
    assert got[0].id == min(a.id, b.id)


def test_去重和补回候选不打架_留带出处的那条(db, run):
    """两条规则会互相拆台：

      存草稿   同标签同起止的只留一条
      打开工作台  按候选行把"确认过但没有片段"的补回来

    留下的那条要是没挂 from_candidate_id，第二条规则就以为片段丢了，又补一条
    回去——人存完看着干净了，关掉重开又是两行。录屏实测（2026-09-22）就是这样：
    13 段存成 12 段，重开又变回 13 段。

    两头都修：去重优先留**带出处**的那条；补回时除了按候选 id，也按
    「同类别同起止」认一遍。
    """
    from app.api.v1 import candidates as cand_api
    from app.models.ai_candidate import AiCandidate, CandidateStatus

    u, p, lab, t = _world(db, run)
    c = AiCandidate(task_id=t.id, round_no=t.round_no, label_name="舔-后肢",
                    start_time_ms=227040, end_time_ms=237090, reason="similar",
                    status=CandidateStatus.confirmed, decided_label_id=lab.id, decided_by=u.id)
    db.add(c)
    run(db.flush())
    rec = run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 227040, 237090)]))
    plain = _items(db, run, rec.id)[0]
    db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id,
                               start_time_ms=227040, end_time_ms=237090,
                               source_type=LabelItemSource.human_added,
                               from_candidate_id=c.id, created_by=u.id))
    run(db.commit())
    linked = [i for i in _items(db, run, rec.id) if i.from_candidate_id][0]

    rec2 = run(task_service.save_draft(db, t.id, u, [
        _incoming(lab.id, 227040, 237090, origin=plain.id),
        _incoming(lab.id, 227040, 237090, origin=linked.id),
    ]))
    got = _items(db, run, rec2.id)
    assert len(got) == 1
    # 留带出处的那条：没有它，下面那一步又会补一条回来
    assert got[0].from_candidate_id == c.id

    # 再打开一次工作台（会先跑补回）：不许再多出一条
    run(cand_api.repair_items(t.id, db=db, user=u))
    assert len(_items(db, run, rec2.id)) == 1
