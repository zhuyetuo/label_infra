"""老项目按采集日期拆成一天一个项目：任务搬走、标签克隆、标注条目的 label_id 对到新标签上。"""

from datetime import date

import pytest
from sqlalchemy import select

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import project_split_service as pss


def _seed(db, run):
    async def go():
        u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
        db.add(u)
        await db.flush()
        p = Project(name="2026_7_17-2026_7_29_old", description="老的", created_by=u.id)
        db.add(p)
        await db.flush()
        parent = LabelDefinition(project_id=p.id, code="scratch", display_name="抓挠", color="#f00",
                                 sort_order=1, created_by=u.id, track="行为轨")
        db.add(parent)
        await db.flush()
        child = LabelDefinition(project_id=p.id, code="scratch_head", display_name="抓挠-头颈耳",
                                parent_id=parent.id, sort_order=2, created_by=u.id)
        db.add(child)
        await db.flush()
        tasks = []
        for i, d in enumerate([date(2026, 7, 17), date(2026, 7, 17), date(2026, 7, 18), None]):
            s = Sample(sample_code=f"s{i}", video_cam1_path=f"v{i}", imu_csv_path=f"c{i}",
                       session_date=d, created_by=u.id)
            db.add(s)
            await db.flush()
            t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.from_scratch,
                     status=TaskStatus.APPROVED, created_by=u.id)
            db.add(t)
            await db.flush()
            r = AnnotationRecord(task_id=t.id, source_type=RecordSourceType.human_only)
            db.add(r)
            await db.flush()
            db.add(AnnotationLabelItem(annotation_record_id=r.id, label_id=child.id, start_time_ms=0,
                                       end_time_ms=1000, source_type=LabelItemSource.human_added))
            tasks.append(t)
        await db.commit()
        return u, p, parent, child, tasks

    return run(go())


def test_split_by_date(db, run):
    u, p, parent, child, tasks = _seed(db, run)
    out = run(pss.split_by_date(db, p.id, u.id))
    run(db.commit())
    assert [c["date"] for c in out["created"]] == ["2026-07-17", "2026-07-18"]
    assert [c["n_tasks"] for c in out["created"]] == [2, 1]
    assert out["skipped_no_date"] == 1

    async def check():
        new = (await db.execute(select(Project).where(Project.name == "2026-07-17"))).scalar_one()
        labels = (await db.execute(select(LabelDefinition).where(LabelDefinition.project_id == new.id))).scalars().all()
        by_code = {l.code: l for l in labels}
        assert set(by_code) == {"scratch", "scratch_head"}
        assert by_code["scratch_head"].parent_id == by_code["scratch"].id
        assert by_code["scratch"].track == "行为轨" and by_code["scratch"].color == "#f00"
        # 搬过去的任务，标注条目指向新项目的同名标签
        moved = (await db.execute(select(Task).where(Task.project_id == new.id))).scalars().all()
        assert len(moved) == 2
        for t in moved:
            rec = (await db.execute(select(AnnotationRecord).where(AnnotationRecord.task_id == t.id))).scalar_one()
            item = (await db.execute(select(AnnotationLabelItem).where(
                AnnotationLabelItem.annotation_record_id == rec.id))).scalar_one()
            assert item.label_id == by_code["scratch_head"].id
        # 没日期的那个还在老项目里，标签也没被改
        old = await db.get(Project, p.id)
        stay = (await db.execute(select(Task).where(Task.project_id == p.id))).scalars().all()
        assert len(stay) == 1
        rec = (await db.execute(select(AnnotationRecord).where(AnnotationRecord.task_id == stay[0].id))).scalar_one()
        item = (await db.execute(select(AnnotationLabelItem).where(
            AnnotationLabelItem.annotation_record_id == rec.id))).scalar_one()
        assert item.label_id == child.id
        assert old.is_active is True and "拆成 2 个项目" in (old.description or "")

    run(check())


def test_single_day_refuses(db, run):
    async def go():
        u = User(username="b", password_hash="x", display_name="b", role=UserRole.admin)
        db.add(u)
        await db.flush()
        p = Project(name="one", created_by=u.id)
        db.add(p)
        await db.flush()
        s = Sample(sample_code="s", video_cam1_path="v", imu_csv_path="c", session_date=date(2026, 1, 1), created_by=u.id)
        db.add(s)
        await db.flush()
        db.add(Task(project_id=p.id, sample_id=s.id, task_type=TaskType.from_scratch, created_by=u.id))
        await db.commit()
        with pytest.raises(pss.SplitError):
            await pss.split_by_date(db, p.id, u.id)

    run(go())
