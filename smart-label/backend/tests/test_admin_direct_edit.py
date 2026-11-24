"""管理员不用认领直接改：没通过的任务都能存草稿，已通过的要先「继续编辑」；别人还是要认领。
测试集打分：正确答案只取指定的任务（同一个样本在别的项目里的标注不算）。"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.task import Task, TaskStatus
from app.services import task_service
from app.services.model_eval_service import _human_by_sample

from tests.test_segment_review import _world


def test_管理员免认领直接存(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    for st in (TaskStatus.PENDING_ASSIGN, TaskStatus.SUBMITTED, TaskStatus.REJECTED):
        t.status, t.locked_by = st, None
        run(db.commit())
        run(task_service.save_draft(db, t.id, w.admin, []))          # 不抛就是放行了
        with pytest.raises(task_service.TaskConflictError):
            run(task_service.save_draft(db, t.id, w.ann, []))        # 标注员照旧要认领
    t.status = TaskStatus.APPROVED
    run(db.commit())
    with pytest.raises(task_service.TaskConflictError, match="继续编辑"):
        run(task_service.save_draft(db, t.id, w.admin, []))


def test_打分正确答案只取指定任务(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    t.status = TaskStatus.APPROVED
    run(db.commit())
    truths, _ = run(_human_by_sample(db, [t.sample_id], ["抓挠"]))
    assert truths.get(t.sample_id)
    truths, _ = run(_human_by_sample(db, [t.sample_id], ["抓挠"], [t.id]))
    assert truths.get(t.sample_id)
    truths, _ = run(_human_by_sample(db, [t.sample_id], ["抓挠"], [t.id + 999]))
    assert not truths.get(t.sample_id)


def test_管理员免认领_心跳不报错(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    t.status, t.locked_by = TaskStatus.PENDING_ASSIGN, None
    run(db.commit())
    run(task_service.heartbeat(db, t.id, w.admin))                    # 不抛
    with pytest.raises(task_service.TaskConflictError):
        run(task_service.heartbeat(db, t.id, w.ann))                  # 标注员没认领照旧报错
    t.status = TaskStatus.APPROVED
    run(db.commit())
    with pytest.raises(task_service.TaskConflictError):
        run(task_service.heartbeat(db, t.id, w.admin))
