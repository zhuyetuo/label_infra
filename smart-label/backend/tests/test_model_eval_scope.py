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


def test_类别别名与子类别合并及运行类别提取(db, run, tmp_path, monkeypatch):
    import json
    from datetime import datetime
    done, *_ = _world(db, run)
    # 新增「静止/休息」及「抓挠」子类别，并写入一段「静止/休息」人工标注
    p_id = run(db.get(Task, 1)).project_id
    u_id = done.created_by
    rest_lab = LabelDefinition(project_id=p_id, code="rest", display_name="静止/休息", created_by=u_id)
    scratch_parent = run(db.execute(
        svc.select(LabelDefinition).where(LabelDefinition.display_name == "抓挠")
    )).scalar_one()
    sub1 = LabelDefinition(project_id=p_id, code="s_head", display_name="抓挠-头颈耳", parent_id=scratch_parent.id, created_by=u_id)
    sub2 = LabelDefinition(project_id=p_id, code="s_body", display_name="抓挠-躯干", parent_id=scratch_parent.id, created_by=u_id)
    for x in (rest_lab, sub1, sub2):
        db.add(x)
    run(db.flush())
    rec = run(db.execute(svc.select(AnnotationRecord).where(AnnotationRecord.task_id == 1))).scalar_one()
    db.add(AnnotationLabelItem(
        annotation_record_id=rec.id, label_id=rest_lab.id,
        start_time_ms=2000, end_time_ms=5000, source_type=LabelItemSource.human_added,
    ))
    run(db.commit())

    # 模拟老模型输出「睡觉」和拆开的「抓挠-头颈耳」+「抓挠-躯干」紧贴段
    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    svc._JSON_CACHE.clear()
    (tmp_path / "x.json").write_text(json.dumps({
        "segments": {
            "抓挠-头颈耳": [{"start_ts": "2026-09-01T00:00:00.000", "end_ts": "2026-09-01T00:00:00.500", "conf_mean": 0.8}],
            "抓挠-躯干": [{"start_ts": "2026-09-01T00:00:00.500", "end_ts": "2026-09-01T00:00:01.000", "conf_mean": 0.9}],
            "睡觉": [{"start_ts": "2026-09-01T00:00:02.000", "end_ts": "2026-09-01T00:00:05.000", "conf_mean": 0.95}],
            "甩身体": [],
        },
        "missing": [],
    }), encoding="utf-8")

    async def fake_csv_start(_s, _sem):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_cached", fake_csv_start)

    runs = run(svc.list_runs(db, [done.id]))
    a_run = next(x for x in runs if x["model_tag"] == "A")
    # 「睡觉」「甩身体」自动按模板别名归一为「静止/休息」「甩头/抖身」
    assert "静止/休息" in a_run["classes"] and "甩头/抖身" in a_run["classes"]

    # 评测「静止/休息」时能匹配模型输出的「睡觉」
    r_rest = run(svc.evaluate(db, [done.id], [{"model_tag": "A", "mode": "viterbi"}], label="静止/休息"))
    assert r_rest["versions"][0]["tp"] == 1 and r_rest["versions"][0]["fn"] == 0

    # 评测父类别「抓挠」时，两段紧贴的不同细类预测合并成 1 段 [0, 1000] 精准命中人工 [0, 1000]
    r_scr = run(svc.evaluate(db, [done.id], [{"model_tag": "A", "mode": "viterbi"}], label="抓挠"))
    assert r_scr["versions"][0]["tp"] == 1 and r_scr["versions"][0]["fp"] == 0 and r_scr["versions"][0]["mean_iou"] == 1.0


def test_测试集只返回明确跑过并登记的模型(db, run):
    from app.api.v1 import model_eval as eval_api
    from app.models.model_test import ModelTestItem, ModelTestSet
    done, *_ = _world(db, run)
    t = run(db.get(Task, 1))
    ts = ModelTestSet(name="严格测试集", created_by=done.created_by)
    db.add(ts)
    run(db.flush())
    db.add(ModelTestItem(set_id=ts.id, task_id=t.id, sample_id=done.id, start_ms=0, end_ms=1000, added_by=done.created_by))
    run(db.commit())

    # 虽然样本上有历史预标注 A / B，但本测试集未主动跑过任何模型时，返回空列表
    r0 = run(eval_api.available_runs(test_set_id=ts.id, db=db))["data"]
    assert r0["n_scope"] == 1 and r0["runs"] == []

    # 登记只跑了 A::viterbi 后，严格只出现 A::viterbi，不出现 B::viterbi
    run(svc.record_test_set_runs(db, ts.id, ["A::viterbi"], user_id=done.created_by))
    r1 = run(eval_api.available_runs(test_set_id=ts.id, db=db))["data"]
    assert [f"{x['model_tag']}::{x['mode']}" for x in r1["runs"]] == ["A::viterbi"]

    # 移除记录后再次为空
    run(eval_api.delete_test_set_run(ts.id, version_key="A::viterbi", db=db))
    r2 = run(eval_api.available_runs(test_set_id=ts.id, db=db))["data"]
    assert r2["runs"] == []


def test_窗口级误报漏报自动归因(db, run, tmp_path, monkeypatch):
    import json
    from datetime import datetime

    done, *_ = _world(db, run)
    t = run(db.get(Task, 1))
    rec = run(db.execute(svc.select(AnnotationRecord).where(AnnotationRecord.task_id == t.id))).scalar_one()
    scratch_lab = run(db.execute(
        svc.select(LabelDefinition).where(LabelDefinition.display_name == "抓挠")
    )).scalar_one()
    act_lab = LabelDefinition(project_id=t.project_id, code="act", display_name="活动", created_by=done.created_by)
    shake_lab = LabelDefinition(project_id=t.project_id, code="shake", display_name="甩头/抖身", created_by=done.created_by)
    for x in (act_lab, shake_lab):
        db.add(x)
    run(db.flush())

    # 6 个测试窗口（各 10s）：
    # W1 [0, 10000): 人工有抓挠 [0, 1000]（来自 _world），窗口级概率高但被后处理拦掉 -> FN post_filter
    # W2 [10000, 20000): 人工有抓挠 [12000, 15000]，窗口级概率偏低(0.45) -> FN low_conf
    # W3 [20000, 30000): 人工有抓挠 [22000, 25000]，窗口级识成「甩头/抖身」 -> FN misclass
    # W4 [30000, 40000): 人工只标「活动」，模型高置信持续 7s 报抓挠 -> FP suspect_human_miss
    # W5 [40000, 50000): 人工标「甩头/抖身」，模型报抓挠重叠 -> FP confuse_similar
    # W6 [50000, 60000): 人工无动作，模型低置信短段(0.58, 2s) -> FP low_conf_fp
    for lab, s_ms, e_ms in [
        (scratch_lab, 12000, 15000),
        (scratch_lab, 22000, 25000),
        (act_lab, 30000, 40000),
        (shake_lab, 42000, 46000),
    ]:
        db.add(AnnotationLabelItem(
            annotation_record_id=rec.id, label_id=lab.id,
            start_time_ms=s_ms, end_time_ms=e_ms, source_type=LabelItemSource.human_added,
        ))
    run(db.commit())

    monkeypatch.setattr(svc.settings, "nas_root", str(tmp_path))
    svc._JSON_CACHE.clear()
    (tmp_path / "x.json").write_text(json.dumps({
        "segments": {
            "抓挠": [
                {"start_ts": "2026-09-01T00:00:31.000", "end_ts": "2026-09-01T00:00:38.000", "conf_mean": 0.90},
                {"start_ts": "2026-09-01T00:00:42.000", "end_ts": "2026-09-01T00:00:46.000", "conf_mean": 0.85},
                {"start_ts": "2026-09-01T00:00:52.000", "end_ts": "2026-09-01T00:00:54.000", "conf_mean": 0.58},
            ],
        },
        "windows": [
            {"start_ts": "2026-09-01T00:00:00.000", "end_ts": "2026-09-01T00:00:01.000", "label": "抓挠", "probs": {"抓挠": 0.92, "活动": 0.08}},
            {"start_ts": "2026-09-01T00:00:00.500", "end_ts": "2026-09-01T00:00:01.500", "label": "抓挠", "probs": {"抓挠": 0.88, "活动": 0.12}},
            {"start_ts": "2026-09-01T00:00:12.000", "end_ts": "2026-09-01T00:00:15.000", "label": "抓挠", "probs": {"抓挠": 0.45, "活动": 0.55}},
            {"start_ts": "2026-09-01T00:00:22.000", "end_ts": "2026-09-01T00:00:25.000", "label": "甩头/抖身", "probs": {"抓挠": 0.08, "甩头/抖身": 0.88}},
        ],
        "missing": [],
    }), encoding="utf-8")

    async def fake_csv_start(_s, _sem):
        return datetime(2026, 9, 1, 0, 0, 0)

    monkeypatch.setattr(svc, "_csv_start_cached", fake_csv_start)

    windows = {done.id: [(i * 10000, (i + 1) * 10000) for i in range(6)]}
    res = run(svc.evaluate(db, [done.id], [{"model_tag": "A", "mode": "viterbi"}], label="抓挠", windows=windows))
    by_start = {d["start_ms"]: d for d in res["versions"][0]["window_details"]}

    assert by_start[0]["verdict"] == "fn" and by_start[0]["diag"]["code"] == "post_filter"
    assert by_start[10000]["verdict"] == "fn" and by_start[10000]["diag"]["code"] == "low_conf"
    assert by_start[20000]["verdict"] == "fn" and by_start[20000]["diag"]["code"] == "misclass"
    assert "甩头/抖身" in by_start[20000]["diag"]["detail"]
    assert by_start[30000]["verdict"] == "fp" and by_start[30000]["diag"]["code"] == "suspect_human_miss"
    assert by_start[40000]["verdict"] == "fp" and by_start[40000]["diag"]["code"] == "confuse_similar"
    assert "甩头/抖身" in by_start[40000]["diag"]["detail"]
    assert by_start[50000]["verdict"] == "fp" and by_start[50000]["diag"]["code"] == "low_conf_fp"
