"""互斥轨：同轨互斥、跨轨可叠、父子可叠；提交校验只拦真矛盾；没分轨的老项目行为不变。"""

from __future__ import annotations

from app.models.label import LabelDefinition
from app.schemas.task import LabelItemIn
from app.services import label_tracks
from app.services.annotation_validation import find_first_overlap


def _lab(i, parent=None, track=None):
    return LabelDefinition(id=i, project_id=1, code=f"c{i}", display_name=f"n{i}", parent_id=parent, track=track, created_by=1)


def test_轨的判定_子沿用上级_没填算一轨():
    labels = [_lab(1, track="behavior"), _lab(2, parent=1), _lab(3, parent=2),
              _lab(4, track="posture"), _lab(5), _lab(6), _lab(7, track="")]
    conflicts = label_tracks.conflict_checker(labels)
    assert not conflicts(1, 3) and not conflicts(3, 1)          # 父子
    assert not conflicts(3, 4)                                  # 行为 vs 姿态
    assert conflicts(5, 6) and conflicts(5, 7)                  # 都没分轨：互斥（老行为）
    assert not conflicts(5, 1)                                  # 没分轨 vs 行为轨：不同轨
    parent_of = {l.id: l.parent_id for l in labels}
    own = {l.id: l.track for l in labels}
    assert label_tracks.track_of(parent_of, own, 3) == "behavior"
    assert label_tracks.track_of(parent_of, own, 7) == ""
    assert label_tracks.normalize(" motion ") == "motion" and label_tracks.normalize("xx") is None


def test_提交校验_只拦同轨不同类():
    labels = [_lab(1, track="behavior"), _lab(2, parent=1), _lab(3, track="posture"), _lab(4, track="behavior")]
    conflicts = label_tracks.conflict_checker(labels)
    items = [LabelItemIn(label_id=3, start_time_ms=0, end_time_ms=20000),        # 卧 全程
             LabelItemIn(label_id=1, start_time_ms=5000, end_time_ms=8000),      # 舔
             LabelItemIn(label_id=2, start_time_ms=6000, end_time_ms=7000)]      # 舔-前左爪
    assert find_first_overlap(items, conflicts) is None
    assert find_first_overlap(items) is not None                                 # 不带轨：跟以前一样全拦
    items.append(LabelItemIn(label_id=4, start_time_ms=7500, end_time_ms=9000))  # 同轨另一类压上来
    hit = find_first_overlap(items, conflicts)
    assert hit is not None and {hit[0].label_id, hit[1].label_id} == {1, 4}
    # 非法区间照拦
    assert find_first_overlap([LabelItemIn(label_id=1, start_time_ms=5, end_time_ms=5)], conflicts) is not None
