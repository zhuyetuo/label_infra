"""模型测试：凑够 N 秒（前后各延长一半、碰头尾往另一边补）；打分按窗口裁。"""

from __future__ import annotations

from sqlalchemy import select

from app.api.v1 import model_eval as eval_api
from app.api.v1 import model_tests as api
from app.models.task import Task
from app.services import model_test_service as mts
from app.services.model_eval_service import Seg, clip_to_windows

from tests.test_segment_review import _world


def test_凑够时长():
    # 10 秒抓挠凑 60 秒：前后各 25 秒
    assert mts.pad_window(100_000, 110_000, 60_000, 0, 600_000) == (75_000, 135_000)
    # 靠近开头：前面不够，往后补
    assert mts.pad_window(5_000, 15_000, 60_000, 0, 600_000) == (0, 60_000)
    # 靠近结尾：后面不够，往前补
    assert mts.pad_window(590_000, 598_000, 60_000, 0, 600_000) == (540_000, 600_000)
    # 本来就够长：不动；样本比要凑的还短：整个样本
    assert mts.pad_window(0, 90_000, 60_000, 0, 600_000) == (0, 90_000)
    assert mts.pad_window(10_000, 20_000, 60_000, 0, 40_000) == (0, 40_000)
    # 不知道样本多长：只管开头
    assert mts.pad_window(100_000, 110_000, 60_000, 0, None) == (75_000, 135_000)


def test_按窗口裁():
    segs = [Seg(0, 10_000, 0.9), Seg(50_000, 70_000, 0.8), Seg(200_000, 210_000)]
    got = clip_to_windows(segs, [(5_000, 60_000)])
    assert [(s.start_ms, s.end_ms, s.conf) for s in got] == [(5_000, 10_000, 0.9), (50_000, 60_000, 0.8)]
    # 跨两个窗口切成两段；窗口外的不要
    got = clip_to_windows([Seg(0, 100_000)], [(10_000, 20_000), (50_000, 60_000)])
    assert [(s.start_ms, s.end_ms) for s in got] == [(10_000, 20_000), (50_000, 60_000)]
    assert clip_to_windows(segs, []) == []
    assert eval_api._windows_of(None) is None
    assert eval_api._windows_of([eval_api.WindowIn(sample_id=1, start_ms=0, end_ms=5)]) == {1: [(0, 5)]}


def test_加片段时凑时长_从标注片段挑(db, run):
    w = _world(db, run)
    t = run(db.execute(select(Task))).scalars().first()
    segs = run(api.get_task_segments(t.id, db))["data"]
    assert segs and {"top", "label", "start_ms", "end_ms"} <= set(segs[0])
    s = run(api.create_set(api.SetIn(name="v1"), db, w.admin))["data"]
    a, b = segs[0]["start_ms"], segs[0]["end_ms"]
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, start_ms=a, end_ms=b, pad_to_sec=60)]), db, w.admin))
    assert r["data"]["added"] == 1
    it = run(api.get_items(s["id"], db))["data"]["items"][0]
    assert it["end_ms"] - it["start_ms"] == max(60_000, b - a) and it["start_ms"] <= a and it["end_ms"] >= b
    # 没给起止不能凑
    r = run(api.add_items(s["id"], api.ItemsIn(items=[api.ItemIn(task_id=t.id, pad_to_sec=60)]), db, w.admin))
    assert r["data"]["added"] == 0 and "起止" in r["data"]["skipped"][0]["reason"]
