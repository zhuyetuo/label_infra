"""模型对比只在「人工审过 + 所有版本都跑过」的样本上计分。

以前没审过的样本也算进来，模型在上面标的每一段都成了误报；某个版本没跑的
样本也算进来，那里的人工片段全成了它的漏检——报告上的差距是"跑没跑"，
不是"模型好不好"。
"""

from __future__ import annotations

from app.models.annotation import (
    AnnotationLabelItem,
    AnnotationRecord,
    LabelItemSource,
    RecordSourceType,
)
from app.models.inference_run import SampleInferenceRun
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import model_eval_service as svc
from app.services.model_eval_service import Seg


def _world(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    lab = LabelDefinition(project_id=p.id, code="scratch", display_name="抓挠", created_by=u.id)
    db.add(lab)
    run(db.flush())
    out = []
    for code, st in [("done", TaskStatus.APPROVED), ("draft", TaskStatus.IN_PROGRESS), ("norun", TaskStatus.SUBMITTED)]:
        s = Sample(sample_code=code, video_cam1_path="v.mp4", imu_csv_path="a.csv", created_by=u.id)
        db.add(s)
        run(db.flush())
        t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=st, created_by=u.id)
        db.add(t)
        run(db.flush())
        rec = AnnotationRecord(task_id=t.id, round_no=t.round_no or 1, source_type=RecordSourceType.human_only)
        db.add(rec)
        run(db.flush())
        db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id, start_time_ms=0,
                                   end_time_ms=1000, source_type=LabelItemSource.human_added))
        out.append(s)
    for s in out[:2]:  # 第三个样本两个版本都没跑；第二个只跑了 B
        for tag in (["A", "B"] if s is out[0] else ["B"]):
            db.add(SampleInferenceRun(sample_id=s.id, model_tag=tag, mode="viterbi", json_path="x.json"))
    run(db.commit())
    return out


def _fake_preds(monkeypatch):
    async def fake(samples, runs, names):
        return {s.id: [Seg(0, 1000, 0.9)] for s in samples if s.id in runs}, {}, []

    monkeypatch.setattr(svc, "_run_segments", fake)


def test_只在审过且都跑过的样本上比(db, run, monkeypatch):
    done, draft, norun = _world(db, run)
    _fake_preds(monkeypatch)
    r = run(svc.evaluate(db, [done.id, draft.id, norun.id],
                         [{"model_tag": "A", "mode": "viterbi"}, {"model_tag": "B", "mode": "viterbi"}]))
    assert r["n_samples"] == 1  # draft 没审过，norun 两个版本都没跑
    assert [(v["tp"], v["fp"], v["fn"]) for v in r["versions"]] == [(1, 0, 0), (1, 0, 0)]
    assert any("没人工审过" in w for w in r["warnings"])


def test_没有共同跑过的样本时返回完整结构(db, run, monkeypatch):
    *_, norun = _world(db, run)
    _fake_preds(monkeypatch)
    r = run(svc.evaluate(db, [norun.id], [{"model_tag": "A", "mode": "viterbi"}]))
    assert r["versions"] == [] and r["diffs"] == [] and r["n_samples"] == 1
    assert r["warnings"]
