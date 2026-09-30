from datetime import date, datetime, timedelta

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import annotator_work_service as aw


def test_annotator_work_rows(db, run):
    off = aw.local_offset()
    # 本地 2026-09-30 09:00 开始动手，09:12 提交；库里 submitted_at 存的是 UTC 钟面
    started_local = datetime(2026, 9, 30, 9, 0, 0)
    submitted_utc = started_local + timedelta(minutes=12) - off

    async def go():
        u = User(username="intern", password_hash="x", display_name="实习生1", role=UserRole.annotator)
        db.add(u)
        await db.flush()
        p = Project(name="2026-09-23", created_by=u.id)
        db.add(p)
        await db.flush()
        lab = LabelDefinition(project_id=p.id, code="scratch_head", display_name="抓挠-头颈耳", created_by=u.id)
        other = LabelDefinition(project_id=p.id, code="rest", display_name="静止/休息", created_by=u.id)
        db.add(lab)
        db.add(other)
        await db.flush()
        s = Sample(sample_code="s1", video_cam1_path="v", imu_csv_path="c", video_duration_sec=3599, created_by=u.id)
        db.add(s)
        await db.flush()
        t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED,
                 assigned_to=u.id, created_by=u.id)
        db.add(t)
        await db.flush()
        r = AnnotationRecord(task_id=t.id, round_no=1, source_type=RecordSourceType.ai_revised,
                             submitted_at=submitted_utc)
        db.add(r)
        await db.flush()
        r.created_at = started_local - timedelta(hours=20)     # AI 预标注建的记录，比人早一天
        # AI 给的两段抓挠（一段人确认了）、一段静止；人自己加了一段抓挠
        db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=lab.id, start_time_ms=0, end_time_ms=500,
                                   source_type=LabelItemSource.ai_generated, ai_confirmed=True))
        db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=lab.id, start_time_ms=1000, end_time_ms=1500,
                                   source_type=LabelItemSource.ai_generated))
        db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=other.id, start_time_ms=2000, end_time_ms=2500,
                                   source_type=LabelItemSource.ai_generated))
        human = AnnotationLabelItem(annotation_record_id=r.id, label_id=lab.id, start_time_ms=3000, end_time_ms=3500,
                                    source_type=LabelItemSource.human_added, created_by=u.id)
        db.add(human)
        await db.flush()
        human.created_at = started_local
        # 一条候选，人在 09:05 判了
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="疑似抓挠", start_time_ms=0, end_time_ms=1,
                           reason="low_conf", status=CandidateStatus.rejected, decided_by=u.id,
                           decided_at=started_local + timedelta(minutes=5) - off))
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="疑似抓挠", start_time_ms=5, end_time_ms=6,
                           reason="low_conf"))
        await db.commit()
        work = await aw.annotator_work(db, date(2026, 9, 30), date(2026, 9, 30))
        briefs = await aw.record_briefs(db, [t])
        prog = await aw.project_progress(db)
        return work, briefs, t.id, prog

    work, briefs, tid, prog = run(go())
    subs = work["submissions"]
    assert len(subs) == 1
    r = subs[0]
    assert r["user_name"] == "实习生1" and r["project_name"] == "2026-09-23"
    assert r["submitted_at"] == "2026-09-30T09:12:00"          # 换回本地时间
    assert r["started_at"] == "2026-09-30T09:00:00"            # 人第一次动手，不是 AI 建记录的时刻
    assert r["work_seconds"] == 12 * 60
    assert r["item_count"] == 4 and r["scratch_items"] == 3 and r["scratch_pending"] == 1
    assert r["cand_total"] == 2 and r["cand_pending"] == 1
    assert len(work["candidate_decisions"]) == 1 and work["candidate_decisions"][0]["decided_at"] == "2026-09-30T09:05:00"
    b = briefs[tid]
    assert b["work_seconds"] == 720 and b["scratch_pending"] == 1 and b["cand_pending"] == 1
    assert prog == [{"project_id": r["project_id"], "project_name": "2026-09-23",
                     "tasks_total": 1, "tasks_submitted": 1, "tasks_approved": 0,
                     "scratch_total": 3, "scratch_pending": 1, "cand_total": 2, "cand_pending": 1}]
    assert run(aw.annotator_work(db, date(2026, 10, 2), date(2026, 10, 3)))["submissions"] == []
