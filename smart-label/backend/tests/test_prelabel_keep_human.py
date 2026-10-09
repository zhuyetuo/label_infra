"""重跑 AI 预标注、「有人工标注的任务只补疑似片段」（keep_human）。

场景：项目分给实习生，他确认了一部分片段；算法加了新的候选类别（进食 / 饮水 / 吠叫），
想重跑把新候选补上，但**他标过的片段一条都不能丢**。
"""

from datetime import datetime

from sqlalchemy import select

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.schemas.model_version import PrelabelItem
from app.services import ai_prelabel_service as svc

T0 = datetime(2026, 9, 30, 9, 0, 0)


def _setup(db, run):
    async def go():
        u = User(username="intern", password_hash="x", display_name="实习生", role=UserRole.annotator)
        db.add(u)
        await db.flush()
        p = Project(name="p", created_by=u.id)
        db.add(p)
        await db.flush()
        scratch = LabelDefinition(project_id=p.id, code="s", display_name="抓挠-头颈耳", created_by=u.id)
        rest = LabelDefinition(project_id=p.id, code="r", display_name="静止/休息", created_by=u.id)
        db.add(scratch)
        db.add(rest)
        s = Sample(sample_code="s0", video_cam1_path="v", imu_csv_path="c.csv", video_duration_sec=3599, created_by=u.id)
        db.add(s)
        await db.flush()
        t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.IN_PROGRESS,
                 assigned_to=u.id, created_by=u.id)
        db.add(t)
        await db.flush()
        r = AnnotationRecord(task_id=t.id, round_no=1, source_type=RecordSourceType.ai_revised)
        db.add(r)
        await db.flush()
        # 实习生确认过的一段抓挠 + 一段没人动过的 AI 静止
        db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=scratch.id, start_time_ms=0, end_time_ms=10_000,
                                   source_type=LabelItemSource.ai_generated, ai_confirmed=True))
        db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=rest.id, start_time_ms=100_000, end_time_ms=200_000,
                                   source_type=LabelItemSource.ai_generated))
        # 候选：一条他确认过的抓挠、一条大模型看视频给的（没判）、一条老的低置信（没判）
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="抓挠", start_time_ms=20_000, end_time_ms=25_000,
                           reason="low_conf", status=CandidateStatus.confirmed))
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="舔", start_time_ms=30_000, end_time_ms=35_000,
                           reason="vision"))
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="抓挠", start_time_ms=40_000, end_time_ms=45_000,
                           reason="low_conf"))
        await db.commit()
        return t, s

    return run(go())


def _items(db, run):
    return run(db.execute(select(AnnotationLabelItem).order_by(AnnotationLabelItem.id))).scalars().all()


def _cands(db, run):
    return run(db.execute(select(AiCandidate).order_by(AiCandidate.start_time_ms))).scalars().all()


def test_without_keep_human_task_is_skipped(db, run, monkeypatch):
    t, s = _setup(db, run)
    monkeypatch.setattr(svc, "_csv_start_of", lambda sample: _ret(T0))
    assert isinstance(run(svc._prepare(db, t, s, overwrite_ai=True)), str)


async def _ret(v):
    return v


def test_keep_human_only_adds_candidates_and_keeps_every_segment(db, run, monkeypatch):
    t, s = _setup(db, run)
    monkeypatch.setattr(svc, "_csv_start_of", lambda sample: _ret(T0))
    before = [(i.id, i.label_id, i.start_time_ms, i.end_time_ms, i.ai_confirmed) for i in _items(db, run)]

    p = run(svc._prepare(db, t, s, overwrite_ai=False, keep_human=True))
    assert not isinstance(p, str) and p.candidates_only

    C = svc.CandidateItem
    inf = svc.SampleInference(
        # 这次 AI 给的片段跟原来不一样——candidates_only 下一条都不该写进去
        items=[PrelabelItem(label_name="静止/休息", start_time_ms=0, end_time_ms=300_000, confidence=0.9)],
        skipped=0, n_windows=100, ai_label_path="new.json",
        candidates=[
            C("抓挠", 2_000, 8_000, 0.5, None, "low_conf"),      # 落在他确认过的抓挠-头颈耳里 → 不写
            C("抓挠", 21_000, 24_000, 0.5, None, "low_conf"),    # 跟他确认过的候选重叠 → 不写
            C("进食", 50_000, 70_000, 0.4, None, "eating"),       # 新类别 → 写
            C("吠叫", 80_000, 82_000, 0.6, None, "barking"),      # 新类别 → 写
        ],
    )
    s.ai_label_path = "old.json"
    assert run(svc._apply(db, p, inf, {"静止/休息": 2}, set())) is None

    after = [(i.id, i.label_id, i.start_time_ms, i.end_time_ms, i.ai_confirmed) for i in _items(db, run)]
    assert after == before, "片段被动了"
    assert s.ai_label_path == "old.json"
    got = [(c.label_name, c.start_time_ms, c.reason, c.status.value) for c in _cands(db, run)]
    assert got == [
        ("抓挠", 20_000, "low_conf", "confirmed"),   # 判过的留着
        ("舔", 30_000, "vision", "pending"),         # 别的入口写的、没判的也留着
        ("进食", 50_000, "eating", "pending"),
        ("吠叫", 80_000, "barking", "pending"),
    ]                                               # 老的没判的低置信（40s）被这次的结果换掉了
