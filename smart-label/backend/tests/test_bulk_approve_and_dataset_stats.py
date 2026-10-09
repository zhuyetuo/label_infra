"""超级管理员一键通过 + 可用数据类别统计。"""

from sqlalchemy import select

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.audit_log import AuditLog
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.review import ReviewRecord
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import annotator_work_service as aw
from app.services import review_service as rs


def _setup(db, run):
    async def go():
        boss = User(username="boss", password_hash="x", display_name="老板", role=UserRole.super_admin)
        admin = User(username="adm", password_hash="x", display_name="管理员", role=UserRole.admin)
        rev = User(username="rev", password_hash="x", display_name="审核员", role=UserRole.reviewer)
        intern = User(username="i", password_hash="x", display_name="实习生", role=UserRole.annotator)
        for u in (boss, admin, rev, intern):
            db.add(u)
        await db.flush()
        projs, tasks = [], []
        for name in ("2026-09-21", "2026-09-22"):
            p = Project(name=name, created_by=boss.id)
            db.add(p)
            await db.flush()
            projs.append(p)
            scratch = LabelDefinition(project_id=p.id, code="s", display_name="抓挠", created_by=boss.id, sort_order=1)
            lick = LabelDefinition(project_id=p.id, code="l", display_name="舔", created_by=boss.id, sort_order=2)
            rest = LabelDefinition(project_id=p.id, code="r", display_name="静止/休息", created_by=boss.id, sort_order=3)
            for l in (scratch, lick, rest):
                db.add(l)
            await db.flush()
            for k in range(3):
                s = Sample(sample_code=f"{name}_{k}", video_cam1_path="v", imu_csv_path="c", video_duration_sec=3599,
                           created_by=boss.id)
                db.add(s)
                await db.flush()
                t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.SUBMITTED,
                         assigned_to=intern.id, created_by=boss.id)
                db.add(t)
                await db.flush()
                tasks.append(t)
                r = AnnotationRecord(task_id=t.id, round_no=1, source_type=RecordSourceType.ai_revised)
                db.add(r)
                await db.flush()
                # 每个任务：人确认的抓挠 10s、没人看的 AI 静止 100s
                db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=scratch.id, start_time_ms=0,
                                           end_time_ms=10_000, source_type=LabelItemSource.ai_generated, ai_confirmed=True))
                db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=rest.id, start_time_ms=20_000,
                                           end_time_ms=120_000, source_type=LabelItemSource.ai_generated))
        # 第 1 个项目里一个任务被审核员认领了、正在审；另一个还在标（不是待审）
        tasks[0].locked_by = rev.id
        tasks[0].reviewer_id = rev.id
        tasks[1].status = TaskStatus.IN_PROGRESS
        await db.commit()
        return boss, admin, projs, tasks

    return run(go())


def test_only_super_admin_can_bulk_approve(db, run):
    boss, admin, projs, tasks = _setup(db, run)
    try:
        run(rs.bulk_approve(db, admin))
        raise AssertionError("管理员也能一键通过了")
    except rs.ReviewConflictError:
        pass


def test_bulk_approve_one_project_then_all(db, run):
    boss, admin, projs, tasks = _setup(db, run)
    r = run(rs.bulk_approve(db, boss, projs[0].id))
    # 项目 1：3 个任务里 1 个被审核员认领（跳过）、1 个还在标（不碰）、1 个通过
    assert r == {"approved": 1, "skipped": 1}
    st = {t.id: t.status for t in run(db.execute(select(Task))).scalars().all()}
    assert st[tasks[0].id] == TaskStatus.SUBMITTED and st[tasks[1].id] == TaskStatus.IN_PROGRESS
    assert st[tasks[2].id] == TaskStatus.APPROVED and st[tasks[3].id] == TaskStatus.SUBMITTED
    r = run(rs.bulk_approve(db, boss))
    assert r == {"approved": 3, "skipped": 1}
    recs = run(db.execute(select(ReviewRecord))).scalars().all()
    assert len(recs) == 4 and all(x.comment == "批量通过" and x.reviewer_id == boss.id for x in recs)
    assert len(run(db.execute(select(AuditLog).where(AuditLog.action == "review.bulk_approve"))).scalars().all()) == 2


def test_dataset_stats_counts_only_approved(db, run):
    boss, admin, projs, tasks = _setup(db, run)
    run(rs.bulk_approve(db, boss))                       # 通过 4 个（2 个跳过 / 不是待审）
    st = run(aw.dataset_stats(db))
    assert st["n_tasks"] == 4
    cats = {c["name"]: c for c in st["categories"]}
    assert cats["抓挠"]["n"] == 4 and cats["抓挠"]["seconds"] == 40.0 and cats["抓挠"]["confirmed_seconds"] == 40.0
    assert cats["静止/休息"]["n"] == 4 and cats["静止/休息"]["seconds"] == 400.0
    assert cats["静止/休息"]["confirmed_seconds"] == 0.0 and cats["静止/休息"]["pending"] == 4
    assert cats["舔"]["n"] == 0                          # 两个项目都有这个类别，一段都没有
    assert [c["name"] for c in st["categories"]][0] == "静止/休息"   # 按时长排
    one = run(aw.dataset_stats(db, [projs[1].id]))
    assert one["n_tasks"] == 3 and {c["name"]: c["n"] for c in one["categories"]}["抓挠"] == 3
