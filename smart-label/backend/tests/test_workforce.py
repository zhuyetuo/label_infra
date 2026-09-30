from datetime import date, datetime, timedelta

from app.models.ai_candidate import AiCandidate, CandidateStatus
from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.audit_log import AuditLog
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import workforce_service as wf
from app.services.annotator_work_service import local_offset


def test_workforce(db, run):
    off = local_offset()
    t0 = datetime(2026, 9, 30, 9, 0, 0)

    async def go():
        u = User(username="intern", password_hash="x", display_name="实习生1", role=UserRole.annotator)
        db.add(u)
        await db.flush()
        p = Project(name="2026-09-23", created_by=u.id)
        db.add(p)
        await db.flush()
        scratch = LabelDefinition(project_id=p.id, code="s", display_name="抓挠-头颈耳", created_by=u.id)
        rest = LabelDefinition(project_id=p.id, code="r", display_name="静止/休息", created_by=u.id)
        db.add(scratch)
        db.add(rest)
        await db.flush()
        tasks = []
        for i in range(3):
            s = Sample(sample_code=f"s{i}", video_cam1_path="v", imu_csv_path="c", video_duration_sec=3599, created_by=u.id)
            db.add(s)
            await db.flush()
            t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted,
                     status=TaskStatus.SUBMITTED if i < 2 else TaskStatus.IN_PROGRESS, assigned_to=u.id, created_by=u.id)
            db.add(t)
            await db.flush()
            tasks.append(t)
        db.add(AuditLog(user_id=u.id, action="task.assign", target_type="project", target_id=p.id,
                        detail='{"assigned_to": %d, "n": 3}' % u.id))
        # 任务 0：抓挠三段各隔 30s 确认，静止一段 5s，候选两条各 20s，最后提交
        r = AnnotationRecord(task_id=tasks[0].id, round_no=1, source_type=RecordSourceType.ai_revised,
                             submitted_at=t0 + timedelta(seconds=200) - off)
        db.add(r)
        await db.flush()
        seq = [(scratch, 0), (scratch, 30), (scratch, 60), (rest, 65)]
        for lab, sec in seq:
            db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=lab.id, start_time_ms=sec, end_time_ms=sec + 1,
                                       source_type=LabelItemSource.ai_generated, ai_confirmed=True,
                                       touched_at=t0 + timedelta(seconds=sec), touched_by=u.id))
        for sec in (85, 105):
            db.add(AiCandidate(task_id=tasks[0].id, round_no=1, label_name="疑似抓挠", start_time_ms=0, end_time_ms=1,
                               reason="low_conf", status=CandidateStatus.rejected, decided_by=u.id,
                               decided_at=t0 + timedelta(seconds=sec) - off))
        # 任务 2（没交）：一段抓挠待确认、一条候选待判
        r2 = AnnotationRecord(task_id=tasks[2].id, round_no=1, source_type=RecordSourceType.ai_revised)
        db.add(r2)
        await db.flush()
        db.add(AnnotationLabelItem(annotation_record_id=r2.id, label_id=scratch.id, start_time_ms=0, end_time_ms=1,
                                   source_type=LabelItemSource.ai_generated))
        db.add(AiCandidate(task_id=tasks[2].id, round_no=1, label_name="疑似抓挠", start_time_ms=0, end_time_ms=1, reason="low_conf"))
        await db.commit()
        led = await wf.ledger(db)
        eff = await wf.efficiency(db, date(2026, 9, 30), date(2026, 9, 30))
        return led, eff

    led, eff = run(go())
    assert len(led) == 1
    L = led[0]
    assert L["tasks_total"] == 3 and L["tasks_submitted"] == 2 and L["assigned_logged"] is True
    assert L["scratch_pending"] == 1 and L["cand_pending"] == 1 and L["done"] is False
    assert L["first_touch"] == "2026-09-30T09:00:00"
    assert len(eff) == 1
    cats = {c["category"]: c for c in eff[0]["categories"]}
    assert cats["抓挠"]["n"] == 3 and cats["抓挠"]["median_seconds"] == 30.0     # 第一条没有前一个动作，两条间隔 30
    assert cats["静止/休息"]["median_seconds"] == 5.0
    assert cats["疑似抓挠"]["median_seconds"] == 20.0
    assert cats["提交任务"]["n"] == 1 and cats["提交任务"]["median_seconds"] == 95.0
    assert eff[0]["days"][0]["actions"] == 7
    est = wf.estimate(led, eff)
    assert est[0]["tasks_left"] == 1 and est[0]["hours_left"] is None
    # 每类不足 5 条实测的话，用全员中位数——这里全员就他一个，也不足 5 条 → 空着
    assert est[0]["missing"] == ["scratch", "cand", "tasks"]


def test_unassigned_and_pool(db, run):
    async def go():
        u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
        db.add(u)
        await db.flush()
        p = Project(name="2026-09-26", created_by=u.id)
        db.add(p)
        await db.flush()
        s = Sample(sample_code="x", video_cam1_path="v", imu_csv_path="c", created_by=u.id)
        db.add(s)
        await db.flush()
        t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, created_by=u.id)
        db.add(t)
        await db.flush()
        db.add(AiCandidate(task_id=t.id, round_no=1, label_name="疑似抓挠", start_time_ms=0, end_time_ms=1, reason="low_conf"))
        await db.commit()
        return await wf.unassigned_workload(db)

    out = run(go())
    assert out == [{"project_id": out[0]["project_id"], "project_name": "2026-09-26", "tasks_left": 1,
                    "scratch_total": 0, "scratch_pending": 0, "cand_total": 1, "cand_pending": 1}]
    rates = {"抓挠": 30.0, "疑似抓挠": 20.0, "提交任务": None}
    h = wf.hours_for(rates, 10, 6, 100)
    assert h["missing"] == ["tasks"] and h["hours_left"] == round((6 * 30 + 100 * 20) / 3600, 1)
