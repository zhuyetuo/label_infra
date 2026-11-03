"""提交之后标注员自己继续编辑：回到标注中、轮次不变、片段原样；不在名下的不行。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.v1 import tasks as tasks_api
from app.models.task import TaskStatus

from tests.test_segment_review import _world


def test_提交后继续编辑(db, run):
    w = _world(db, run)          # 任务已提交，指派给 ann
    w.t.assigned_to = w.ann.id
    run(db.commit())
    round0 = w.t.round_no
    r = run(tasks_api.edit_again_api(w.t.id, db, w.ann))
    assert r["data"]["status"] == "IN_PROGRESS"
    assert w.t.locked_by == w.ann.id and w.t.round_no == round0
    # 已经在标注中：不能再「继续编辑」
    with pytest.raises(HTTPException):
        run(tasks_api.edit_again_api(w.t.id, db, w.ann))


def test_不在名下不能继续编辑_管理员可以(db, run):
    w = _world(db, run)
    w.t.assigned_to = w.ann.id
    w.t.status = TaskStatus.APPROVED
    run(db.commit())
    with pytest.raises(HTTPException):
        run(tasks_api.edit_again_api(w.t.id, db, w.rev))      # 审核员也不行（不在名下）
    r = run(tasks_api.edit_again_api(w.t.id, db, w.admin))
    assert r["data"]["status"] == "IN_PROGRESS" and w.t.locked_by == w.admin.id
