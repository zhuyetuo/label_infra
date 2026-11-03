"""同一轨上重叠的片段：同类重复 / 父子 / 同轨不同类都算；不同轨、相差不到 200ms 的不算。"""

from types import SimpleNamespace as L

from app.api.v1 import tasks as tasks_api  # noqa: F401  建表要先把模型都导进来
from app.models.annotation import AnnotationLabelItem, LabelItemSource
from app.services.label_tracks import overlapping_ids
from tests.test_segment_review import _world

LABELS = [
    L(id=1, parent_id=None, track="behavior"),   # 抓挠
    L(id=2, parent_id=1, track=None),            # 抓挠-头颈耳（继承行为轨）
    L(id=3, parent_id=None, track="behavior"),   # 舔
    L(id=4, parent_id=None, track="posture"),    # 卧
]


def test_overlap_rules():
    items = [
        (10, 2, 0, 10_000),        # 抓挠-头颈耳
        (11, 2, 100, 9_900),       # 同类重复
        (12, 4, 0, 10_000),        # 卧：不同轨，不算
        (13, 3, 9_950, 15_000),    # 舔：跟 10 只压了 50ms，不算；跟 11 不重叠
        (14, 1, 20_000, 30_000),   # 抓挠
        (15, 2, 25_000, 26_000),   # 父子重叠
        (16, 3, 29_000, 31_000),   # 同轨不同类：冲突
    ]
    assert overlapping_ids(items, LABELS) == {10, 11, 14, 15, 16}


def test_列表接口给重叠数(db, run):
    from sqlalchemy import select as _select

    w = _world(db, run)
    a = w.items[0]
    # 同一类别再标一遍、压住 a 的大半：1 处
    db.add(AnnotationLabelItem(annotation_record_id=w.rec.id, label_id=a.label_id, start_time_ms=a.start_time_ms + 500,
                               end_time_ms=a.end_time_ms + 500, source_type=LabelItemSource.human_added))
    run(db.commit())
    rows = run(tasks_api.list_tasks(project_id=w.p.id, db=db, user=w.admin))["data"]
    got = {r["id"]: r for r in rows}
    # 卷进重叠的片段数：a 和新加的那条，共 2 段，都是 a 的类别
    assert got[w.t.id]["overlap_count"] == 2
    assert got[w.t.id]["overlap_by_label"] == {a.label_id: 2}
    # 只刷一行：ids 给了就只回这几个，统计照样带
    one = run(tasks_api.list_tasks(project_id=None, ids=str(w.t.id), db=db, user=w.admin))["data"]
    assert [r["id"] for r in one] == [w.t.id] and one[0]["overlap_count"] == 2
    assert len(run(db.execute(_select(AnnotationLabelItem))).scalars().all()) >= 6
