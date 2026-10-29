"""片段起止每改一次都记一笔：从多少改到多少、谁改的。"""

from __future__ import annotations

from app.schemas.task import LabelItemOut
from app.services import task_service
from tests.test_dup_segments import _incoming, _items, _world


def test_起止改了几次就记几笔_类别改了不记(db, run):
    u, _p, lab, t = _world(db, run)
    rec = run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1000, 5000)]))
    it = _items(db, run, rec.id)[0]
    assert it.boundary_edits is None                       # 新建不算调整

    run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1200, 5000, origin=it.id)]))
    run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1200, 4800, origin=it.id)]))
    run(task_service.save_draft(db, t.id, u, [_incoming(lab.id, 1200, 4800, origin=it.id)]))  # 没变：不记
    it = _items(db, run, rec.id)[0]
    out = LabelItemOut.model_validate(it)
    assert [(e["from"], e["to"]) for e in out.boundary_edits] == [([1000, 5000], [1200, 5000]),
                                                                  ([1200, 5000], [1200, 4800])]
    assert out.boundary_edits[0]["by"] == u.id and out.boundary_edits[0]["by_name"] == "a"


def test_只留最近30笔但保住第一笔():
    import json
    from types import SimpleNamespace

    u = SimpleNamespace(id=1, display_name="x", username="x")
    raw = None
    for i in range(40):
        raw = task_service._append_boundary_edit(raw, (i, i + 10), (i + 1, i + 11), u)
    edits = json.loads(raw)
    assert len(edits) == 30 and edits[0]["from"] == [0, 10] and edits[-1]["to"] == [40, 50]
