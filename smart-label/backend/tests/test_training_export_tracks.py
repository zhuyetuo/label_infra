"""导出训练集 × 互斥轨：跨轨重叠不算矛盾、按优先级折叠成一个时刻一个标签、段上带同时在标什么、
设备轨单独放 aux；不折叠时各轨原样导。"""

from __future__ import annotations

import json
import os
from datetime import date, datetime

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import training_export_service as svc


def _setup(db, run):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    lie = LabelDefinition(project_id=p.id, code="POST_LIE", display_name="卧", track="posture", created_by=u.id)
    rest = LabelDefinition(project_id=p.id, code="ACT_REST", display_name="静止/休息", track="motion", created_by=u.id)
    lick = LabelDefinition(project_id=p.id, code="lick_body", display_name="舔", track="behavior", created_by=u.id)
    collar = LabelDefinition(project_id=p.id, code="LOOSE_COLLAR", display_name="颈圈松动", track="device", created_by=u.id)
    for l in (lie, rest, lick, collar):
        db.add(l)
    run(db.flush())
    fl = LabelDefinition(project_id=p.id, code="lick_body_fore_l", display_name="舔-前左爪", parent_id=lick.id, created_by=u.id)
    db.add(fl)
    s = Sample(sample_code="s1", video_cam1_path="v.mp4", imu_csv_path="d/s1.csv", session_date=date(2026, 9, 1), created_by=u.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.APPROVED, created_by=u.id)
    db.add(t)
    run(db.flush())
    rec = AnnotationRecord(task_id=t.id, round_no=t.round_no, source_type=RecordSourceType.human_only)
    db.add(rec)
    run(db.flush())
    # 卧 0-20s、静止 0-20s、舔 5-8s（6-7 舔前左爪）、颈圈松动 10-20s
    for lab, a, b in ((lie, 0, 20000), (rest, 0, 20000), (lick, 5000, 8000), (fl, 6000, 7000), (collar, 10000, 20000)):
        db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id, start_time_ms=a, end_time_ms=b,
                                   source_type=LabelItemSource.human_added))
    run(db.commit())
    return p


def _patch(monkeypatch, tmp_path):
    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_of", csv_start)
    monkeypatch.setattr(svc, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))


def _load(tmp_path, name):
    return json.load(open(os.path.join(str(tmp_path), svc.TRAIN_DIR, name, "merged_tmp.json"), encoding="utf-8"))


def test_折叠_行为盖运动盖姿态_带同时在标什么_设备轨单独(db, run, tmp_path, monkeypatch):
    p = _setup(db, run)
    _patch(monkeypatch, tmp_path)
    out = run(svc.export_dataset(db, "t1", project_ids=[p.id]))
    assert out["n_label_conflicts"] == 0 and out["flatten"] and out["track_priority"] == ["behavior", "motion", "posture"]
    assert out["flattened_sec"] == 23.0          # 静止让出 3s、卧让出 20s
    assert out["n_device_segments"] == 1 and out["tracks"] == {"behavior": 3, "motion": 2}
    ann = _load(tmp_path, "t1")[0]["annotations"][0]
    res = sorted(((r["value"]["timeserieslabels"], r["value"]["start_ms"], r["value"]["end_ms"],
                   r["value"].get("track"), r["value"].get("tracks")) for r in ann["result"]), key=lambda x: (x[1], len(x[0])))
    assert res == [
        (["静止/休息"], 0, 5000, "motion", {"posture": "卧"}),
        (["舔"], 5000, 6000, "behavior", {"posture": "卧", "motion": "静止/休息"}),
        (["舔", "舔-前左爪"], 6000, 7000, "behavior", {"posture": "卧", "motion": "静止/休息"}),
        (["舔"], 7000, 8000, "behavior", {"posture": "卧", "motion": "静止/休息"}),
        (["静止/休息"], 8000, 20000, "motion", {"posture": "卧"}),
    ]
    dev = ann["aux"]["device"]
    assert len(dev) == 1 and dev[0]["value"]["timeserieslabels"] == ["颈圈松动"] and dev[0]["value"]["start_ms"] == 10000
    # 核对表 / 统计只看 result，设备轨不混进 22 类
    assert "颈圈松动" not in svc.label_stats(["t1"])["rows"].__repr__()
    assert svc.read_segments("t1")["total"] == 5


def test_不折叠_各轨原样_优先级可调(db, run, tmp_path, monkeypatch):
    p = _setup(db, run)
    _patch(monkeypatch, tmp_path)
    out = run(svc.export_dataset(db, "t2", project_ids=[p.id], flatten=False))
    assert out["flattened_sec"] == 0 and out["tracks"] == {"posture": 1, "motion": 1, "behavior": 3}
    res = _load(tmp_path, "t2")[0]["annotations"][0]["result"]
    got = sorted(((r["value"]["start_ms"], r["value"]["end_ms"], r["value"]["timeserieslabels"][0]) for r in res),
                 key=lambda x: (x[0], x[1], x[2]))
    assert got == sorted([(0, 20000, "卧"), (0, 20000, "静止/休息"), (5000, 6000, "舔"), (6000, 7000, "舔"), (7000, 8000, "舔")],
                         key=lambda x: (x[0], x[1], x[2]))
    # 姿态优先：卧 全程赢，静止和舔都没了
    out3 = run(svc.export_dataset(db, "t3", project_ids=[p.id], track_priority=["posture", "device", "bogus"]))
    assert out3["track_priority"] == ["posture", "behavior", "motion"]
    res3 = _load(tmp_path, "t3")[0]["annotations"][0]["result"]
    assert [(r["value"]["timeserieslabels"][0], r["value"]["start_ms"], r["value"]["end_ms"]) for r in res3] == [("卧", 0, 20000)]
    assert res3[0]["value"]["tracks"] == {"motion": "静止/休息", "behavior": "舔"}
