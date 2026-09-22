"""导出训练集：层级标签一段带整条链、父子重叠不算矛盾、粗标签被细标签盖住的部分不导两遍。"""

from __future__ import annotations

from datetime import date, datetime

from app.models.annotation import AnnotationLabelItem, AnnotationRecord, LabelItemSource, RecordSourceType
from app.models.label import LabelDefinition
from app.models.project import Project
from app.models.sample import Sample
from app.models.task import Task, TaskStatus, TaskType
from app.models.user import User, UserRole
from app.services import training_export_service as svc


def test_导出带整条链_父子不冲突_粗段挖掉细段(db, run, tmp_path, monkeypatch):
    u = User(username="a", password_hash="x", display_name="a", role=UserRole.admin)
    db.add(u)
    run(db.flush())
    p = Project(name="p", created_by=u.id)
    db.add(p)
    run(db.flush())
    lick = LabelDefinition(project_id=p.id, code="lick", display_name="舔", created_by=u.id)
    act = LabelDefinition(project_id=p.id, code="act", display_name="活动", created_by=u.id)
    db.add(lick)
    db.add(act)
    run(db.flush())
    fore = LabelDefinition(project_id=p.id, code="fore", display_name="舔-前爪", parent_id=lick.id, created_by=u.id)
    db.add(fore)
    run(db.flush())
    fl = LabelDefinition(project_id=p.id, code="fl", display_name="舔-前左爪", parent_id=fore.id, created_by=u.id)
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
    # 舔 0-10s；里面 2-5s 标了舔-前左爪；活动 8-12s 跟舔重叠（真矛盾）
    for lab, a, b in ((lick, 0, 10000), (fl, 2000, 5000), (act, 8000, 12000)):
        db.add(AnnotationLabelItem(annotation_record_id=rec.id, label_id=lab.id, start_time_ms=a, end_time_ms=b,
                                   source_type=LabelItemSource.human_added))
    run(db.commit())

    async def csv_start(_sample):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_of", csv_start)
    monkeypatch.setattr(svc, "_read_ai_json", lambda _rel: None)
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    out = run(svc.export_dataset(db, "h1", project_ids=[p.id]))
    assert out["n_label_conflicts"] == 1                      # 只有活动 vs 舔 那一处，父子不算
    import json, os
    tasks = json.load(open(os.path.join(str(tmp_path), svc.TRAIN_DIR, "h1", "merged_tmp.json"), encoding="utf-8"))
    res = [(r["value"]["timeserieslabels"], r["value"]["start_ms"], r["value"]["end_ms"])
           for r in tasks[0]["annotations"][0]["result"]]
    res.sort(key=lambda x: (x[1], len(x[0])))
    # 舔 被 前左爪(2-5s) 和矛盾(8-10s) 挖掉 → 0-2, 5-8；前左爪带整条链；活动剩 10-12
    assert res == [
        (["舔"], 0, 2000),
        (["舔", "舔-前爪", "舔-前左爪"], 2000, 5000),
        (["舔"], 5000, 8000),
        (["活动"], 10000, 12000),
    ]
    # 类别统计按 labels[0]（大类）算：训练那边也是读 labels[0]，粗细一致
    st = svc.label_stats(["h1"])
    by = {r["label"]: r["n_segments"] for r in st["rows"]}
    assert by["舔"] == 3 and by["活动"] == 1 and "舔-前左爪" not in by


def test_明细行带整条链_不是只给根(tmp_path, monkeypatch):
    """导出文件里 timeserieslabels 一直是整条链（[抓挠, 抓挠-躯干]），
    但明细接口只回了 labels[0]，于是界面上每行都写「抓挠」，跟上面按类别
    统计出来的「抓挠-躯干 15」对不上——人会以为二级标签没导进去。
    """
    import json

    from app.services import training_export_service as svc

    d = tmp_path / svc.TRAIN_DIR / "ds_x"
    d.mkdir(parents=True)
    (d / "merged_tmp.json").write_text(json.dumps([{
        "id": 1,
        "data": {"sample_code": "s1"},
        "annotations": [{"result": [{
            "from_name": "label", "to_name": "ts", "type": "timeserieslabels",
            "value": {"start": "2026-09-20 19:02:25.602", "end": "2026-09-20 19:02:37.810",
                      "timeserieslabels": ["抓挠", "抓挠-躯干"], "start_ms": 0, "end_ms": 12208},
        }]}],
    }]), encoding="utf-8")
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))

    r = svc.read_segments("ds_x")
    row = r["rows"][0]
    assert row["label"] == "抓挠"                       # 老字段含义不变
    assert row["labels"] == ["抓挠", "抓挠-躯干"]        # 整条链也给出来
