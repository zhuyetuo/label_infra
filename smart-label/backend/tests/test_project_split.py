"""老项目按采集日期拆成一天一个项目：原项目不动，副本进新项目；撤销拆分能回到原样。"""

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


async def _items_of_project(db, pid):
    out = []
    for t in (await db.execute(select(Task).where(Task.project_id == pid))).scalars().all():
        for r in (await db.execute(select(AnnotationRecord).where(AnnotationRecord.task_id == t.id))).scalars().all():
            out += (await db.execute(select(AnnotationLabelItem).where(
                AnnotationLabelItem.annotation_record_id == r.id))).scalars().all()
    return out


def test_split_copies_and_keeps_source(db, run):
    u, p, parent, child, tasks = _seed(db, run)
    out = run(pss.split_by_date(db, p.id, u.id))
    run(db.commit())
    assert [c["date"] for c in out["created"]] == ["2026-07-17", "2026-07-18"]
    assert [c["n_tasks"] for c in out["created"]] == [2, 1]
    assert out["skipped_no_date"] == 1

    async def check():
        # 原项目一个字不动：4 个任务、标注还指向原标签、仍启用
        old = await db.get(Project, p.id)
        assert old.is_active is True and "拆成 2 个项目" in old.description
        stay = (await db.execute(select(Task).where(Task.project_id == p.id))).scalars().all()
        assert len(stay) == 4
        assert all(it.label_id == child.id for it in await _items_of_project(db, p.id))
        # 新项目：标签克隆、副本的标注指向新标签
        new = (await db.execute(select(Project).where(Project.name == "2026-07-17"))).scalar_one()
        by_code = {l.code: l for l in (await db.execute(
            select(LabelDefinition).where(LabelDefinition.project_id == new.id))).scalars().all()}
        assert by_code["scratch_head"].parent_id == by_code["scratch"].id
        assert by_code["scratch"].track == "行为轨" and by_code["scratch"].color == "#f00"
        items = await _items_of_project(db, new.id)
        assert len(items) == 2 and all(it.label_id == by_code["scratch_head"].id for it in items)
        # 拆过的不能再拆
        with pytest.raises(pss.SplitError):
            await pss.split_by_date(db, p.id, u.id)

    run(check())


def test_unsplit_removes_copies(db, run):
    u, p, parent, child, tasks = _seed(db, run)
    run(pss.split_by_date(db, p.id, u.id))
    run(db.commit())
    out = run(pss.unsplit(db, p.id))
    run(db.commit())
    assert [r["name"] for r in out["removed"]] == ["2026-07-17", "2026-07-18"] and out["moved_back"] == 0

    async def check():
        assert (await db.execute(select(Project.id).where(Project.name == "2026-07-17"))).scalar_one_or_none() is None
        old = await db.get(Project, p.id)
        assert old.description == "老的"
        assert len((await db.execute(select(Task).where(Task.project_id == p.id))).scalars().all()) == 4

    run(check())


def test_unsplit_moves_back_first_version(db, run):
    """第一版拆分是把任务搬走的：撤销要把它们搬回来、label_id 对回原标签。"""
    u, p, parent, child, tasks = _seed(db, run)

    async def simulate_old_split():
        new = Project(name="2026-07-18", description=f"从「{p.name}」按日期拆出（2026-07-18）", created_by=u.id)
        db.add(new)
        await db.flush()
        mapping = await pss.clone_labels(db, p.id, new.id, u.id)
        t = tasks[2]
        t.project_id = new.id
        for it in await _items_of_project(db, new.id):
            it.label_id = mapping[it.label_id]
        p.is_active = False
        p.description = "老的\n已按日期拆成 1 个项目：2026-07-18"
        await db.commit()

    run(simulate_old_split())
    out = run(pss.unsplit(db, p.id))
    run(db.commit())
    assert out["moved_back"] == 1

    async def check():
        old = await db.get(Project, p.id)
        assert old.is_active is True and old.description == "老的"
        assert len((await db.execute(select(Task).where(Task.project_id == p.id))).scalars().all()) == 4
        assert all(it.label_id == child.id for it in await _items_of_project(db, p.id))

    run(check())
