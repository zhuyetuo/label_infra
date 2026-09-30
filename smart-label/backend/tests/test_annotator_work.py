from datetime import date, datetime, timedelta

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services.annotator_work_service import annotator_work, record_briefs


def test_annotator_work_rows(db, run):
    async def go():
        u = User(username="intern", password_hash="x", display_name="实习生1", role=UserRole.annotator)
        db.add(u)
        await db.flush()
        p = Project(name="2026-09-23", created_by=u.id)
        db.add(p)
        await db.flush()
        lab = LabelDefinition(project_id=p.id, code="scratch", display_name="抓挠", created_by=u.id)
        db.add(lab)
        await db.flush()
        s = Sample(sample_code="s1", video_cam1_path="v", imu_csv_path="c", video_duration_sec=3599, created_by=u.id)
        db.add(s)
        await db.flush()
        t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED,
                 assigned_to=u.id, created_by=u.id)
        db.add(t)
        await db.flush()
        started = datetime(2026, 9, 30, 9, 0, 0)
        r = AnnotationRecord(task_id=t.id, round_no=1, source_type=RecordSourceType.ai_revised,
                             submitted_at=started + timedelta(minutes=12))
        db.add(r)
        await db.flush()
        r.created_at = started
        for i in range(3):
            db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=lab.id, start_time_ms=i * 1000,
                                       end_time_ms=i * 1000 + 500, source_type=LabelItemSource.human_added))
        await db.commit()
        rows = await annotator_work(db, date(2026, 9, 30), date(2026, 9, 30))
        briefs = await record_briefs(db, [t])
        return rows, briefs, t.id

    rows, briefs, tid = run(go())
    assert len(rows) == 1
    r = rows[0]
    assert r["user_name"] == "实习生1" and r["project_name"] == "2026-09-23"
    assert r["item_count"] == 3 and r["work_seconds"] == 12 * 60
    assert r["submitted_at"].startswith("2026-09-30T09:12")
    assert briefs[tid]["item_count"] == 3 and briefs[tid]["work_seconds"] == 720
    # 范围外没有
    assert run(annotator_work(db, date(2026, 10, 1), date(2026, 10, 2))) == []
