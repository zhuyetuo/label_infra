"""超时收回的任务要记下原来是谁的，重新认领后清掉。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import task_service
from app.services.reclaim_service import reclaim_expired_tasks


def test_收回时记下原指派人_重新认领清掉(db, run):
    u = User(username="intern", password_hash="x", display_name="实习生", role=UserRole.annotator)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    s = Sample(sample_code="s1", video_cam1_path="a.mp4", imu_csv_path="a.csv", created_by=u.id)
    db.add(p)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.IN_PROGRESS,
             assigned_to=u.id, locked_by=u.id, created_by=u.id,
             lock_expires_at=(datetime.now(UTC) - timedelta(hours=1)).replace(tzinfo=None))
    db.add(t)
    run(db.commit())

    assert run(reclaim_expired_tasks(db)) == 1
    run(db.refresh(t))
    assert t.status == TaskStatus.PENDING_ASSIGN and t.assigned_to is None
    assert t.reclaimed_from == u.id and t.reclaimed_at is not None

    run(task_service.claim_task(db, t.id, u))
    run(db.refresh(t))
    assert t.reclaimed_from is None and t.reclaimed_at is None


def test_mysql_赋值顺序_先记再清():
    """MySQL 的 UPDATE 从左到右赋值：reclaimed_from 必须在 assigned_to 被清空之前。"""
    import inspect

    from app.services import reclaim_service

    src = inspect.getsource(reclaim_service.reclaim_expired_tasks)
    assert src.index("Task.reclaimed_from, Task.assigned_to") < src.index("(Task.assigned_to, None)")
