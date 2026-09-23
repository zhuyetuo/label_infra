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


# ── 未佩戴：跟颈圈松动同在设备轨，但完全是两回事 ──────────────────────────
#
# 颈圈松动  项圈还在狗身上，只是松了 → 跟什么行为都能同时发生，进 aux，训练不读
# 未佩戴    项圈根本不在狗身上，IMU 测的是桌子 → 它**是**训练的一个类别
#           （configs/remap_custom_3class.yaml 写着"作为独立类别参与训练"），
#           而且那段时间里任何"行为"都不成立
#
# 以前两个一起丢进 aux。实测 2026-09-23：项目 195 有 411 段未佩戴、233 个任务，
# 一段都到不了训练，而模型那边偏偏有这么个类别要喂。


def _setup_not_worn(db, run):
    """一段「未佩戴」压着「活动」和「卧」：项圈都不在狗身上，那还谈什么活动。"""
    u = User(username="b", password_hash="x", display_name="b", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p2", created_by=u.id)
    db.add(p)
    run(db.flush())
    act = LabelDefinition(project_id=p.id, code="ACT_ACTIVITY", display_name="活动", track="motion", created_by=u.id)
    lie = LabelDefinition(project_id=p.id, code="POST_LIE", display_name="卧", track="posture", created_by=u.id)
    nw = LabelDefinition(project_id=p.id, code="NOT_WORN", display_name="未佩戴", track="device", created_by=u.id)
    collar = LabelDefinition(project_id=p.id, code="LOOSE_COLLAR", display_name="颈圈松动", track="device", created_by=u.id)
    for l in (act, lie, nw, collar):
        db.add(l)
    run(db.flush())
    s = Sample(sample_code="s2", video_cam1_path="v.mp4", imu_csv_path="d/s2.csv",
               session_date=date(2026, 9, 1), created_by=u.id)
    db.add(s)
    run(db.flush())
    t = Task(project_id=p.id, sample_id=s.id, task_type=TaskType.ai_assisted, status=TaskStatus.APPROVED, created_by=u.id)
    db.add(t)
    run(db.flush())
    rec = AnnotationRecord(task_id=t.id, round_no=t.round_no, source_type=RecordSourceType.human_only)
    db.add(rec)
    run(db.flush())
    # 活动 0-20s、卧 0-20s、未佩戴 10-20s、颈圈松动 0-5s
    for lab, a, b in ((act, 0, 20000), (lie, 0, 20000), (nw, 10000, 20000), (collar, 0, 5000)):
        db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id, start_time_ms=a, end_time_ms=b,
                                   source_type=LabelItemSource.human_added))
    run(db.commit())
    return p


def test_未佩戴进训练集_并且压过所有轨(db, run, tmp_path, monkeypatch):
    """项圈不在狗身上时，那段时间任何"行为"都不成立——让活动赢的话，
    等于把一段桌子的数据当成狗在活动喂给模型。"""
    p = _setup_not_worn(db, run)
    _patch(monkeypatch, tmp_path)
    run(svc.export_dataset(db, "nw1", project_ids=[p.id]))
    ann = _load(tmp_path, "nw1")[0]["annotations"][0]
    got = sorted((r["value"]["timeserieslabels"][0], r["value"]["start_ms"], r["value"]["end_ms"])
                 for r in ann["result"])
    # 卧全程让开（活动优先级更高），活动的后半段让给未佩戴
    assert got == [("未佩戴", 10000, 20000), ("活动", 0, 10000)], got


def test_颈圈松动照旧只在aux_不混进类别(db, run, tmp_path, monkeypatch):
    """它俩不能一起处理，但也不能一起放进来——松动时项圈还在狗身上，
    那段时间的行为标注是成立的，不该被它盖掉。"""
    p = _setup_not_worn(db, run)
    _patch(monkeypatch, tmp_path)
    out = run(svc.export_dataset(db, "nw2", project_ids=[p.id]))
    ann = _load(tmp_path, "nw2")[0]["annotations"][0]
    dev = ann["aux"]["device"]
    assert [d["value"]["timeserieslabels"][0] for d in dev] == ["颈圈松动"]
    assert out["n_device_segments"] == 1, "未佩戴不该再算进设备轨那个计数"
    # 0-5s 是颈圈松动，但活动照样导出了——松动不影响行为成立
    spans = [(r["value"]["start_ms"], r["value"]["end_ms"]) for r in ann["result"]
             if r["value"]["timeserieslabels"][0] == "活动"]
    assert spans == [(0, 10000)]


def test_未佩戴按code认不按名字(db, run, tmp_path, monkeypatch):
    """显示名是会改的，改完按名字认就悄无声息地退回旧行为（又被丢进 aux）。"""
    p = _setup_not_worn(db, run)
    nw = run(db.execute(__import__("sqlalchemy").select(LabelDefinition).where(
        LabelDefinition.project_id == p.id, LabelDefinition.code == "NOT_WORN"))).scalar_one()
    nw.display_name = "项圈没戴在狗身上"
    run(db.commit())
    _patch(monkeypatch, tmp_path)
    run(svc.export_dataset(db, "nw3", project_ids=[p.id]))
    ann = _load(tmp_path, "nw3")[0]["annotations"][0]
    assert any(r["value"]["timeserieslabels"][0] == "项圈没戴在狗身上" for r in ann["result"])
